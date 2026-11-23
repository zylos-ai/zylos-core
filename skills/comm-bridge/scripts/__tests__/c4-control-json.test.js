import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import * as schema from '../c4-schema.js';
import { guardDatabase } from '../sqlite-schema.js';
import { createStore } from '../c4-v2-store.js';
import { tmuxNameForGroup } from '../../../../cli/lib/session-group-paths.js';
import { waitForServerExit } from '../../../../test/helpers/isolated-tmux.js';
const cli = fileURLToPath(new URL('../c4-control.js', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-control-json-'));
  fs.mkdirSync(path.join(root,'comm-bridge'));
  const db = new Database(path.join(root,'comm-bridge/c4.db'));
  guardDatabase(db,schema);
  t.after(()=>{db.close(); fs.rmSync(root,{recursive:true,force:true});});
  const env = {PATH:process.env.PATH,HOME:root,ZYLOS_DIR:root,PM2_HOME:path.join(root,'pm2'),
    TMPDIR:root,TMUX_TMPDIR:root};
  function run(args,status=0) {
    const r=spawnSync(process.execPath,[cli,...args],{env,encoding:'utf8',timeout:20000});
    assert.equal(r.status,status,r.stderr);
    assert.equal(r.stderr,'');
    assert.equal(r.stdout.trim().split('\n').length,1);
    return JSON.parse(r.stdout);
  }
  return {root,db,run,env};
}

// Integration boundary: real target-binding CLI, Router lanes and guarded adapter
// deliver a key only to its selected group. Run for group controls, target identity
// or delivery wiring changes; skip unrelated queue queries and lifecycle changes.
// Fresh HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR, private TMUX_TMPDIR/default socket,
// no inherited TMUX, temporary real C4 database, harmless byte-recording terminals;
// no live agent, PM2 or network. Cleanup kills only this socket and removes fixtures.
test('group-bound control CLI and Router send Escape only to the selected private terminal',{timeout:30000},async t=>{
  let stopTmux=()=>{};
  t.after(async()=>{await stopTmux();});
  const f=fixture(t),{root,db,run,env}=f;
  const binary=process.env.TEST_TMUX_BIN || 'tmux';
  const bin=path.join(root,'bin');fs.mkdirSync(bin);
  const executable=spawnSync('sh',['-c','command -v "$1"','sh',binary],{env,encoding:'utf8'});
  assert.equal(executable.status,0,executable.stderr);
  fs.symlinkSync(executable.stdout.trim(),path.join(bin,'tmux'));
  env.PATH=`${bin}${path.delimiter}${env.PATH}`;
  const socket=path.join(root,`tmux-${process.getuid()}`,'default');
  assert.ok(Buffer.byteLength(socket)<100,'Use a short temporary root');
  assert.equal(Object.hasOwn(env,'TMUX'),false);
  for(const key of ['HOME','ZYLOS_DIR','PM2_HOME','TMPDIR','TMUX_TMPDIR']) assert.ok(env[key].startsWith(root));
  console.log('group-control isolation:',JSON.stringify({...env,PATH:undefined,socket,database:db.name}));
  const tmux=(...args)=>{
    const result=spawnSync(binary,['-S',socket,...args],{env,encoding:'utf8',timeout:3000});
    assert.equal(result.status,0,result.stderr);return result.stdout.trim();
  };
  // The first cleanup hook stops terminals before the DB fixture removes files.
  stopTmux=async()=>{
    spawnSync(binary,['-S',socket,'kill-server'],{env,encoding:'utf8',timeout:3000});
    await waitForServerExit({binary,socketPath:socket});
  };
  fs.mkdirSync(path.dirname(socket),{recursive:true,mode:0o700});
  fs.mkdirSync(path.join(root,'.zylos'));
  fs.writeFileSync(path.join(root,'.zylos/config.json'),JSON.stringify({runtime:'codex',session_mode:'multi'}));
  const store=createStore(db,{validateComponent:()=>true,
    readConfig:()=>({state:'ok',config:{runtime:'codex',session_mode:'multi'}})});
  store.registerChannelNamespace('telegram','telegram');
  store.insertConversation('in','telegram','fixture','known group',{groupName:'a',status:'failed'});
  const groups=['origin','telegram:a','telegram:b'];
  for(const [index,group] of groups.entries()) {
    const log=path.join(root,`keys-${index}`),script=path.join(root,`terminal-${index}.mjs`);
    fs.writeFileSync(log,'');
    fs.writeFileSync(script,`import fs from 'node:fs';
      process.stdin.setRawMode(true);process.stdin.resume();
      process.stdin.on('data',bytes=>fs.appendFileSync(${JSON.stringify(log)},bytes.toString('hex')));
      fs.writeFileSync(${JSON.stringify(log+'.ready')},'ready');`);
    const runDir=path.join(root,'activity-monitor/session-groups',group);
    fs.mkdirSync(runDir,{recursive:true});
    fs.writeFileSync(path.join(runDir,'current-session.json'),JSON.stringify({runId:`run-${index}`,sessionId:`session-${index}`,
      ts:Date.now(),startupControlIds:[]}));
    tmux('-f','/dev/null','new-session','-d','-s',tmuxNameForGroup(group),
      '-e',`ZYLOS_RUN_ID=run-${index}`,'-e',`ZYLOS_SESSION_GROUP=${group}`,
      '-e','ZYLOS_MODEL_CONFIG={"runtime":"codex","mode":"default"}',process.execPath,script);
    for(let count=0;count<100 && !fs.existsSync(log+'.ready');count++) await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(fs.existsSync(log+'.ready'),true,'Private recorder must own stdin before delivery');
  }
  assert.equal(tmux('display-message','-p','#{socket_path}'),socket);
  const args=['enqueue','--group','telegram:a','--target-run','run-1','--expected-session','session-1',
    '--content','[KEYSTROKE]Escape','--priority','0','--bypass-state','--no-ack-suffix','--json'];
  const result=run(args);
  assert.equal(result.ok,true);
  const row=db.prepare('SELECT * FROM control_queue WHERE id=?').get(result.data.id);
  assert.equal(row.session_group,'telegram:a');
  assert.equal(JSON.parse(row.target_binding).expectedRunId,'run-1');
  assert.equal(JSON.parse(row.target_binding).expectedSessionId,'session-1');
  assert.equal(store.getNextPendingControl(undefined,{sessionGroups:['origin']}),null);
  assert.equal(store.getNextPendingControl(undefined,{sessionGroups:['telegram:a']}).id,row.id);
  for(const [option,value,code] of [['--target-run','old-run','TARGET_MISMATCH'],['--expected-session','old-session','STALE_TARGET']]) {
    const invalid=[...args];invalid[invalid.indexOf(option)+1]=value;
    const refusal=run(invalid,1);
    assert.equal(refusal.ok,false);assert.equal(refusal.error.code,code);
    assert.deepEqual(refusal.error.persisted,[]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM control_queue').get().n,1);
  }
  // Separate process owns the actual Core config/db singletons under this HOME.
  // It imports product modules directly; only runtime health/state are injected
  // because the terminal records bytes instead of authenticating a real agent.
  const routerScript=path.join(root,'route-control.mjs');
  fs.writeFileSync(routerScript,`import {createDispatcher} from ${JSON.stringify(new URL('../router/factory.js',import.meta.url).href)};
    import * as db from ${JSON.stringify(new URL('../c4-db.js',import.meta.url).href)};
    const router=createDispatcher({env:process.env,log:()=>{},diagnostic:()=>{},
      readRuntimeHealth:()=>({health:'ok',publicHealth:'ok'}),
      readSessionState:async group=>({identity:{runId:group==='origin'?'run-0':group==='telegram:a'?'run-1':'run-2',runtime:'codex',ready:true},
        status:{valid:true,value:{state:'idle',idle_seconds:10,health:'ok'}}})},
      {poolSize:2,tmux:{socketPath:${JSON.stringify(socket)},binary:${JSON.stringify(executable.stdout.trim())}},
        delivery:{periodicEnabled:false,captureEnabled:false}});
    try {await router.initialize();await router.idle();router.tick();await router.idle();
      console.log(JSON.stringify(db.getControlById(${row.id})));}
    finally {await router.stop();db.close();}`);
  const delivered=spawnSync(process.execPath,[routerScript],{env,cwd:root,encoding:'utf8',timeout:20000});
  assert.equal(delivered.status,0,delivered.stderr);
  assert.equal(JSON.parse(delivered.stdout).status,'done');
  for(let count=0;count<100 && !fs.readFileSync(path.join(root,'keys-1'),'utf8');count++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(fs.readFileSync(path.join(root,'keys-1'),'utf8'),'1b');
  assert.equal(fs.readFileSync(path.join(root,'keys-0'),'utf8'),'');
  assert.equal(fs.readFileSync(path.join(root,'keys-2'),'utf8'),'');
  assert.equal(tmux('has-session','-t',tmuxNameForGroup('origin')),'');
  assert.equal(tmux('has-session','-t',tmuxNameForGroup('telegram:b')),'');
});
