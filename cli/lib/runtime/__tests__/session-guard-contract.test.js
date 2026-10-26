import { isolatedTmux } from '../../../../test/helpers/isolated-tmux.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Set isolated roots before importing the real C4 database/config modules.
const root=await fs.mkdtemp(path.join(os.tmpdir(),'p02-guard-'));
process.env.ZYLOS_DIR=root;process.env.HOME=root;
process.env.ZYLOS_PACKAGE_ROOT=fileURLToPath(new URL('../../../../',import.meta.url));
await fs.mkdir(path.join(root,'.zylos'));
await fs.writeFile(path.join(root,'.zylos/config.json'),JSON.stringify({runtime:'claude',session_mode:'multi'}));
const {openTmuxConnection}=await import('../tmux-connection.js');
const {resolveSessionTarget}=await import('../session-target.js');
const {SessionAdapter}=await import('../session-adapter.js');
const {createCoreObserver}=await import('../../../../skills/comm-bridge/scripts/c4-runtime-observer.js');
const {createStore}=await import('../../../../skills/comm-bridge/scripts/c4-v2-store.js');
const c4=await import('../../../../skills/comm-bridge/scripts/c4-db.js');
const {guardDatabase}=await import('../../../../skills/comm-bridge/scripts/sqlite-schema.js');
const schema=await import('../../../../skills/comm-bridge/scripts/c4-schema.js');
const db=c4.getDb();
assert.equal(db.name,path.join(root,'comm-bridge/c4.db'));
after(async()=>{db.close();await fs.rm(root,{recursive:true,force:true});});
const binary=process.env.TEST_TMUX_BIN||'tmux';
const actualBinary=execFileSync('sh',['-c','command -v "$1"','sh',binary],{encoding:'utf8'}).trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function bindingStore(t,observer){
  const database=new db.constructor(':memory:');guardDatabase(database,schema);t.after(()=>database.close());
  return {database,store:createStore(database,{validateComponent:()=>true,readConfig:()=>({state:'ok',config:{session_mode:'multi'}}),resolveTarget:observer.observeCoreTarget})};
}

async function fixture(t){
  const {dir,socketPath,tmux}=isolatedTmux(t,{parentDir:root,prefix:'case-',tmuxArgs:['-u'],timeout:2000});
  tmux('-f','/dev/null','new-session','-d','-s','keeper','sleep 120');
  const input=path.join(dir,'received');
  tmux('new-session','-d','-s','zylos-group-origin','-e','ZYLOS_RUN_ID=guard-run',
    '-e','ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}','-e','ZYLOS_SESSION_GROUP=origin',
    `exec cat > '${input}'`);
  const readyDir=path.join(root,'activity-monitor/session-groups/origin');await fs.mkdir(readyDir,{recursive:true});
  await fs.writeFile(path.join(readyDir,'current-session.json'),JSON.stringify({runId:'guard-run',sessionId:'runtime-session',ts:1,startupControlIds:[]}));
  const flag=path.join(dir,'hang'),calls=path.join(dir,'calls'),wrapper=path.join(dir,'tmux-wrapper');
  await fs.writeFile(wrapper,`#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');if(fs.existsSync(${JSON.stringify(flag)})){setInterval(()=>{},1000);}else{const r=cp.spawnSync(${JSON.stringify(actualBinary)},a,{stdio:'inherit'});process.exit(r.status??1);}\n`,{mode:0o700});
  // The deadline includes a new Node process for every wrapper invocation.
  // Leave startup headroom under parallel runtime/stress load so these cases
  // exercise the deliberate hang rather than killing the wrapper before logging.
  const options={socketPath,binary:wrapper,timeoutMs:1000};
  return {dir,tmux,input,flag,calls,options};
}

for(const position of ['initial','guarded-environment'])test(`IF-16 hanging ${position} command keeps D3 empty and preserves timeout cause`,async t=>{
  const f=await fixture(t);
  if(position==='initial')await fs.writeFile(f.flag,'1');
  else {
    const source=await fs.readFile(f.options.binary,'utf8');
    await fs.writeFile(f.options.binary,source.replace(`fs.existsSync(${JSON.stringify(f.flag)})`,`a.includes('if-shell')`));
  }
  const observer=createCoreObserver({tmux:f.options});
  const {store,database}=bindingStore(t,observer);
  await assert.rejects(store.buildTargetBinding({sessionGroup:'origin',expectedRunId:'guard-run',expectedRuntime:'claude'}),{code:'TMUX_UNAVAILABLE',cause:'timeout'});
  assert.equal(database.prepare('SELECT count(*) FROM control_queue').pluck().get(),0);
  const calls=(await fs.readFile(f.calls,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.some(a=>a.includes('send-keys')||a.includes('paste-buffer')),false);
  if(position==='guarded-environment')assert.ok(calls.some(a=>a.includes('if-shell')));
});

test('IF-18 hanging command and unusable executable remain unknown; no server is absent',async t=>{
  const f=await fixture(t);await fs.writeFile(f.flag,'1');
  const adapter=new SessionAdapter({tmux:f.options});
  await assert.rejects(adapter.isRunning({tmuxName:'zylos-group-origin'}),{code:'TMUX_UNAVAILABLE',cause:'timeout'});
  await assert.rejects(adapter.stop({tmuxName:'zylos-group-origin',expectedRunId:'guard-run'}),{code:'STOP_UNCONFIRMED',cause:'timeout'});
  const missing=new SessionAdapter({tmux:{socketPath:f.options.socketPath,binary:path.join(f.dir,'not-executable')}});
  await assert.rejects(missing.isRunning({tmuxName:'zylos-group-origin'}),{code:'TMUX_UNAVAILABLE',cause:'error'});
  const deniedBinary=path.join(f.dir,'denied-tmux');await fs.writeFile(deniedBinary,'#!/bin/sh\nexit 0\n',{mode:0o600});
  const denied=new SessionAdapter({tmux:{socketPath:f.options.socketPath,binary:deniedBinary}});
  await assert.rejects(denied.isRunning({tmuxName:'zylos-group-origin'}),{code:'TMUX_UNAVAILABLE',cause:'error'});
  await fs.unlink(f.flag);
  if(process.getuid?.()!==0){
    const originalMode=(await fs.stat(f.options.socketPath)).mode & 0o777;
    try{await fs.chmod(f.options.socketPath,0);await assert.rejects(adapter.isRunning({tmuxName:'zylos-group-origin'}),{code:'TMUX_UNAVAILABLE',cause:'error'});}
    finally{await fs.chmod(f.options.socketPath,originalMode);}
  }
  f.tmux('kill-server');
  assert.deepEqual(await adapter.isRunning({tmuxName:'zylos-group-origin'}),{tmux:false,process:false});
});

// P02-side caller harness: it consumes real resolver errors and real P01 ledger
// primitives. The harness itself chooses requeue/stale outcomes below; these
// assertions verify the provider errors and ledger primitives, NOT dispatcher
// routing. P04 must verify those choices through its real dispatcher integration.
for(const scenario of ['absent','missing-run','timeout'])test(`IF-13 first-resolution ${scenario}: provider zero sending and caller-selected real ledger outcomes`,async t=>{
  const f=await fixture(t);
  const initial=await openTmuxConnection(f.options);
  const bound=await resolveSessionTarget({sessionGroup:'origin',connection:initial});initial.close();
  const targetBinding=JSON.stringify({expectedRunId:bound.runId,tmuxTarget:{serverGeneration:bound.serverGeneration,sessionId:bound.tmuxSessionId,paneId:bound.paneId}});
  if(scenario==='absent')f.tmux('kill-session','-t','=zylos-group-origin');
  if(scenario==='missing-run')f.tmux('set-environment','-u','-t','=zylos-group-origin','ZYLOS_RUN_ID');
  if(scenario==='timeout')await fs.writeFile(f.flag,'1');
  const rows=[{kind:'conversation',row:c4.insertConversation('in','system',null,`guard-${scenario}`)},
    {kind:'targeted',row:c4.insertControl(`guard-${scenario}-targeted`,{sessionGroup:'origin',targetBinding,appendAckSuffix:false})},
    {kind:'control',row:c4.insertControl(`guard-${scenario}-control`,{sessionGroup:'origin',appendAckSuffix:false})}];
  for(const {kind,row} of rows){
    assert.equal(kind==='conversation'?c4.claimConversation(row.id):c4.claimControl(row.id),true);
    let connection,code,sends=0;
    try{connection=await openTmuxConnection(f.options);await resolveSessionTarget({sessionGroup:'origin',connection});sends++;}
    catch(error){code=error.code;}
    finally{connection?.close();}
    assert.equal(code,{absent:'TARGET_GONE','missing-run':'RUNID_MISMATCH',timeout:'TMUX_UNAVAILABLE'}[scenario]);assert.equal(sends,0);
    if(kind==='conversation')c4.requeueConversation(row.id);
    else if(kind==='targeted'&&code!=='TMUX_UNAVAILABLE')c4.failStaleTargetControl(row.id);
    else c4.requeueControl(row.id,code);
    const table=kind==='conversation'?'conversations':'control_queue';
    const saved=db.prepare(`SELECT status,retry_count FROM ${table} WHERE id=?`).get(row.id);
    assert.deepEqual(saved,{status:kind==='targeted'&&scenario!=='timeout'?'timeout':'pending',retry_count:0});
  }
  const calls=(await fs.readFile(f.calls,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.some(a=>a.join(' ').includes('paste-buffer')||a.join(' ').includes('send-keys')),false);
  if(scenario==='timeout'){
    await fs.unlink(f.flag);
    const connection=await openTmuxConnection(f.options);t.after(()=>connection.close());
    const target=await resolveSessionTarget({sessionGroup:'origin',connection});
    assert.deepEqual({serverGeneration:target.serverGeneration,sessionId:target.tmuxSessionId,paneId:target.paneId},JSON.parse(targetBinding).tmuxTarget);
    const adapter=new SessionAdapter();
    for(const {kind,row} of rows){
      assert.equal(kind==='conversation'?c4.claimConversation(row.id):c4.claimControl(row.id),true);
      await adapter.sendText({connection,target,text:`recovered-${kind}`});
      await adapter.sendKeys({connection,target,keys:['Enter']});
    }
    let received='';for(let i=0;i<50;i++){try{received=await fs.readFile(f.input,'utf8');}catch{}if(received.includes('recovered-control'))break;await delay(10);}
    assert.deepEqual(received.trim().split('\n'),['recovered-conversation','recovered-targeted','recovered-control']);
  }
});

test('IF-16 replacement between atomic identity and first guarded read rejects with D3 zero rows',async t=>{
  const f=await fixture(t),replaced=path.join(f.dir,'replaced');
  const beforeGeneration=f.tmux('display-message','-p','#{pid}:#{start_time}');
  const source=`#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process');const a=process.argv.slice(2);
const invoke=(args)=>cp.spawnSync(${JSON.stringify(actualBinary)},['-u','-S',${JSON.stringify(f.options.socketPath)},...args],{encoding:'utf8'});
if(a.includes('if-shell')&&!fs.existsSync(${JSON.stringify(replaced)})){
  invoke(['kill-server']);let result;
  for(let i=0;i<100;i++) {result=invoke(['-f','/dev/null','new-session','-d','-s','keeper','sleep 120']);if(result.status===0)break;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
  if(result.status!==0)process.exit(90);
  result=invoke(['new-session','-d','-s','zylos-group-origin','-e','ZYLOS_RUN_ID=guard-run','-e','ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}','-e','ZYLOS_SESSION_GROUP=origin','sleep 120']);
  if(result.status!==0)process.exit(91);fs.writeFileSync(${JSON.stringify(replaced)},'yes');
}
const r=cp.spawnSync(${JSON.stringify(actualBinary)},a,{stdio:'inherit'});process.exit(r.status??1);
`;
  await fs.writeFile(f.options.binary,source);
  const observer=createCoreObserver({tmux:{...f.options,timeoutMs:2000}});
  const {store,database}=bindingStore(t,observer);
  await assert.rejects(store.buildTargetBinding({sessionGroup:'origin',expectedRunId:'guard-run'}),{code:'TARGET_NOT_READY'});
  assert.equal(database.prepare('SELECT count(*) FROM control_queue').pluck().get(),0);
  assert.equal(await fs.readFile(replaced,'utf8'),'yes');
  assert.notEqual(f.tmux('display-message','-p','#{pid}:#{start_time}'),beforeGeneration);
  assert.equal(f.tmux('list-sessions','-F','#{session_name}').split('\n').sort().join(','),'keeper,zylos-group-origin');
});

test('IF-13 marker-looking pane content and message syntax are data, not guard output or commands',async t=>{
  const f=await fixture(t),connection=await openTmuxConnection(f.options);t.after(()=>connection.close());
  const target=await resolveSessionTarget({sessionGroup:'origin',connection}),adapter=new SessionAdapter();
  const marker=path.join(f.dir,'must-not-exist');
  const payload=`ZYLOS_STALE 999:1 ; run-shell 'touch ${marker}' ; $HOME \\ end`;
  await adapter.sendText({connection,target,text:payload});await adapter.sendKeys({connection,target,keys:['Enter']});
  let received='';for(let i=0;i<50;i++){try{received=await fs.readFile(f.input,'utf8');}catch{}if(received.includes(payload))break;await delay(10);}
  assert.equal(received.trim(),payload);
  const screen=await adapter.captureScreen({connection,target});assert.match(screen,/ZYLOS_STALE 999:1/);
  await assert.rejects(fs.stat(marker),{code:'ENOENT'});
  const calls=(await fs.readFile(f.calls,'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(a=>a.includes('-N')&&!a.includes('-C')&&!a.includes('-CC')),'Every generated probe/guard argv must be an ordinary no-start client');
  assert.equal(calls.some(a=>a.some(arg=>arg.includes(payload))),false,'Message body must never enter a tmux command string');
});

for(const method of ['sendText','sendKeys'])test(`IF-13 ${method} guarded command timeout uses its step error`,async t=>{
  const f=await fixture(t);
  // Setup starts a Node wrapper for every ordinary tmux read. Under parallel
  // suite load its startup can exceed the deliberately short fault deadline.
  f.options.timeoutMs=2000;
  const connection=await openTmuxConnection(f.options);t.after(()=>connection.close());
  const target=await resolveSessionTarget({sessionGroup:'origin',connection}),adapter=new SessionAdapter();
  f.options.timeoutMs=100; // Keep the actual injected hang deadline unchanged.
  await fs.writeFile(f.flag,'1');
  const started=performance.now();
  await assert.rejects(adapter[method]({connection,target,text:'never sent',keys:['Enter']}),{code:method==='sendText'?'PASTE_FAILED':'ENTER_UNVERIFIED',cause:'timeout'});
  assert.ok(performance.now()-started>=90,'injected command must reach its 100ms timeout');
  assert.equal(connection.closed,false);
  await fs.unlink(f.flag);
  f.options.timeoutMs=2000;
  await adapter[method]({connection,target,text:'retry on original target',keys:['Enter']});
});

test('IF-13 replacing the bound server blocks old text and keys from the new pane',async t=>{
  const f=await fixture(t),connection=await openTmuxConnection(f.options);t.after(()=>connection.close());
  const target=await resolveSessionTarget({sessionGroup:'origin',connection}),adapter=new SessionAdapter();
  f.tmux('kill-server');await delay(50);
  f.tmux('-f','/dev/null','new-session','-d','-s','keeper','sleep 120');
  f.tmux('new-session','-d','-s','zylos-group-origin','-e','ZYLOS_RUN_ID=guard-run',`exec cat > '${f.input}'`);
  for(const method of ['sendText','sendKeys'])await assert.rejects(adapter[method]({connection,target,text:'must-not-arrive',keys:['Enter']}),{code:'GENERATION_CHANGED'});
  await delay(25);assert.equal(await fs.readFile(f.input,'utf8'),'');
  // Direct ordinary commands below are a deliberately unsafe test control.
  // Reused IDs demonstrate that the preceding zero-input assertion is useful.
  assert.equal(f.tmux('display-message','-p','-t','=zylos-group-origin:','#{pane_id}'),target.paneId);
  f.tmux('send-keys','-t',target.paneId,'unsafe-control','Enter');
  let received='';for(let i=0;i<50;i++){received=await fs.readFile(f.input,'utf8');if(received)break;await delay(10);}
  assert.equal(received,'unsafe-control\n');
});
