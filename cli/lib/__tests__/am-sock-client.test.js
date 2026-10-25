import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { submit, validateReply, lookupRestartRequest, lookupModeSwitch } from '../am-sock-client.js';

const request = { version: 1, type: 'restart_all', requestId: 'test-1', reason: 'upgrade' };
const reply = { version: 1, type: 'restart_all', requestId: 'test-1', ok: true, result: 'accepted', runCount: 2 };
async function withServer(handler, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-sock-'));
  const socketPath = path.join(root, 'am.sock'); const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); handler(socket); });
  await new Promise(resolve => server.listen(socketPath, resolve));
  try { await fn(socketPath); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
}
// IF-37: first complete reply and branch validation, including unknown extensions.
test('IF-37 validates all five reply branches and mandatory relationships', () => {
  const cases = [
    ['restart_all', { ok: true, result: 'done_empty', runCount: 0 }, true],
    ['restart_all', { ok: true, result: 'done_empty', runCount: 2 }, false],
    ['restart_all', { ok: true, result: 'accepted', runCount: 0 }, false],
    ['restart_all', { ok: true, result: 'unknown', runCount: 1 }, false],
    ['ready_for_config_reclaim', { ok: true, result: 'unchanged' }, true],
    ['ready_for_config_reclaim', { ok: false, result: 'rejected', reason: 'other_fence' }, true],
    ['ready_for_config_reclaim', { ok: false, result: 'rejected', reason: 'bad' }, false],
    ['manual_restart', { ok: false, result: 'stale_target', currentRunId: 'r2' }, true],
    ['manual_restart', { ok: false, result: 'stale_target' }, false],
    ['mode_switch', { ok: false, code: 'transition_open', runId: 't1', target: 'multi' }, true],
    ['mode_switch', { ok: false, code: 'transition_open', target: 'multi' }, false],
    ['mode_switch', { ok: true, result: 'accepted', runId: 't1' }, true],
    ['mode_switch', { ok: true, result: 'noop', futureField: 1 }, true],
    ['start_attempt', { ok: true, result: 'not_restricted' }, true],
    ['start_attempt', { ok: true, result: 'not_restricted', attemptAt: 1 }, false],
    ['start_attempt', { ok: true, result: 'registered', reason: 'recovery_due', attemptAt: 1792000000, attemptCount: 1 }, true],
    ['start_attempt', { ok: true, result: 'registered', reason: 'recovery_due', attemptAt: 1792000000000, attemptCount: 1 }, false],
    ['start_attempt', { ok: false, code: 'probe_inflight', notBefore: 1792000000000 }, false],
    ['start_attempt', { ok: false, code: 'attempt_backoff', notBefore: 1792000000000 }, true],
    ['start_attempt', { ok: false, code: 'attempt_backoff', notBefore: 1792000000 }, false],
  ];
  for (const [type, fields, expected] of cases) assert.equal(validateReply({ ...request, type }, { version: 1, type, requestId: request.requestId, ...fields }), expected, JSON.stringify(fields));
  assert.equal(validateReply(request, { ok: false, code: 'invalid_request' }), true);
  assert.equal(validateReply(request, { ...reply, requestId: 'wrong' }), false);
  assert.equal(validateReply(request, { ...reply, version: 2 }), false);
});
test('IF-37 first line wins; EOF after accepted is not uncertain', async () => {
  await withServer(socket => socket.once('data', () => socket.end(`${JSON.stringify(reply)}\ninvalid\n`)), async socketPath => {
    assert.deepEqual(await submit(request, { socketPath }), { kind: 'accepted', reply, sent: true });
  });
});
test('IF-37 malformed complete reply is invalid_reply, including positive-control bad relationship', async () => {
  for (const body of ['not-json\n', JSON.stringify({ ...reply, result: 'done_empty', runCount: 2 }) + '\n']) {
    await withServer(socket => socket.once('data', () => socket.end(body)), async socketPath => {
      assert.deepEqual(await submit(request, { socketPath }), { kind: 'invalid_reply', sent: true });
    });
  }
});
test('IF-37 half line and connected write failure remain uncertain', async () => {
  await withServer(socket => socket.once('data', () => socket.end('{"ok":')), async socketPath => {
    assert.deepEqual(await submit(request, { socketPath }), { kind: 'no_reply', sent: true });
  });
  const fake = new EventEmitter(); fake.destroy = () => {}; fake.write = (_, cb) => cb(new Error('write failed'));
  const result = submit(request, { connect: () => { queueMicrotask(() => fake.emit('connect')); return fake; } });
  assert.deepEqual(await result, { kind: 'no_reply', sent: true });
});
test('IF-37 unknown socket is unsent; expired budget never connects', async () => {
  assert.deepEqual(await submit(request, { socketPath: path.join(os.tmpdir(), `missing-${process.pid}.sock`) }), { kind: 'connect_failed', sent: false });
  assert.deepEqual(await submit(request, { deadlineAt: Date.now() - 1, connect: () => { throw new Error('must not connect'); } }), { kind: 'deadline_exceeded', sent: false });
});
test('IF-37 total and reply deadlines have distinct classifications', async () => {
  await withServer(() => {}, async socketPath => {
    assert.deepEqual(await submit(request, { socketPath, deadlineAt: Date.now() + 1000, replyMaxMs: 20 }), { kind: 'timeout', sent: true });
    assert.deepEqual(await submit(request, { socketPath, deadlineAt: Date.now() + 20, replyMaxMs: 1000 }), { kind: 'deadline_exceeded', sent: true });
  });
});
test('IF-37 connection retry uses total budget and does not retry entry_not_open', async () => {
  let calls = 0;
  const connect = () => {
    calls++;
    const fake = new EventEmitter(); fake.destroy = () => {};
    fake.write = (_, cb) => { cb(); queueMicrotask(() => fake.emit('data', Buffer.from(JSON.stringify({ ...reply, ok: false, code: 'entry_not_open' }) + '\n'))); };
    queueMicrotask(() => calls < 3 ? fake.emit('error', Object.assign(new Error('not listening'), { code: 'ENOENT' })) : fake.emit('connect'));
    return fake;
  };
  assert.equal((await submit(request, { deadlineAt: Date.now() + 1000, replyMaxMs: 10, connectRetryEveryMs: 20, connect })).kind, 'rejected');
  assert.equal(calls, 3);
});
test('IF-31/IF-65 lookup never resubmits; queries use ordinary locks after budget precheck', async () => {
  let now = 100; let queries = 0;
  const getModeTransition = (...args) => { assert.deepEqual(args, []); queries++; now = 300; return { target_mode: 'multi' }; };
  assert.equal(await lookupModeSwitch('multi', { deadlineAt: 200, now: () => now, getModeTransition }), 'accepted');
  assert.equal(await lookupModeSwitch('multi', { deadlineAt: 200, now: () => now, getModeTransition }), 'deadline_exceeded');
  assert.equal(queries, 1);
  assert.equal(await lookupRestartRequest('a', { deadlineAt: 200, now: () => 100, readRequests: () => [], readCompleted: () => false }), 'unknown');
  assert.equal(await lookupRestartRequest('a', { deadlineAt: 200, now: () => 100, readRequests: () => [{ requestId: 'a' }] }), 'accepted');
  assert.equal(await lookupRestartRequest('a', { deadlineAt: 200, now: () => 100, readRequests: () => [], readCompleted: () => true }), 'done');
});

// IF-37 five request families share the exact transport state machine. These
// fixtures intentionally retain invalid branch values as negative controls.
test('IF-37 five-family matrix: complete, partial, reset, malformed, late and deadline replies', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let clock = 1792000000000;
  const replies = {
    start_attempt: {ok:true,result:'registered',reason:'recovery_due',attemptAt:1792000000,attemptCount:1},
    restart_all: {ok:true,result:'done_empty',runCount:0},
    ready_for_config_reclaim: {ok:true,result:'unchanged'}, manual_restart: {ok:true,result:'already_stopped'}, mode_switch:{ok:true,result:'noop'},
  };
  const rejections = {
    start_attempt:{ok:false,code:'scene_present'}, restart_all:{ok:false,code:'entry_not_open'},
    ready_for_config_reclaim:{ok:false,code:'entry_not_open'}, manual_restart:{ok:false,result:'stale_target',currentRunId:'new'},
    mode_switch:{ok:false,code:'transition_open',runId:'switch',target:'multi'},
  };
  const flush = async () => { for(let i=0;i<5;i++) await Promise.resolve(); };
  for (const type of Object.keys(replies)) {
    const input={version:1,type,requestId:'matrix'};
    const good={version:1,type,requestId:'matrix',...replies[type]};
    const rejected={version:1,type,requestId:'matrix',...rejections[type]};
    const cases=[
      [good,'accepted'],[rejected,'rejected'],[{...good,futureExtension:{x:1}},'accepted'],
      [{ok:false,code:'invalid_request'},'rejected'],
      ['silent','timeout'],['partial','no_reply'],['close','no_reply'],['reset','no_reply'],
      ['broken','invalid_reply'],[{...good,ok:'true'},'invalid_reply'],[{...good,version:2},'invalid_reply'],
      [{...good,type:'wrong'},'invalid_reply'],[{...good,requestId:'wrong'},'invalid_reply'],
      [{...good,result:'unknown_result'},'invalid_reply'],[{...good,ok:false},'invalid_reply'],
      ['deadline','deadline_exceeded'],['late','timeout'],['prewrite','deadline_exceeded'],
    ];
    for (const [body,kind] of cases) {
      let socket,closed=0,writes=0,attempts=0;
      const connect=()=>{attempts++;socket=new EventEmitter();socket.destroy=()=>{closed++;};
        socket.write=(_,cb)=>{writes++;if(body==='prewrite')return;
          cb();queueMicrotask(()=>{
            if(body==='partial'){socket.emit('data',Buffer.from('{"ok":'));socket.emit('end');}
            else if(body==='close')socket.emit('end');
            else if(body==='reset')socket.emit('error',Object.assign(new Error('reset'),{code:'ECONNRESET'}));
            else if(body==='broken')socket.emit('data',Buffer.from('bad\n'));
            else if(typeof body==='object'){socket.emit('data',Buffer.from(JSON.stringify(body)+'\n'));socket.emit('end');}
          });
        };queueMicrotask(()=>socket.emit('connect'));return socket;};
      const result=submit(input,{connect,now:()=>clock,deadlineAt:clock+(body==='deadline'||body==='prewrite'?5:100),replyMaxMs:10});
      await flush();clock+=10;t.mock.timers.tick(10);await flush();
      const actual=await result;assert.equal(actual.kind,kind,`${type} ${JSON.stringify(body)}`);assert.equal(actual.sent,true);
      if(body==='late'){socket.emit('data',Buffer.from(JSON.stringify(good)+'\n'));assert.equal(actual.kind,'timeout');}
      assert.equal(attempts,1);assert.equal(writes,1);assert.equal(closed,1);
    }
    let attempts=0;
    assert.deepEqual(await submit(input,{deadlineAt:clock,now:()=>clock,connect:()=>{attempts++;}}),{kind:'deadline_exceeded',sent:false});
    assert.equal(attempts,0);
    const missing=submit(input,{now:()=>clock,connect:()=>{const s=new EventEmitter();s.destroy=()=>{};queueMicrotask(()=>s.emit('error',Object.assign(new Error(),{code:'ENOENT'})));return s;}});
    await flush();assert.deepEqual(await missing,{kind:'connect_failed',sent:false});
  }
  assert.throws(()=>submit({type:'notify_delivered'}),TypeError);
  assert.throws(()=>submit({type:'route'}),TypeError);
});

test('IF-37 virtual 30s connection budget permits 12s listener and gives independent 10s reply deadline', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  for(const responds of [true,false]) {
    let clock=1792000000000;const start=clock;const attempts=[];let closedAt=null,writtenAt=null,socket;
    const connect=()=>{attempts.push(clock-start);socket=new EventEmitter();socket.destroy=()=>{closedAt=clock-start;};
      socket.write=(_,cb)=>{writtenAt=clock-start;cb();if(responds)setTimeout(()=>socket.emit('data',Buffer.from(JSON.stringify(reply)+'\n')),1000);};
      queueMicrotask(()=>clock-start<12000?socket.emit('error',Object.assign(new Error(),{code:'ECONNREFUSED'})):socket.emit('connect'));
      return socket;};
    const pending=submit(request,{connect,now:()=>clock,deadlineAt:start+30000,connectRetryEveryMs:1000});
    for(let second=0;second<=(responds?13:22);second++) {
      if(second){clock+=1000;t.mock.timers.tick(1000);}for(let n=0;n<5;n++)await Promise.resolve();
    }
    const result=await pending;
    assert.equal(result.kind,responds?'accepted':'timeout');assert.equal(result.sent,true);
    assert.deepEqual(attempts,Array.from({length:13},(_,i)=>i*1000));assert.equal(writtenAt,12000);assert.equal(closedAt,responds?13000:22000);
  }
});

test('IF-31 default completion lookup reads retained events only after authoritative F9 absence', async () => {
  const { supervisorDiagnosticPath } = await import('../session-group-paths.js');
  const file=supervisorDiagnosticPath();fs.mkdirSync(path.dirname(file),{recursive:true});
  const rotated=file.replace('.jsonl','.1792000000000.jsonl');
  fs.writeFileSync(rotated,JSON.stringify({v:1,event:'manual_restart_done',requestId:'manual'})+'\n');
  fs.writeFileSync(file,'bad line\n'+JSON.stringify({v:1,event:'restart_done',requestId:'upgrade'})+'\n');
  assert.equal(await lookupRestartRequest('upgrade',{readRequests:()=>[{requestId:'upgrade'}]}),'accepted');
  assert.equal(await lookupRestartRequest('upgrade',{readRequests:()=>[]}), 'done');
  assert.equal(await lookupRestartRequest('manual',{readRequests:()=>[]}), 'done');
  assert.equal(await lookupRestartRequest('missing',{readRequests:()=>[]}), 'unknown');
  fs.rmSync(file);fs.rmSync(rotated);
  assert.equal(await lookupRestartRequest('upgrade',{readRequests:()=>[]}), 'unknown');
});
