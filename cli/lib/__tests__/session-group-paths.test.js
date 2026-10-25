import { isolatedTmux } from '../../../test/helpers/isolated-tmux.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { encodeGroupCharacters as enc, decodeGroupCharacters as dec } from '../session-group-codec.js';
export const groups = ['origin','telegram:g-100123','telegram:g-1','wechat:abc_chatroom','lark','larkx','lark:x','lark:oc_x:omt_y','openmax:dm.AbC','ns:a:b','ns:a.b','ns:a_b','ns:a__b','ns:a_cb','ns:AbC','ns:abc','ns:x:','ns:x.', `${'n'.repeat(32)}:${'A'.repeat(95)}`];
// Deterministic generated inputs exercise character combinations; legality remains
// delegated to the real P01 parser.
let seed = 8731;
for (let i = 0; i < 100; i++) {
  let name = 'A';
  const alphabet = 'aAZ09_.:-';
  for (let j = 0; j < 50; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; name += alphabet[seed % alphabet.length]; }
  groups.push(`sample${i}:${name}`);
}
const p = await import('../session-group-paths.js');
function* words(alphabet, max, prefix = '') {
  yield prefix;
  if (prefix.length < max) for (const char of alphabet) yield* words(alphabet, max, prefix + char);
}
test('M2 codec exhaustive roundtrip, injection, canonical decoding and bad-encoder control', () => {
  const seen = new Set(); let inputs = 0;
  for (const value of words('aA_:.-', 8)) {
    const encoded = enc(value);
    assert.equal(dec(encoded), value);
    assert.equal(seen.has(encoded), false); seen.add(encoded); inputs++;
  }
  assert.equal(inputs, 2015539);
  let outputs = 0;
  for (const value of words('aA_=+-:.', 7)) {
    const decoded = dec(value);
    if (/[:.]/.test(value)) assert.equal(decoded, null);
    else assert.equal(enc(decoded), value);
    outputs++;
  }
  assert.equal(outputs, 2396745);
  const bad = value => value.replaceAll(':', '_').replaceAll('.', '+');
  assert.throws(() => assert.notEqual(bad('a:b'), bad('a_b')));
  assert.throws(() => assert.equal(dec(bad('a:b')), 'a:b'));
});
test('group names preserve case/length, reject invalid and allow distinct extensions', () => {
  const names = groups.map(g => p.tmuxNameForGroup(g));
  assert.equal(new Set(names).size, groups.length);
  for (const [i,g] of groups.entries()) {
    assert.equal(p.groupFromTmuxName(names[i]), g);
    assert.match(names[i].slice(12), /^[A-Za-z0-9_=+-]+$/);
    assert.equal(names[i].length, g.length + 12);
    assert.equal(p.tmuxSessionTarget(names[i]), `=${names[i]}`);
    assert.equal(p.tmuxPaneTarget(names[i]), `=${names[i]}:`);
  }
  for (const value of ['', 'void','Telegram','lark:','ns:x=y','ns:x+y','../origin',null]) {
    assert.throws(() => p.tmuxNameForGroup(value), { code: 'SESSION_GROUP_INVALID' });
  }
  for (const name of ['zylos-group-', 'zylos-group-Foo', 'zylos-group-void', 'zylos-group-lark:x','zylos-group-lark.x','zylos-group-lark=','zylos-group-+lark','claude-main','codex-main','zylos-setup']) assert.equal(p.groupFromTmuxName(name), null);
});
test('pure paths and environment precedence never create directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p02-paths-'));
  try {
    const env = { ZYLOS_DIR: path.join(root, 'uncreated'), HOME: '/unused' };
    assert.deepEqual(p.runDirFromEnv(env), { dir: `${env.ZYLOS_DIR}/activity-monitor`, sessionGroup:null, kind:'legacy' });
    assert.deepEqual(p.runDirFromEnv({...env, ZYLOS_RUN_ID:'run'}), {dir:`${env.ZYLOS_DIR}/activity-monitor/session-groups/origin`, sessionGroup:null, kind:'single'});
    assert.deepEqual(p.runDirFromEnv({...env, ZYLOS_RUN_ID:'run', ZYLOS_SESSION_GROUP:'lark:x'}), {dir:`${env.ZYLOS_DIR}/activity-monitor/session-groups/lark:x`, sessionGroup:'lark:x',kind:'group'});
    for (const bad of ['', undefined, '../escape']) assert.throws(() => p.runDirFromEnv({...env, ZYLOS_RUN_ID:'run', ZYLOS_SESSION_GROUP:bad}), {code:'SESSION_GROUP_INVALID'});
    assert.equal(p.groupMemoryDir('lark:x', env), `${env.ZYLOS_DIR}/memory/session-groups/lark:x`);
    assert.equal(p.legacyRunDir({HOME:root}), `${root}/zylos/activity-monitor`);
    for (const [fn,file] of [['routerDiagnosticPath','comm-bridge/router-events.jsonl'],['supervisorDiagnosticPath','activity-monitor/supervisor-events.jsonl'],['poolMetricsPath','activity-monitor/pool-metrics.jsonl'],['hookErrorLogPath','activity-monitor/hook-activity-errors.log']]) assert.equal(p[fn](env), `${env.ZYLOS_DIR}/${file}`);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('list performs one async argv call; only absent server is empty, other failures propagate', async () => {
  let calls=0;
  const result=await p.listGroupTmuxSessions({socketPath:'/private/socket',exec:async(cmd,args,options)=>{
    calls++; assert.equal(options.timeout,5000); assert.equal(cmd,'tmux'); assert.deepEqual(args,['-u','-S','/private/socket','list-sessions','-F','#{session_name}\t#{session_created}']);
    return 'zylos-group-lark= x\nclaude-main\t1\nzylos-group-origin\t123\nzylos-group-Foo\t2\n';
  }});
  assert.equal(calls,1); assert.deepEqual(result,[{sessionGroup:'origin',tmuxName:'zylos-group-origin',createdAt:123}]);
  for (const stderr of ['no server running on /private/socket','error connecting to /private/socket (No such file or directory)']) assert.deepEqual(await p.listGroupTmuxSessions({exec:async()=>{throw Object.assign(new Error(),{status:1,stderr});}}),[]);
  for (const error of [Object.assign(new Error(),{code:'ENOENT'}),Object.assign(new Error(),{code:'ETIMEDOUT'}),Object.assign(new Error(),{code:'EACCES'}),Object.assign(new Error(),{status:1,stderr:'permission denied'})]) await assert.rejects(p.listGroupTmuxSessions({exec:async()=>{throw error;}}),e=>e===error);
  await assert.rejects(p.listGroupTmuxSessions({exec:async()=> 'zylos-group-origin\tbad\n'}),{code:'TMUX_RESPONSE_INVALID'});
});
test('real private tmux: names, timestamps, exact targets and missing server', async t => {
  const {dir:root,socketPath:socket,binary,tmux}=isolatedTmux(t,{prefix:'p02-tmux-',socketName:'socket',trim:false});
  await assert.rejects(p.listGroupTmuxSessions({socketPath:socket,binary:path.join(root,'missing-tmux')}),{code:'ENOENT'});
  const deniedBinary=path.join(root,'denied-tmux');
  fs.writeFileSync(deniedBinary,'#!/bin/sh\nexit 0\n',{mode:0o600});
  await assert.rejects(p.listGroupTmuxSessions({socketPath:socket,binary:deniedBinary}),{code:'EACCES'});
  assert.deepEqual(await p.listGroupTmuxSessions({socketPath:socket,binary}),[]);
  const liveGroups=groups.filter(g=>g!=='telegram:g-1' && !g.startsWith('sample'));
  for(const g of liveGroups) tmux('-f','/dev/null','new-session','-d','-s',p.tmuxNameForGroup(g),'sleep 60');
  for(const name of ['claude-main','zylos-group-Foo']) tmux('new-session','-d','-s',name,'sleep 60');
  const listed=await p.listGroupTmuxSessions({socketPath:socket,binary});
  assert.deepEqual(listed.map(x=>x.sessionGroup).sort(),liveGroups.toSorted());
  for(const row of listed) assert.equal(row.createdAt,Number(tmux('display-message','-p','-t',p.tmuxPaneTarget(row.tmuxName),'#{session_created}').trim()));
  const short=p.tmuxSessionTarget(p.tmuxNameForGroup('telegram:g-1'));
  assert.throws(()=>tmux('has-session','-t',short)); assert.throws(()=>tmux('kill-session','-t',short));
  tmux('has-session','-t',p.tmuxSessionTarget(p.tmuxNameForGroup('telegram:g-100123')));
  const pane=p.tmuxPaneTarget(p.tmuxNameForGroup('origin'));
  tmux('send-keys','-t',pane,'-l','p02-private-marker');
  assert.match(tmux('capture-pane','-p','-t',pane),/p02-private-marker/);
});

// A subprocess proves both event-loop responsiveness and natural exit while the
// private server remains frozen (tmux passes its client pipes to the server).
test('async list keeps timers responsive and exits after frozen-server timeout', {timeout:12000}, async t => {
  let server,child,exited;
  const {dir,socketPath,binary,tmux}=isolatedTmux(t,{prefix:'p02-list-',tmuxArgs:['-u'],timeout:2000,beforeCleanup:async()=>{
    if(child && child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
    if(exited) await exited;
    if(server) try{process.kill(server,'SIGKILL');}catch{}
  }});
  const pidFile=path.join(dir,'client-pid');
  const quote=value=>`'${value.replaceAll("'", "'\\''")}'`;
  const wrapper=path.join(dir,'tmux-wrapper');
  fs.writeFileSync(wrapper,`#!/bin/sh\nprintf '%s\\n' "$$" > ${quote(pidFile)}\nexec ${quote(binary)} "$@"\n`,{mode:0o700});
  tmux('-f','/dev/null','new-session','-d','-s','keeper','sleep 30');
  server=Number(tmux('display-message','-p','#{pid}'));
  process.kill(server,'SIGSTOP');
  const moduleUrl=new URL('../session-group-paths.js',import.meta.url).href;
  const source=`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {listGroupTmuxSessions} from ${JSON.stringify(moduleUrl)};
    const start=performance.now();let pending=true,tickMs,tickWhilePending;
    const tick=new Promise(resolve=>setTimeout(()=>{
      tickMs=performance.now()-start;tickWhilePending=pending;resolve();
    },100));
    let error;
    try{await listGroupTmuxSessions(${JSON.stringify({socketPath,binary:wrapper})});}
    catch(caught){error=caught;}
    pending=false;
    const elapsed=performance.now()-start;
    await tick;
    const clientPid=Number(fs.readFileSync(${JSON.stringify(pidFile)},'utf8'));
    const report={tickMs,tickWhilePending,elapsed,code:error?.code,status:error?.status,signal:error?.signal,clientPid};
    console.log(JSON.stringify(report));
    assert.ok(tickWhilePending && tickMs<1000,'enumeration blocked the caller timer');
    assert.equal(error?.code,'ETIMEDOUT');
    // Some tmux clients exit zero after sending their request while the server
    // retains their pipes; others stay alive until killed at the deadline.
    assert.ok((error?.status===0 && error?.signal===null) ||
      (error?.status===null && error?.signal==='SIGTERM'),'timeout must preserve the actual client exit state');
    assert.ok(elapsed>=4900 && elapsed<7000,'enumeration must retain its five-second timeout');
    assert.throws(()=>process.kill(clientPid,0),{code:'ESRCH'},'owned tmux client must be gone before rejection');
  `;
  const env={...process.env,HOME:dir,ZYLOS_DIR:dir};
  delete env.TMUX;delete env.TMUX_PANE;
  child=spawn(process.execPath,['--input-type=module','-e',source],{env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
  exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  let timer;
  const result=await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),8000);})]).finally(()=>clearTimeout(timer));
  assert.notEqual(result,null,'caller retained client, timer or pipes after enumeration timeout');
  assert.deepEqual(result,{code:0,signal:null},`${stdout}\n${stderr}`);
  assert.match(execFileSync('ps',['-o','stat=','-p',String(server)],{encoding:'utf8'}).trim(),/^T/,
    'caller must exit before the server is resumed or killed');
  t.diagnostic(stdout.trim());
});
