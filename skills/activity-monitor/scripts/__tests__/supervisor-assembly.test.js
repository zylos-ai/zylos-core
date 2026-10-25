import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSupervisor } from '../supervisor.js';
import { RestartRequestStore } from '../restart-request-store.js';
function fixture(t,{badRequests=false,readMode=()=>({mode:'multi'}),resolveLaunchConfig=()=>({runtime:'claude',mode:'default'}),consumeHealthEvents,checkAuth=async()=>({status:'uncertain'})}={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'supervisor-assembly-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'requests.json');if(badRequests)fs.writeFileSync(file,'broken');
 const calls=[],db={getModeTransition:()=>null,listDrainFences:()=>[],getDrainFence:()=>null,listPendingSessionGroups:()=>[],getControlById:()=>null,resolveSessionLaunchConfig:resolveLaunchConfig};
 const scenes={observe:async()=>[],observeGroup:async()=>({present:false}),listRuns:async()=>[],readRun:async()=>null};
 const supervisor=createSupervisor({db,scenes,zylosDir:root,env:{ZYLOS_DIR:root},readConfiguration:async()=>({mode:'multi',runtime:'claude',capacity:2}),readMode,resolveTargetRuntime:async()=> 'claude',requestStore:new RestartRequestStore({file}),consumeHealthEvents,checkAuth,log:item=>calls.push(item),loopOptions:{schedule:()=>1,cancel:()=>{}}});
 t.after(()=>supervisor.stop());return {supervisor,calls,file,root,scenes};
}
test('T01 assembly: restore health before admission; no-launch empty round executes',async t=>{
 const {supervisor}=fixture(t);assert.equal(supervisor.admission.open,false);await supervisor.loop.start();assert.equal(supervisor.admission.open,true);assert.equal(supervisor.health.stores.size,2);
 const reply=await supervisor.admission.handle({version:1,type:'restart_all',requestId:'empty',reason:'upgrade'});assert.equal(reply.result,'done_empty');
});
test('DM-54 assembly: damaged F9 retained while existing lifecycle loop stays scheduled',async t=>{
 const {supervisor,calls,file}=fixture(t,{badRequests:true});await supervisor.loop.start();assert.equal(supervisor.admission.open,true);assert.equal(fs.readFileSync(file,'utf8'),'broken');assert.ok(calls.some(row=>row.error==='requests_unreadable'));
 const reply=await supervisor.admission.handle({version:1,type:'restart_all',requestId:'bad',reason:'upgrade'});assert.equal(reply.code,'requests_unreadable');assert.equal(fs.readFileSync(file,'utf8'),'broken');
});


async function capturedAuthRecovery(supervisor,runtime='claude') {
 const store=supervisor.health.store(runtime),state=store.read();
 state.health='auth_failed';state.reason='authentication_failed';store.write(state);
 await supervisor.health.beginAuthRecovery(runtime,{status:'success'},[]);
}

test('IF-31 assembly: unwritable diagnostic output cannot block completed authentication recovery',async t=>{
 const {supervisor,calls,root}=fixture(t);
 await supervisor.loop.deps.readConfiguration();
 await capturedAuthRecovery(supervisor);
 // A directory at the file path fails actual append and rotation without needing
 // privilege-sensitive chmod assumptions (the test may run as root).
 fs.mkdirSync(path.join(root,'activity-monitor','pool-metrics.jsonl'),{recursive:true});
 await supervisor.loop.deps.writeMetricsAndMaintain({});
 assert.equal(supervisor.health.store('claude').read().health,'ok');
 assert.equal(supervisor.health.authRecoveries.has('claude'),false);
 assert.ok(calls.some(row=>row.phase==='pool-metrics'));
 assert.ok(calls.some(row=>row.phase==='log-maintenance'));
});

test('T01/T02 assembly: one failed probe poll cannot starve another runtime or auth recovery',async t=>{
 const {supervisor,calls}=fixture(t);
 await supervisor.loop.deps.readConfiguration();await capturedAuthRecovery(supervisor,'codex');
 const polled=[];
 supervisor.observer.probes.set('claude',{runtime:'claude',resolve:()=>{}});
 supervisor.observer.probes.set('codex',{runtime:'codex',resolve:()=>{}});
 supervisor.observer.pollProbe=async probe=>{polled.push(probe.runtime);if(probe.runtime==='claude')throw Object.assign(new Error('pane unreadable'),{code:'TMUX_UNAVAILABLE'});};
 await supervisor.loop.deps.writeMetricsAndMaintain({});
 assert.deepEqual(polled,['claude','codex']);
 assert.equal(supervisor.health.store('codex').read().health,'ok');
 assert.ok(calls.some(row=>row.phase==='recovery-probe' && row.runtime==='claude'));
});


test('T01/IB-41 assembly: config reclaim resolves mode at admission, after F1 cutover',async t=>{
 let mode='single';const selected=[];
 const {supervisor}=fixture(t,{readMode:()=>({mode}),resolveLaunchConfig:input=>{selected.push(input);return {runtime:'claude',mode:'default'};}});
 await supervisor.loop.deps.readConfiguration();
 await supervisor.admission.resolveLaunchConfig('chat:A');mode='multi';
 await supervisor.admission.resolveLaunchConfig('chat:A');
 assert.deepEqual(selected,[{sessionGroup:'chat:A',sessionMode:'single'},{sessionGroup:'chat:A',sessionMode:'multi'}]);
});

test('T02/T08 assembly: stopped, unknown, or no-longer-ready processes cannot refresh F4',async t=>{
 const {supervisor,scenes,root}=fixture(t);
 const scene={sessionGroup:'chat:A',runtime:'claude',runId:'r',sessionId:'s',runDir:root,createdAt:100,ready:true,present:true,processRunning:true};
 const file=path.join(root,'agent-status.json');fs.writeFileSync(file,'prior state');let observations=0;
 let current=scene;scenes.observeGroup=async()=>{observations++;return current;};
 await supervisor.loop.deps.probeAndPublish({...scene,processRunning:false},{});
 await supervisor.loop.deps.probeAndPublish({...scene,processRunning:undefined},{});
 assert.equal(observations,0);
 for(const change of [{processRunning:false},{processRunning:undefined},{ready:false}]){
  current={...scene,...change};await supervisor.loop.deps.probeAndPublish(scene,{});
  assert.equal(fs.readFileSync(file,'utf8'),'prior state');
 }
 current=scene;await supervisor.loop.deps.probeAndPublish(scene,{});
 assert.equal(JSON.parse(fs.readFileSync(file)).runId,'r');
});


test('T02/T08 assembly: hooks use freshly observed PID and F4 never republishes a replaced process sample',async t=>{
 const consumed=[];let current,replaceDuringConsume=false;
 const {supervisor,scenes,root}=fixture(t,{consumeHealthEvents:async scene=>{
  consumed.push(scene.runtimePid);
  if(replaceDuringConsume)current={...current,runtimePid:3,proc:{pid:3,alive:true}};
 }});
 const original={sessionGroup:'chat:A',runtime:'claude',runId:'r',sessionId:'s',runDir:root,createdAt:100,ready:true,present:true,processRunning:true,runtimePid:1,proc:{pid:1,alive:true}};
 current={...original,runtimePid:2,proc:{pid:2,alive:true}};
 scenes.observeGroup=async()=>current;
 await supervisor.loop.deps.probeAndPublish(original,{});
 const file=path.join(root,'agent-status.json'),saved=fs.readFileSync(file,'utf8');
 assert.deepEqual(consumed,[2]);assert.equal(JSON.parse(saved).proc.pid,2);
 replaceDuringConsume=true;await supervisor.loop.deps.probeAndPublish(original,{});
 assert.deepEqual(consumed,[2,2]);assert.equal(fs.readFileSync(file,'utf8'),saved);
});


test('T01 shutdown: accepted lifecycle mutation finishes before Supervisor stop resolves',async t=>{
 const {supervisor}=fixture(t);supervisor.admission.openEntry();
 let release,entered;const running=new Promise(resolve=>{entered=resolve;});
 const barrier=new Promise(resolve=>{release=resolve;});let written=false;
 const accepted=supervisor.admission.serialize(async()=>{entered();await barrier;written=true;});
 await running;let stopped=false;const stopping=supervisor.stop().then(()=>{stopped=true;});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(supervisor.admission.open,false);assert.equal(stopped,false);assert.equal(written,false);
 release();await accepted;await stopping;assert.equal(written,true);assert.equal(stopped,true);
});


test('T01 shutdown: detached route auth and accepted health writes drain before return',async t=>{
 let releaseAuth,enteredAuth;const authEntered=new Promise(resolve=>{enteredAuth=resolve;});
 const authBarrier=new Promise(resolve=>{releaseAuth=resolve;});
 const {supervisor}=fixture(t,{checkAuth:async()=>{enteredAuth();await authBarrier;return {status:'success'};}});
 const auth=supervisor.router.checkAuth('claude');await authEntered;
 let releaseWrite,written=false;const writeBarrier=new Promise(resolve=>{releaseWrite=resolve;});
 const queued=supervisor.health.serial('codex',async()=>{await writeBarrier;written=true;});
 let stopped=false;const stopping=supervisor.stop().then(()=>{stopped=true;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);
 releaseAuth();await auth;await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);
 releaseWrite();await queued;await stopping;
 assert.equal(written,true);assert.equal(supervisor.health.queues.size,0);
 assert.equal(supervisor.health.authRecoveries.size,0);
 assert.equal((await supervisor.router.checkAuth('claude')).reason,'supervisor_stopping');
});
