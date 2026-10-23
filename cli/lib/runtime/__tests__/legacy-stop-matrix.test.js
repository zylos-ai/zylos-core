import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SessionAdapter } from '../session-adapter.js';
import { LEGACY_TMUX_NAMES } from '../../session-group-paths.js';

// Real tmux suite: missing or incompatible binaries fail, never silently skip.
const binary = process.env.TEST_TMUX_BIN || 'tmux';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class Adapter extends SessionAdapter { get runtimeId() { return 'claude'; } }
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p02-legacy-'));
  const socketPath = path.join(dir, 'socket');
  const command = (...args) => execFileSync(binary, ['-S', socketPath, ...args], {encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:3000}).trim();
  command('-f','/dev/null','new-session','-d','-s','origin','sleep 300');
  command('set-option','-g','destroy-unattached','off');
  const logs = [];
  const adapter = new Adapter({tmux:{binary,socketPath,sessionName:'origin'},log:line=>logs.push(line)});
  const snapshot = name => command('display-message','-p','-t',`=${name}:`,'#{session_id}:#{pane_id}:#{pane_pid}');
  const origin = snapshot('origin');
  t.after(async () => { try {command('kill-server');} catch {} await fs.rm(dir,{recursive:true,force:true}); });
  return {dir,command,adapter,logs,snapshot,origin};
}
for (const legacy of LEGACY_TMUX_NAMES) {
  test(`real ${legacy}: absent/null succeeds with unknown log, origin intact`, async t => {
    const f = await fixture(t);
    await f.adapter.stop({tmuxName:legacy,expectedRunId:null});
    assert.deepEqual(f.logs,['Session ended; process state unknown']);
    assert.equal(f.snapshot('origin'), f.origin);
  });
  test(`real ${legacy}: present/null conservative rejection and mismatches do not mutate`, async t => {
    const f = await fixture(t);
    f.command('new-session','-d','-s',legacy,'sleep 300');
    const before = f.snapshot(legacy);
    for (const [actual,expected,code] of [[null,null,'STOP_UNCONFIRMED'],[null,'wrong','RUNID_MISMATCH'],['actual',null,'RUNID_MISMATCH'],['actual','wrong','RUNID_MISMATCH']]) {
      if (actual) f.command('set-environment','-t',`=${legacy}`,'ZYLOS_RUN_ID',actual);
      await assert.rejects(f.adapter.stop({tmuxName:legacy,expectedRunId:expected}),{code});
      assert.equal(f.snapshot(legacy),before);
      assert.equal(f.snapshot('origin'),f.origin);
    }
    assert.deepEqual(f.logs,[]);
  });
}
test('real legacy child: adding F2 now does not tag existing runtime or child', async t => {
  const f = await fixture(t);
  const script = path.join(f.dir,'child.mjs');
  const proof = path.join(f.dir,'child.json');
  await fs.writeFile(script, `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
if(process.argv[2] !== 'child') {
 const child=spawn(process.execPath,[import.meta.filename,'child'],{stdio:'ignore'});
 writeFileSync(${JSON.stringify(proof)},JSON.stringify({parent:process.pid,child:child.pid}));
}
setInterval(()=>{},1000);
`);
  const name = LEGACY_TMUX_NAMES[0];
  f.command('new-session','-d','-s',name,`env -u ZYLOS_RUN_ID ${process.execPath} ${script}`);
  let family;
  t.after(async()=>{
    if (!family) {try {family=JSON.parse(await fs.readFile(proof,'utf8'));} catch {}}
    for(const pid of [family?.child,family?.parent].filter(Boolean)) {try {process.kill(pid,'SIGKILL');} catch {}}
  });
  for(let i=0;i<100;i++) {try {family=JSON.parse(await fs.readFile(proof,'utf8'));break;} catch {await delay(20);} }
  assert.ok(family);
  f.command('set-environment','-t',`=${name}`,'ZYLOS_RUN_ID','assigned-after-start');
  for(const pid of [family.parent,family.child]) {
    const env = (await fs.readFile(`/proc/${pid}/environ`)).toString().split('\0');
    assert.equal(env.some(value=>value.startsWith('ZYLOS_RUN_ID=')),false);
  }
  await assert.rejects(f.adapter.stop({tmuxName:name,expectedRunId:null}),{code:'RUNID_MISMATCH'});
  assert.equal(f.snapshot('origin'),f.origin);
});
test('real legacy orphan disproves pane/tree termination as historical ownership proof', async t => {
  const f = await fixture(t);
  const script = path.join(f.dir,'orphan.mjs');
  const proof = path.join(f.dir,'proof.json');
  await fs.writeFile(script, `import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
const mode=process.argv[2];
if(mode === 'middle') {
 const child=spawn(process.execPath,[import.meta.filename,'orphan'],{detached:true,stdio:'ignore'});child.unref();
} else if(mode === 'orphan') {
 process.on('SIGHUP',()=>{});
 setTimeout(()=>{
  const stat=readFileSync('/proc/'+process.pid+'/stat','utf8');
  const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
  writeFileSync(${JSON.stringify(proof)},JSON.stringify({pid:process.pid,ppid:process.ppid,sid:Number(fields[3]),runId:process.env.ZYLOS_RUN_ID??null}));
 },100);
 setInterval(()=>{},1000);
} else {
 spawn(process.execPath,[import.meta.filename,'middle'],{stdio:'ignore'});
 setInterval(()=>{},1000);
}
`);
  f.command('new-session','-d','-s',LEGACY_TMUX_NAMES[0],`env -u ZYLOS_RUN_ID ${process.execPath} ${script}`);
  let orphan;
  t.after(async()=>{
    if (!orphan) {try {orphan=JSON.parse(await fs.readFile(proof,'utf8'));} catch {}}
    if (orphan?.pid) {try {process.kill(orphan.pid,'SIGKILL');} catch {}}
  });
  for(let i=0;i<100;i++) {try {orphan=JSON.parse(await fs.readFile(proof,'utf8'));break;} catch {await delay(20);} }
  assert.ok(orphan,'orphan proof must be produced');
  assert.equal(orphan.ppid,1);
  assert.equal(orphan.runId,null);
  const pane = Number(f.command('display-message','-p','-t',`=${LEGACY_TMUX_NAMES[0]}:`,'#{pane_pid}'));
  assert.notEqual(orphan.sid,pane);
  await assert.rejects(f.adapter.stop({tmuxName:LEGACY_TMUX_NAMES[0],expectedRunId:null}),{code:'STOP_UNCONFIRMED'});
  // Deliberate counterexample experiment, not adapter behavior or stop success.
  f.command('kill-session','-t',`=${LEGACY_TMUX_NAMES[0]}`);
  await delay(100);
  process.kill(orphan.pid,0);
  const stat = await fs.readFile(`/proc/${orphan.pid}/stat`,'utf8');
  assert.notEqual(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0],'Z');
  assert.equal(f.snapshot('origin'),f.origin);
  console.log('orphan-counterexample',JSON.stringify({pane, ...orphan,aliveAfterTmuxKill:true}));
});
