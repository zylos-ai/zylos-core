import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { installParserFixture } from './helpers/p02-parser-fixture.js';
installParserFixture(['origin']);
const { openTmuxConnection, serverGeneration } = await import('../cli/lib/runtime/tmux-connection.js');
const { observeSessionTarget, resolveSessionTarget, revalidateSessionTarget, readTargetRuntime } = await import('../cli/lib/runtime/session-target.js');
const ready = async () => ({ runId: 'r1', sessionId: 's1', ts: 1, startupControlIds: [] });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p02-target-'));
  const socketPath = path.join(dir, 'tmux.sock');
  const tmux = (...args) => execFileSync('tmux', ['-S', socketPath, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', '-e', 'ZYLOS_RUN_ID=r1', '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}', 'sleep', '120');
  const connection = await openTmuxConnection({ socketPath, sessionName: 'fixture' });
  t.after(async () => { connection.close(); try { tmux('kill-server'); } catch {} await fs.rm(dir, { recursive: true, force: true }); });
  return { connection, tmux, socketPath, options: { connection, tmuxName: 'fixture', readReady: ready } };
}
test('real control framing, exact quoting, queue, and one retained client', async t => {
  const {connection, tmux} = await fixture(t);
  const payload = "hello ' $X \\ ; end";
  assert.equal(await connection.command(['display-message','-p',payload]), payload);
  assert.deepEqual(await Promise.all(['a','b','c'].map(x => connection.command(['display-message','-p',x]))), ['a','b','c']);
  assert.match(await serverGeneration(connection), /^\d+:\d+$/);
  assert.equal(tmux('list-clients','-F','#{client_pid}').split('\n').length, 1);
  await assert.rejects(connection.command(['display-message','-p','x\ny']), TypeError);
  await assert.rejects(connection.command(['display-message','-p','x\0y']), TypeError);
  assert.equal(await connection.command(['display-message','-p','still alive']), 'still alive');
});
test('fixed pane survives active pane change; run mutation rejected', async t => {
  const {connection, tmux, options} = await fixture(t);
  const target = await resolveSessionTarget(options);
  assert.equal(target.runtime, 'claude'); assert.equal(target.runtimeSessionId, 's1'); assert.match(target.sessionId, /^\$/);
  const second = tmux('split-window','-d','-P','-F','#{pane_id}','-t','fixture','sleep','120');
  tmux('select-pane','-t',second);
  assert.equal(await revalidateSessionTarget({connection,target}), true); assert.notEqual(second, target.paneId);
  tmux('set-environment','-t','fixture','ZYLOS_RUN_ID','r2');
  await assert.rejects(revalidateSessionTarget({connection,target}), {code:'RUNID_MISMATCH'});
});
test('removed pane, absent target, and missing run ID fail distinctly', async t => {
  const {connection, tmux, options} = await fixture(t);
  const target = await resolveSessionTarget(options);
  tmux('split-window','-d','-t','fixture','sleep','120'); tmux('kill-pane','-t',target.paneId);
  await assert.rejects(revalidateSessionTarget({connection,target}), {code:'TARGET_GONE'});
  assert.equal((await observeSessionTarget({...options,tmuxName:'absent'})).present,false);
  await assert.rejects(resolveSessionTarget({...options,tmuxName:'absent'}),{code:'TARGET_GONE'});
  tmux('set-environment','-u','-t','fixture','ZYLOS_RUN_ID');
  await assert.rejects(resolveSessionTarget(options),{code:'RUNID_MISMATCH'});
});
test('F3 malformed/mismatched is not READY; snapshots immutable', async t => {
  const {options} = await fixture(t);
  assert.equal((await observeSessionTarget({...options,readReady:async()=>({runId:'r1',sessionId:'s1'})})).ready,false);
  assert.equal((await observeSessionTarget({...options,readReady:async()=>({...await ready(),runId:'other'})})).ready,false);
  const good = await observeSessionTarget(options); assert.equal(good.ready,true);
  assert.throws(()=>{good.rawF2.ZYLOS_RUN_ID='evil';},TypeError); assert.throws(()=>{good.f3.startupControlIds.push(1);},TypeError);
});
test('same socket restart cannot reconnect or replay', async t => {
  const {connection,tmux,socketPath,options} = await fixture(t);
  const target = await resolveSessionTarget(options); tmux('kill-server');
  await new Promise(resolve=>setTimeout(resolve,100));
  tmux('-f','/dev/null','new-session','-d','-s','fixture','sleep','120');
  await assert.rejects(revalidateSessionTarget({connection,target}),{code:'TMUX_UNAVAILABLE'});
  const replacement = await openTmuxConnection({socketPath}); assert.notEqual(replacement.serverGeneration,target.serverGeneration); replacement.close();
});
test('absent server differs from unexecutable transport; missing generation rejected', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'p02-no-server-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await assert.rejects(openTmuxConnection({socketPath:path.join(dir,'absent')}),{code:'TMUX_NO_SERVER'});
  await assert.rejects(openTmuxConnection({binary:path.join(dir,'missing')}),{code:'TMUX_UNAVAILABLE',cause:'error'});
  await assert.rejects(serverGeneration({command:async()=> '123:'}),{code:'TMUX_UNAVAILABLE'});
});
test('runtime fallback uses unique shallowest name and never invents config', async () => {
  const connection={command:async()=> '10'};
  const rows=[{pid:10,ppid:1,name:'node'},{pid:11,ppid:10,name:'codex.exe'},{pid:12,ppid:11,name:'claude'}];
  assert.deepEqual(await readTargetRuntime({connection,paneId:'%1',rawF2:{},readProcessTree:async()=> rows}),{runtime:'codex',launchConfig:null});
  rows.push({pid:13,ppid:10,name:'claude'});
  assert.equal((await readTargetRuntime({connection,paneId:'%1',rawF2:{},readProcessTree:async()=> rows})).runtime,'unknown');
  assert.equal((await readTargetRuntime({connection,paneId:'%1',rawF2:{ZYLOS_MODEL_CONFIG:'{"runtime":"claude"}'},readProcessTree:async()=> {throw Error('must not run');}})).runtime,'claude');
  assert.equal((await readTargetRuntime({connection,paneId:'%1',rawF2:{},readProcessTree:async()=> {throw Error('unreadable');}})).runtime,'unknown');
});
test('real Linux comm fallback recognizes a named stand-in without F2 defaults', {skip:process.platform!=='linux'}, async t => {
  const {connection,tmux,options}=await fixture(t);
  tmux('set-environment','-u','-t','fixture','ZYLOS_MODEL_CONFIG');
  // This is a stdlib stand-in, never the installed model CLI or its auth.
  tmux('respawn-pane','-k','-t','fixture','python3','-c',"import ctypes,time; ctypes.CDLL(None).prctl(15,b'codex',0,0,0); time.sleep(120)");
  let observed;
  for (let attempt=0;attempt<30;attempt++) {
    observed=await observeSessionTarget(options);
    if(observed.runtime==='codex') break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(observed.runtime,'codex'); assert.equal(observed.launchConfig,null);
  assert.equal(connection.closed,false);
});
test('initial disappearance and generation change are detected before any sending', async () => {
  let reads=0;
  const connection={command:async args=> {
    if(args[0]==='show-environment') throw Object.assign(Error("can't find session: $1"),{code:'TMUX_COMMAND_FAILED'});
    return reads++===0 ? '$1\t%1\t123' : '100:200';
  }};
  await assert.rejects(observeSessionTarget({connection,tmuxName:'fixture',readReady:ready}),{code:'TARGET_GONE'});
  let generation='100:200';
  const held={command:async args=> {
    if(args[0]==='show-environment') return 'ZYLOS_RUN_ID=r1\nZYLOS_MODEL_CONFIG={"runtime":"claude"}';
    if(args.at(-1)==='#{pid}:#{start_time}') return generation;
    if(args.at(-1)==='#{session_id}\t#{pane_id}') return '$1\t%1';
    return '$1\t%1\t123';
  }};
  const target=await resolveSessionTarget({connection:held,tmuxName:'fixture',readReady:ready});
  generation='101:201';
  await assert.rejects(revalidateSessionTarget({connection:held,target}),{code:'GENERATION_CHANGED'});
  await assert.rejects(revalidateSessionTarget({connection:held,target:{...target}}),TypeError);
});
test('command timeout closes held client and never accepts a retry', async t => {
  const {socketPath}=await fixture(t);
  const connection=await openTmuxConnection({socketPath,timeoutMs:40});
  t.after(()=>connection.close());
  await connection.command(['wait-for','unreleased-test-channel']);
  await assert.rejects(connection.command(['display-message','-p','blocked']),{code:'TMUX_UNAVAILABLE',cause:'timeout'});
  assert.equal(connection.closed,true);
  await assert.rejects(connection.command(['display-message','-p','must not replay']),{code:'TMUX_UNAVAILABLE'});
});
