import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSupervisor } from '../supervisor.js';
import { RestartRequestStore } from '../restart-request-store.js';
import { PENDING_MAX_AGE_SECONDS } from '../../../comm-bridge/scripts/c4-config.js';
import { fixture as databaseFixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { SupervisorAdmission } from '../supervisor-admission.js';
import { MANUAL_WAKE_PROMPT } from '../origin-prompts.js';
import { startSupervisor } from '../supervisor-main.js';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'origin-auth-'));
  const state={now:1800000000000,oldestAt:null,controls:0,pending:[],fences:[],transition:null,mode:'multi',scenes:[],checks:[],alerts:[],queued:[]};
  const db={getModeTransition:()=>state.transition,getDrainFence:group=>state.fences.find(f=>f.sessionGroup===group)??null,
    listDrainFences:()=>state.fences,listPendingSessionGroups:()=>state.pending,listPendingContinuations:()=>[],
    getOriginNeed:()=>({controls:{count:state.controls},inbound:{oldestAt:state.oldestAt}}),
    insertControl:(content,options)=>{const row={id:state.queued.length+1,status:'pending',content,...options};state.queued.push(row);return row;},getControlById:()=>null};
  const scenes={observe:()=>state.scenes,readIdentity:group=>state.scenes.find(s=>s.sessionGroup===group)??{present:false},
    observeGroup:()=>({present:false}),listRuns:()=>state.scenes,bindTarget:scene=>({runtime:scene.runtime,runId:scene.runId})};
  const owner=createSupervisor({db,scenes,zylosDir:root,env:{ZYLOS_DIR:root},now:()=>state.now,
    readMode:()=>({mode:state.mode}),readConfiguration:()=>({mode:state.mode,runtime:'claude'}),resolveTargetRuntime:()=> 'claude',
    requestStore:new RestartRequestStore({file:path.join(root,'requests.json')}),
    checkAuth:runtime=>{state.checks.push(runtime);return {status:'failure'};},alert:event=>state.alerts.push(event),
    loopOptions:{schedule:()=>1,cancel(){}}});
  t.after(async()=>{await owner.stop();fs.rmSync(root,{recursive:true,force:true});});
  const health=value=>{const store=owner.health.store('claude'),h=store.read();h.health=value;h.reason=value==='auth_failed'?'authentication_failed':'';store.write(h);};
  health('auth_failed');
  return {owner,state,health,db,start:()=>owner.loop.deps.readConfiguration(),tick:()=>owner.loop.deps.writeMetricsAndMaintain({scenes:state.scenes,fences:state.fences,transition:state.transition})};
}

test('Origin inbound expiry warning observes the threshold and resets only after authentication health changes',async t=>{
  const f=fixture(t);await f.start();
  f.state.oldestAt=f.state.now/1000-(PENDING_MAX_AGE_SECONDS-301);
  await f.tick();assert.equal(f.state.alerts.length,0);
  f.state.now+=1000;await f.tick();await f.tick();assert.equal(f.state.alerts.length,1);
  assert.deepEqual(f.state.alerts[0],{event:'origin_auth_blocked',runtime:'claude',oldest_at:f.state.oldestAt});
  f.state.transition={phase:'cutover'};f.health('ok');await f.tick();f.health('auth_failed');f.state.transition=null;
  await f.tick();assert.equal(f.state.alerts.length,1,'transition does not clear the episode');
  f.health('ok');await f.tick();f.health('auth_failed');await f.tick();assert.equal(f.state.alerts.length,2);
});

// Real entry -> Origin demand/health -> owner alert text. Run for entry alert
// formatting or wiring; skip unrelated lifecycle work. The runner isolates HOME,
// ZYLOS_DIR, PM2_HOME and short TMPDIR/TMUX_TMPDIR. Private am.sock, injected
// scenes/database/sender; no live tmux/PM2/network. Stop before owned-file cleanup.
test('Origin authentication expiry alert includes its target runtime in the actual entry message', {timeout:5000}, async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'origin-alert-entry-'));
  const now=1800000000000,oldestAt=now/1000-PENDING_MAX_AGE_SECONDS+300,messages=[];
  let service;
  t.after(async()=>{try{await service?.stop();}finally{fs.rmSync(root,{recursive:true,force:true});}});
  const db={getModeTransition:()=>null,listDrainFences:()=>[],getDrainFence:()=>null,
    listPendingSessionGroups:()=>[],listPendingContinuations:()=>[],listRunEndings:()=>[],
    listSlotOccupancy:()=>[],pruneSlots:()=>({deletedHeld:0,deletedOrphans:[]}),
    getLastCompletedModeTransition:()=>null,getControlById:()=>null,
    getOriginNeed:()=>({inbound:{count:1,oldestAt},controls:{count:0,oldestAt:null}}),
    getOriginSyncBacklog:()=>({total:0,groups:[]}),
    resolveSessionLaunchConfig:()=>({runtime:'claude',mode:'default'})};
  const scenes={observe:async()=>[],readIdentity:async()=>({present:false}),
    observeGroup:async()=>({present:false}),listRuns:async()=>[],readRun:async()=>null};
  service=await startSupervisor({env:{...process.env,HOME:root,ZYLOS_DIR:root,PM2_HOME:path.join(root,'.pm2')},
    db,scenes,now:()=>now,readMode:()=>({mode:'multi',keyPresent:true}),
    readConfig:()=>({session_mode:'multi',runtime:'claude',session_pool_size:2}),
    readMemoryInputs:async()=>({source:'host',limitBytes:8*1024**3,usedBytes:2*1024**3}),
    legacyStatus:{tick(){},close(){}},machineTasks:{tick(){},stop(){}},
    sendAlert:async(target,message)=>{messages.push({target,message});return true;},
    log:()=>{},loopOptions:{schedule:()=>1,cancel(){}}});
  const store=service.supervisor.health.store('claude'),health=store.read();
  health.health='auth_failed';health.reason='authentication_failed';store.write(health);
  await service.supervisor.loop.tick();
  assert.equal(messages.length,1);
  assert.deepEqual(messages[0].target,{channel:'web-console',endpoint:'console'});
  assert.match(messages[0].message,/origin_auth_blocked/);
  assert.match(messages[0].message,/runtime=claude/);
  assert.ok(messages[0].message.includes(`oldest_at=${oldestAt}`));
});

test('role-only demand, rate limit, global fence, transition and single mode never emit an authentication expiry warning',async t=>{
  const f=fixture(t);await f.start();f.state.controls=1;await f.tick();assert.equal(f.state.alerts.length,0);
  f.state.oldestAt=f.state.now/1000-PENDING_MAX_AGE_SECONDS;
  f.health('rate_limited');await f.tick();assert.equal(f.state.alerts.length,0);
  f.health('auth_failed');f.state.fences=[{sessionGroup:'*'}];await f.tick();
  f.state.fences=[];f.state.transition={phase:'gating'};await f.tick();
  f.state.transition=null;f.state.mode='single';await f.start();await f.tick();assert.equal(f.state.alerts.length,0);
});

test('Origin role control demand retries authentication on the ordinary pending cadence and respects both fences',async t=>{
  for(const roleOnly of [false,true]) {
    const f=fixture(t);await f.start();
    if(roleOnly)f.state.controls=1;else f.state.pending=[{sessionGroup:'chat:ordinary'}];
    await f.tick();for(let i=0;i<59;i++){f.state.now+=1000;await f.tick();}
    assert.equal(f.state.checks.length,1);f.state.now+=1000;await f.tick();assert.equal(f.state.checks.length,2);
  }
  const f=fixture(t);await f.start();await f.tick();assert.equal(f.state.checks.length,0,'bound controls are excluded by getOriginNeed');
  f.state.controls=1;
  for(const sessionGroup of ['origin','*']){f.state.fences=[{sessionGroup}];await f.tick();assert.equal(f.state.checks.length,0);}
  f.state.fences=[];await f.tick();assert.equal(f.state.checks.length,1);
});

test('Origin role control demand drives a recovery heartbeat on another ready group of the target runtime',async t=>{
  const f=fixture(t);await f.start();f.health('rate_limited');f.state.controls=1;
  f.state.scenes=[{sessionGroup:'chat:ready',runtime:'claude',runId:'ready-run',runDir:f.owner.health.zylosDir,ready:true,present:true}];
  await f.tick();while(f.owner.observer.preparations.size)await Promise.all([...f.owner.observer.preparations]);
  assert.equal(f.state.queued.length,1);assert.match(f.state.queued[0].content,/Heartbeat check/);
  assert.equal(f.state.queued[0].sessionGroup,'chat:ready');assert.equal(f.state.queued[0].targetBinding.runId,'ready-run');
});

test('real C4 bound controls do not drive Origin auth checks, while repeated absent-Origin wakes leave one pending demand',async t=>{
  const f=fixture(t),{db,store}=databaseFixture(t);await f.start();
  f.db.getOriginNeed=store.getOriginNeed;
  store.insertControl('Current run preparation',{sessionGroup:'origin',targetBinding:{expectedRunId:'old-run',tmuxTarget:{serverGeneration:'1:2',sessionId:'$1',paneId:'%1'}},appendAckSuffix:false});
  assert.equal(store.getOriginNeed(f.state.now/1000).controls.count,0);await f.tick();assert.equal(f.state.checks.length,0);
  const admission=new SupervisorAdmission({db:store,store:{read:()=>[]},readMode:()=>({mode:'multi'}),readRun:()=>null});admission.openEntry();
  for(let i=0;i<2;i++)assert.equal((await admission.handle({version:1,type:'manual_restart',requestId:`wake-${i}`})).result,'already_stopped');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM control_queue WHERE status = ? AND content = ?').get('pending',MANUAL_WAKE_PROMPT).n,1);
  assert.equal(store.getOriginNeed(f.state.now/1000).controls.count,1);await f.tick();assert.equal(f.state.checks.length,1);
});

// Real Supervisor/Store and private memory DB, injected clock/scene/auth. Run
// for Origin continuation demand changes; skip unrelated lifecycle. Official
// runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; no real tmux/PM2/network.
// Fixture stops Supervisor and closes DB; no independent background loop.
test('only an Origin restart marker drives authentication demand until clearing without an inbound expiry alert', async t => {
  const f=fixture(t), {store}=databaseFixture(t,{now:()=>f.state.now});
  f.db.getOriginNeed=store.getOriginNeed;
  await f.start(); await f.tick(); assert.equal(f.state.checks.length,0);
  store.recordRunEnd('origin',{runId:'old-origin',reason:'unexpected'});
  assert.deepEqual(store.getOriginNeed().continuation,{pending:true,oldestAt:f.state.now/1000});
  for(const sessionGroup of ['origin','*']) {
    f.state.fences=[{sessionGroup}]; await f.tick(); assert.equal(f.state.checks.length,0);
  }
  f.state.fences=[]; await f.tick(); assert.deepEqual(f.state.checks,['claude']);
  f.state.now+=60000; await f.tick(); assert.equal(f.state.checks.length,2);
  f.state.now+=PENDING_MAX_AGE_SECONDS*1000; await f.tick(); assert.equal(f.state.checks.length,3);
  assert.equal(f.state.alerts.length,0);
  assert.equal(store.clearContinuation('origin',{runId:'new-origin'}).cleared,true);
  f.state.now+=60000; await f.tick(); assert.equal(f.state.checks.length,3);
  assert.equal(f.state.alerts.length,0);
});
