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
  let clock=1792000000000,mode='multi',transition=null,manual=false,matches={},state={tools:[]},auth={status:'failure'};
  let scenes=[{sessionGroup:'telegram:a',runtime:'claude',runId:randomUUID(),ready:true,present:true,sessionId:'session-a'}];
  const controls=[],stops=[],events=[],interrupts=[],fences=new Map(),errors=[];
  const coordinator=new RuntimeHealthCoordinator({zylosDir:root,now:()=>clock,readMode:()=>mode,resolveTargetRuntime:()=> 'claude',listScenes:()=>scenes});
  const observer=new SupervisorHealthObserver({coordinator,now:()=>clock,listScenes:()=>scenes,readMode:()=>mode,
    readIdentity:g=>scenes.find(s=>s.sessionGroup===g),readState:()=>state,readScreen:()=>'',matchScreen:()=>matches,
    insertControl:(content,opts)=>{controls.push({id:controls.length+1,content,...opts,status:'pending'});return controls.length;},
    getControlById:id=>controls[id-1],buildTargetBinding:s=>({runId:s.runId}),stop:s=>stops.push(s),
    getModeTransition:()=>transition,getDrainFence:g=>fences.get(g),manualPending:()=>manual,
    resolveToolRule:()=>({watchdog:{enabled:true,maxRuntimeSec:10,interruptKey:'Escape',interruptGraceSec:5,cooldownSec:2}}),
    interrupt:(s,key)=>{interrupts.push({s,key});return {ok:true};},checkAuth:()=>auth,diagnostic:e=>events.push(e),log:e=>errors.push(e)});
  coordinator.probeInFlight=r=>observer.probeInFlight(r);
  return {coordinator,observer,controls,stops,events,interrupts,fences,errors,now:()=>clock,advance:ms=>clock+=ms,
    scene:()=>scenes[0],scenes:()=>scenes,setScenes:v=>scenes=v,setMode:v=>mode=v,setTransition:v=>transition=v,setManual:v=>manual=v,
    setState:v=>state={tools:[],...v},setMatches:v=>matches=v,setAuth:v=>auth=v,
    health:()=>coordinator.store('claude').read(),setHealth:health=>{const s=coordinator.store('claude').read();s.health=health;s.reason='';coordinator.store('claude').write(s);},
    delivered:(extra={})=>observer.notifyDelivered({...scenes[0],pastedAt:clock,...extra}),
    prepared:async()=>{for(let i=0;i<30 && [...observer.probes.values()].some(p=>p.preparing);i++)await new Promise(resolve=>setImmediate(resolve));}};
}
test('runtime coalescing prefers Origin and binds finite priority-zero recovery',async t=>{
  const f=fixture(t);f.setHealth('rate_limited');f.setScenes([...f.scenes(),{...f.scene(),sessionGroup:'origin',runId:randomUUID()}]);
  const a=f.observer.requestProbe('claude'),b=f.observer.requestProbe('claude');assert.equal(a,b);await f.prepared();
  assert.equal(f.controls.length,1);assert.equal(f.controls[0].sessionGroup,'origin');assert.equal(f.controls[0].priority,0);assert.equal(f.controls[0].bypassState,true);assert.equal(f.controls[0].ackDeadlineAt,f.now()/1000+120);
  f.controls[0].status='done';await f.observer.tick();assert.equal((await a).recovered,true);assert.equal(f.health().health,'ok');
});
test('fenced scene sends nothing and replacement invalidates old successful control',async t=>{
  const f=fixture(t);f.setHealth('unavailable');f.fences.set('*',{});assert.equal((await f.observer.requestProbe('claude')).recovered,false);assert.equal(f.controls.length,0);
  f.fences.clear();const p=f.observer.requestProbe('claude');await f.prepared();f.setScenes([{...f.scene(),runId:randomUUID()}]);f.controls[0].status='done';await f.observer.tick();assert.equal((await p).stale,true);assert.equal(f.health().health,'unavailable');assert.equal(f.stops.length,0);
});
test('failure classifies rate before auth; other stops only bound scene',async t=>{
  const f=fixture(t);f.setHealth('rate_limited');f.setMatches({rateLimit:{detected:true},authFailure:{detected:true}});
  let p=f.observer.requestProbe('claude');await f.prepared();f.controls[0].status='timeout';await f.observer.tick();assert.equal((await p).classification,'rate_limited');assert.equal(f.stops.length,0);
  f.advance(3600000);f.setMatches({});p=f.observer.requestProbe('claude');await f.prepared();f.controls[1].status='failed';await f.observer.tick();assert.equal((await p).classification,'other');assert.equal(f.health().health,'unavailable');assert.equal(f.stops[0].runId,f.scene().runId);
});
test('elapsed local deadline cannot manufacture a terminal acknowledgement',async t=>{
  const f=fixture(t);f.setHealth('unavailable');const p=f.observer.requestProbe('claude');await f.prepared();f.advance(130000);await f.observer.tick();assert.equal(f.observer.probeInFlight('claude'),true);assert.equal(f.stops.length,0);f.controls[0].status='done';await f.observer.tick();assert.equal((await p).recovered,true);
});
test('duplicate and older delivery notifications do not replace the current timer',async t=>{
  const f=fixture(t);f.delivered({pastedAt:f.now()-599000});await f.observer.tick();assert.equal(f.stops.length,0);f.delivered({pastedAt:f.now()-599000});f.delivered({pastedAt:f.now()-600000});f.advance(1000);await f.observer.tick();assert.equal(f.events[0].event,'no_response_detected');
});
test('prior own-session event or transcript response wins; single has no no-response timeout',async t=>{
  for(const evidence of ['event','transcript','single']) {const f=fixture(t);if(evidence==='single')f.setMode('single');f.delivered({pastedAt:f.now()-601000});f.setState(evidence==='event'?{sessionId:f.scene().sessionId,lastActivityAt:f.now()-600000}:{transcriptMtimeMs:evidence==='transcript'?f.now()-600000:0});await f.observer.tick();assert.equal(f.stops.length,0);}
});
test('tools pause no-response; real completion resumes accumulated time',async t=>{
  const f=fixture(t);f.observer.resolveToolRule=()=>null;f.delivered();f.advance(590000);await f.observer.tick();f.setState({tools:[{id:'tool',startedAt:f.now(),name:'Bash'}]});await f.observer.tick();f.advance(500000);await f.observer.tick();f.setState({tools:[]});await f.observer.tick();assert.equal(f.stops.length,0);f.advance(10000);await f.observer.tick();assert.equal(f.events.at(-1).event,'no_response_detected');
});
test('sticky needs distinct delivered checks over 30 seconds and a delivered miss resets',async t=>{
  const f=fixture(t);f.delivered();f.setMatches({apiError:{detected:true}});f.advance(5000);await f.observer.tick();
  f.advance(24000);f.delivered();f.advance(5000);await f.observer.tick();assert.equal(f.stops.length,0);
  f.advance(1);f.setMatches({});f.delivered();f.advance(5000);await f.observer.tick();
  f.advance(1);f.setMatches({apiError:{detected:true}});f.delivered();f.advance(5000);await f.observer.tick();
  f.advance(25000);f.delivered();f.advance(5000);await f.observer.tick();assert.equal(f.events[0].event,'sticky_context_restart');assert.equal(f.health().health,'ok');
});
test('transition and accepted Origin manual request suppress pending health kills',async t=>{
  const f=fixture(t);f.setScenes([{...f.scene(),sessionGroup:'origin'}]);f.delivered({pastedAt:f.now()-601000});f.setTransition({phase:'gating'});await f.observer.tick();assert.equal(f.stops.length,0);f.setTransition(null);f.setManual(true);await f.observer.tick();assert.equal(f.stops.length,0);f.setManual(false);await f.observer.tick();assert.equal(f.stops.length,1);
});
test('watchdog waits interrupt grace without synthesizing tool completion',async t=>{
  const f=fixture(t);f.setState({tools:[{id:'one',name:'Bash',startedAt:f.now()-11000}]});await f.observer.tick();assert.equal(f.interrupts.length,1);f.advance(5000);await f.observer.tick();assert.equal(f.stops.length,0);f.advance(1);await f.observer.tick();assert.equal(f.events[0].event,'tool_timeout_Bash');assert.equal(f.health().health,'ok');
});
test('freeze requires active tool and unchanged known context switches for 60 seconds',async t=>{
  const f=fixture(t);f.observer.resolveToolRule=()=>null;f.setState({tools:[{id:'one'}],contextSwitches:10});await f.observer.tick();f.advance(59000);await f.observer.tick();assert.equal(f.stops.length,0);f.setState({tools:[{id:'one'}],contextSwitches:11});await f.observer.tick();f.advance(60000);await f.observer.tick();assert.equal(f.events[0].event,'process_frozen');assert.equal(f.health().health,'ok');
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

test('failed recovery stop retries original scene after transition guard clears',async t=>{
  const f=fixture(t);f.setHealth('unavailable');const p=f.observer.requestProbe('claude');await f.prepared();f.controls[0].status='timeout';f.setTransition({phase:'gating'});
  await f.observer.tick();assert.equal((await p).classification,'other');assert.equal(f.stops.length,0);
  f.setTransition(null);await f.observer.tick();assert.equal(f.stops.length,1);assert.equal(f.stops[0].runId,f.scene().runId);
});

test('unordered hook verification keeps baseline on-demand check even while currently healthy',async t=>{
  const f=fixture(t);const p=f.observer.requestVerification('claude');await f.prepared();assert.equal(f.controls.length,1);assert.match(f.controls[0].content,/phase=hook_evidence_unordered/);assert.equal(f.controls[0].ackDeadlineAt,f.now()/1000+300);
  f.controls[0].status='done';await f.observer.tick();assert.equal((await p).recovered,true);await f.observer.requestVerification('claude');assert.equal(f.controls.length,1);
});

test('successful recovery suppresses its unchanged error pane without suppressing another session',async t=>{
  const f=fixture(t);f.setHealth('rate_limited');f.observer.readScreen=()=> 'old limit pane';f.setMatches({rateLimit:{detected:true}});
  const p=f.observer.requestProbe('claude');await f.prepared();f.controls[0].status='done';await f.observer.tick();await p;
  f.delivered();f.advance(5000);await f.observer.tick();await f.observer.tick();assert.equal(f.health().health,'ok');
  f.setScenes([{...f.scene(),sessionId:'different-session',runId:randomUUID()}]);f.delivered();f.advance(5000);await f.observer.tick();f.advance(1);f.delivered();f.advance(5000);await f.observer.tick();assert.equal(f.health().health,'rate_limited');
});

test('shutdown: blocked probe preparation cannot queue a control after stop',async t=>{
 const f=fixture(t);f.setHealth('unavailable');
 let entered,release;const started=new Promise(resolve=>{entered=resolve;});const barrier=new Promise(resolve=>{release=resolve;});
 f.observer.buildTargetBinding=async scene=>{entered();await barrier;return {runId:scene.runId};};
 const pending=f.observer.requestProbe('claude');await started;
 let stopped=false;const stopping=f.observer.shutdown().then(()=>{stopped=true;});
 assert.deepEqual(await pending,{recovered:false,stopped:true});assert.equal(stopped,false);
 assert.deepEqual(await f.observer.requestProbe('claude'),{recovered:false,stopped:true});
 release();await stopping;assert.equal(f.controls.length,0);assert.equal(f.observer.preparations.size,0);
});

test('shutdown: committed probe resolves waiters without waiting for C4 acknowledgement',async t=>{
 const f=fixture(t);f.setHealth('unavailable');const pending=f.observer.requestProbe('claude');await f.prepared();
 assert.equal(f.controls.length,1);assert.equal(f.controls[0].status,'pending');
 await f.observer.shutdown();assert.deepEqual(await pending,{recovered:false,stopped:true});
 assert.equal(f.controls[0].status,'pending');assert.equal(f.observer.probes.size,0);
 f.controls[0].status='done';await f.observer.tick();assert.equal(f.health().health,'unavailable');
});

// I2 R10/F1 regressions: delivered notifications, not observation ticks, are the boundary.
test('R10 one delivery with persistent API text never becomes a sticky restart on idle ticks',async t=>{
  const f=fixture(t);let captures=0,matches=0;
  f.observer.readScreen=()=>{captures++;return 'invalid_request_error';};
  f.observer.matchScreen=()=>{matches++;return {apiError:{detected:true}};};
  f.delivered();f.advance(5000);await f.observer.tick();
  f.advance(30000);await f.observer.tick();f.advance(30000);await f.observer.tick();
  assert.equal(f.stops.length,0);assert.equal(captures,1);assert.equal(matches,1);
});

test('R10 no new delivery means no repeated capture or authentication check',async t=>{
  const f=fixture(t);let captures=0,authChecks=0;
  f.observer.readScreen=()=>{captures++;return 'authentication required';};
  f.setMatches({authFailure:{detected:true}});
  f.observer.checkAuth=()=>{authChecks++;return {status:'uncertain'};};
  await f.observer.tick();assert.equal(captures,0);assert.equal(authChecks,0);
  const pastedAt=f.now();f.delivered();f.advance(5000);await f.observer.tick();
  for(let i=0;i<3;i++){f.advance(1000);f.delivered({pastedAt});await f.observer.tick();}
  assert.equal(captures,1);assert.equal(authChecks,1);
});

test('F1 a second delivery after a response starts its own no-response timer',async t=>{
  const f=fixture(t);f.delivered();f.advance(1000);
  f.setState({sessionId:f.scene().sessionId,lastActivityAt:f.now()});await f.observer.tick();
  f.advance(1000);f.delivered();await f.observer.tick();
  f.advance(599999);await f.observer.tick();assert.equal(f.stops.length,0);
  f.advance(1);await f.observer.tick();assert.equal(f.events.at(-1)?.event,'no_response_detected');
});

test('R10 a new delivery during capture remains pending for its own screen check',async t=>{
  const f=fixture(t);let captures=0,release,started;
  const entered=new Promise(resolve=>{started=resolve;});
  const screen=new Promise(resolve=>{release=resolve;});
  f.observer.readScreen=()=>{captures++;if(captures===1){started();return screen;}return '';};
  f.delivered();f.advance(5000);const first=f.observer.tick();await entered;
  f.advance(1);f.delivered();release('');await first;
  await f.observer.tick();assert.equal(captures,1);
  f.advance(5000);await f.observer.tick();await f.observer.tick();assert.equal(captures,2);assert.equal(f.stops.length,0);
});


test('R10 screen check waits five seconds after paste and is consumed only once',async t=>{
  const f=fixture(t);let captures=0;
  f.observer.readScreen=()=>{captures++;return '';};
  f.delivered();await f.observer.tick();assert.equal(captures,0);
  f.advance(4999);await f.observer.tick();assert.equal(captures,0);
  f.advance(1);await f.observer.tick();assert.equal(captures,1);
  f.advance(10000);await f.observer.tick();assert.equal(captures,1);
});
