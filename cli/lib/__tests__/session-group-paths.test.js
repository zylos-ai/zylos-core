import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
test('list performs one argv call; only absent server is empty, other failures propagate', () => {
  let calls=0;
  const result=p.listGroupTmuxSessions({socketPath:'/private/socket',exec:(cmd,args)=>{
    calls++; assert.equal(cmd,'tmux'); assert.deepEqual(args,['-u','-S','/private/socket','list-sessions','-F','#{session_name}\t#{session_created}']);
    return 'zylos-group-lark= x\nclaude-main\t1\nzylos-group-origin\t123\nzylos-group-Foo\t2\n';
  }});
  assert.equal(calls,1); assert.deepEqual(result,[{sessionGroup:'origin',tmuxName:'zylos-group-origin',createdAt:123}]);
  for (const stderr of ['no server running on /private/socket','error connecting to /private/socket (No such file or directory)']) assert.deepEqual(p.listGroupTmuxSessions({exec:()=>{throw Object.assign(new Error(),{status:1,stderr});}}),[]);
  for (const error of [Object.assign(new Error(),{code:'ENOENT'}),Object.assign(new Error(),{code:'ETIMEDOUT'}),Object.assign(new Error(),{status:1,stderr:'permission denied'})]) assert.throws(()=>p.listGroupTmuxSessions({exec:()=>{throw error;}}),e=>e===error);
  assert.throws(()=>p.listGroupTmuxSessions({exec:()=> 'zylos-group-origin\tbad\n'}),{code:'TMUX_RESPONSE_INVALID'});
});
test('real private tmux: names, timestamps, exact targets and missing server', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'p02-tmux-')); const socket=path.join(root,'socket');
  const tmux=(...args)=>execFileSync('tmux',['-S',socket,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  try {
    assert.deepEqual(p.listGroupTmuxSessions({socketPath:socket}),[]);
    const liveGroups=groups.filter(g=>g!=='telegram:g-1' && !g.startsWith('sample'));
    for(const g of liveGroups) tmux('-f','/dev/null','new-session','-d','-s',p.tmuxNameForGroup(g),'sleep 60');
    for(const name of ['claude-main','zylos-group-Foo']) tmux('new-session','-d','-s',name,'sleep 60');
    const listed=p.listGroupTmuxSessions({socketPath:socket});
    assert.deepEqual(listed.map(x=>x.sessionGroup).sort(),liveGroups.toSorted());
    for(const row of listed) assert.equal(row.createdAt,Number(tmux('display-message','-p','-t',p.tmuxPaneTarget(row.tmuxName),'#{session_created}').trim()));
    const short=p.tmuxSessionTarget(p.tmuxNameForGroup('telegram:g-1'));
    assert.throws(()=>tmux('has-session','-t',short)); assert.throws(()=>tmux('kill-session','-t',short));
    tmux('has-session','-t',p.tmuxSessionTarget(p.tmuxNameForGroup('telegram:g-100123')));
    const pane=p.tmuxPaneTarget(p.tmuxNameForGroup('origin'));
    tmux('send-keys','-t',pane,'-l','p02-private-marker');
    assert.match(tmux('capture-pane','-p','-t',pane),/p02-private-marker/);
  } finally {try {tmux('kill-server');} catch {} fs.rmSync(root,{recursive:true,force:true});}
});
