import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeHealthCoordinator } from '../runtime-health.js';
import { SupervisorHealthObserver } from '../supervisor-health-observer.js';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'supervisor-health-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let clock=1792000000000,transition=null,manual=false,matches={},state={state:'idle',tools:[],sessionId:'session-a'},auth={status:'failure'};
  let scenes=[{sessionGroup:'telegram:a',runtime:'claude',runId:randomUUID(),ready:true,present:true,sessionId:'session-a'}];
  const controls=[],stops=[],events=[],interrupts=[],fences=new Map(),errors=[];
  const coordinator=new RuntimeHealthCoordinator({zylosDir:root,now:()=>clock,resolveTargetRuntime:()=> 'claude',listScenes:()=>scenes});
  const observer=new SupervisorHealthObserver({coordinator,now:()=>clock,listScenes:()=>scenes,
    readIdentity:g=>scenes.find(s=>s.sessionGroup===g),readState:()=>state,readScreen:()=>'',matchScreen:()=>matches,
    insertControl:(content,opts)=>{controls.push({id:controls.length+1,content,...opts,status:'pending'});return controls.at(-1);},
    getControlById:id=>controls[id-1],buildTargetBinding:s=>({runId:s.runId}),stop:async(s,validate)=>{if(!validate || await validate(s))stops.push(s);else return false;},
    getModeTransition:()=>transition,getDrainFence:g=>fences.get(g),manualPending:()=>manual,
    resolveToolRule:()=>({watchdog:{enabled:true,maxRuntimeSec:10,interruptKey:'Escape',interruptGraceSec:5,cooldownSec:2}}),
    nudge:async(s,validate)=>{if(!await validate(s))return {ok:false};interrupts.push({s});return {ok:true};},checkAuth:()=>auth,diagnostic:e=>events.push(e),log:e=>errors.push(e)});
  coordinator.probeInFlight=r=>observer.probeInFlight(r);
  return {coordinator,observer,controls,stops,events,interrupts,fences,errors,now:()=>clock,advance:ms=>clock+=ms,
    scene:()=>scenes[0],scenes:()=>scenes,setScenes:v=>scenes=v,setTransition:v=>transition=v,setManual:v=>manual=v,
    setState:v=>state={tools:[],sessionId:scenes[0]?.sessionId,state:v.tools?.length?'busy':'idle',...v},setMatches:v=>matches=v,setAuth:v=>auth=v,
    health:()=>coordinator.store('claude').read(),setHealth:health=>{const s=coordinator.store('claude').read();s.health=health;s.reason='';coordinator.store('claude').write(s);},
    delivered:(extra={})=>observer.notifyDelivered({...scenes[0],pastedAt:clock,...extra}),
    prepared:async()=>{for(let i=0;i<30 && [...observer.probes.values()].some(p=>p.preparing);i++)await new Promise(resolve=>setImmediate(resolve));}};
}

test('AI work permanently disarms a paste and only a later paste arms another observation',async t=>{
  const f=fixture(t);f.delivered();f.advance(1);f.setState({lastResponseAt:f.now()});await f.observer.tick();
  assert.equal(f.observer.sceneState(f.scene()).delivery.noResponseEligible,false);
  f.advance(1800000);await f.observer.tick();assert.equal(f.interrupts.length,0);
  f.delivered();f.advance(900000);await f.observer.tick();assert.equal(f.interrupts.length,1);
  f.advance(1);f.setState({lastResponseAt:f.now()});await f.observer.tick();
  f.advance(1800000);await f.observer.tick();assert.equal(f.interrupts.length,1);assert.equal(f.stops.length,0);
});
test('pane rate needs two delivered hits and auth requires failed checkAuth',async t=>{
  const f=fixture(t);f.delivered();f.setMatches({rateLimit:{detected:true}});f.advance(5000);await f.observer.tick();assert.equal(f.health().health,'ok');
  f.advance(1);f.delivered();f.advance(5000);await f.observer.tick();assert.equal(f.health().health,'rate_limited');
  f.setHealth('ok');f.setMatches({authFailure:{detected:true}});f.setAuth({status:'uncertain'});f.advance(1);f.delivered();f.advance(5000);await f.observer.tick();assert.equal(f.health().health,'ok');
  f.setAuth({status:'failure'});f.advance(1);f.delivered();f.advance(5000);await f.observer.tick();assert.equal(f.health().health,'auth_failed');
});

test('committed control remains single-flight when subsequent health budget write fails',async t=>{
  const f=fixture(t);f.setHealth('unavailable');f.coordinator.markProbeQueued=()=>{throw new Error('disk failure');};
  const p=f.observer.requestProbe('claude');await f.prepared();assert.equal(f.observer.requestProbe('claude'),p);assert.equal(f.controls.length,1);
  f.controls[0].status='done';await f.observer.tick();assert.equal((await p).recovered,true);assert.equal(f.errors.length,1);
});

test('fresh activity at stop admission cancels restart',async t=>{
  const f=fixture(t);f.delivered();f.advance(900000);await f.observer.tick();
  f.observer.stop=async(scene,validate)=>{
    f.setState({lastSubagentActivityAt:f.now(),lastResponseAt:f.now()});
    if(await validate(scene))f.stops.push(scene);else return false;
  };
  f.advance(180000);await f.observer.tick();assert.equal(f.stops.length,0);
});

test('unrelated activity does not exempt a web tool that remains past its fallback deadline',async t=>{
  const f=fixture(t);const tools=[{id:'web',name:'WebFetch',startedAt:f.now()-11000}];
  f.setState({tools});await f.observer.tick();f.advance(5001);
  f.setState({tools,lastSubagentActivityAt:f.now()});await f.observer.tick();
  assert.equal(f.stops.length,1);assert.equal(f.interrupts.length,1);
});

test('a replacement run is not owned by the previous run\'s episode',{ timeout: 5000 },async t=>{
  const f=fixture(t);f.delivered();f.advance(900000);await f.observer.tick();assert.equal(f.interrupts.length,1);
  const replacement={...f.scene(),runId:randomUUID()};f.setScenes([replacement]);
  assert.equal(f.observer.noResponseActive(replacement),false);
  f.setHealth('unavailable');const probe=f.observer.requestProbe('claude');await f.prepared();
  assert.equal(f.controls.length,1);assert.equal(f.controls[0].targetBinding.runId,replacement.runId);
  f.controls[0].status='done';await f.observer.tick();assert.equal((await probe).recovered,true);
});

const failedDelivery = f => ({ ...f.scene(), conversationId: 42, pastedAt: f.now() - 1 });

test('terminal unverified delivery stops its silent run once, including concurrent duplicate facts', async t => {
  const f = fixture(t), fact = failedDelivery(f);
  const results = await Promise.all([f.observer.notifyDeliveryFailed(fact), f.observer.notifyDeliveryFailed(fact)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(f.stops.length, 1);
  assert.equal(await f.observer.notifyDeliveryFailed(fact), false);
  assert.equal(f.stops.length, 1);
  assert.equal(f.events.at(-1).event, 'delivery_failure_restart');
  assert.equal(f.events.at(-1).conversation_id, 42);
});

