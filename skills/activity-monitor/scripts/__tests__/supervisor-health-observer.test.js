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
  let clock=1792000000000,mode='multi',transition=null,manual=false,matches={},state={state:'idle',tools:[],sessionId:'session-a'},auth={status:'failure'};
  let scenes=[{sessionGroup:'telegram:a',runtime:'claude',runId:randomUUID(),ready:true,present:true,sessionId:'session-a'}];
  const controls=[],stops=[],events=[],interrupts=[],fences=new Map(),errors=[];
  const coordinator=new RuntimeHealthCoordinator({zylosDir:root,now:()=>clock,readMode:()=>mode,resolveTargetRuntime:()=> 'claude',listScenes:()=>scenes});
  const observer=new SupervisorHealthObserver({coordinator,now:()=>clock,listScenes:()=>scenes,readMode:()=>mode,
    readIdentity:g=>scenes.find(s=>s.sessionGroup===g),readState:()=>state,readScreen:()=>'',matchScreen:()=>matches,
    insertControl:(content,opts)=>{controls.push({id:controls.length+1,content,...opts,status:'pending'});return controls.at(-1);},
    getControlById:id=>controls[id-1],buildTargetBinding:s=>({runId:s.runId}),stop:async(s,validate)=>{if(!validate || await validate(s))stops.push(s);else return false;},
    getModeTransition:()=>transition,getDrainFence:g=>fences.get(g),manualPending:()=>manual,
    resolveToolRule:()=>({watchdog:{enabled:true,maxRuntimeSec:10,interruptKey:'Escape',interruptGraceSec:5,cooldownSec:2}}),
    nudge:async(s,validate)=>{if(!await validate(s))return {ok:false};interrupts.push({s});return {ok:true};},checkAuth:()=>auth,diagnostic:e=>events.push(e),log:e=>errors.push(e)});
  coordinator.probeInFlight=r=>observer.probeInFlight(r);
  return {coordinator,observer,controls,stops,events,interrupts,fences,errors,now:()=>clock,advance:ms=>clock+=ms,
    scene:()=>scenes[0],scenes:()=>scenes,setScenes:v=>scenes=v,setMode:v=>mode=v,setTransition:v=>transition=v,setManual:v=>manual=v,
    setState:v=>state={tools:[],sessionId:scenes[0]?.sessionId,state:v.tools?.length?'busy':'idle',...v},setMatches:v=>matches=v,setAuth:v=>auth=v,
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

test('a newly registered rate-limit recovery probes its ready run without a second backoff', async t => {
  const f = fixture(t), scene = f.scene(), sentAt = f.now();
  t.after(() => f.observer.shutdown());
  f.setHealth('rate_limited');
  const state = f.health();
  Object.assign(state.scheduling, { restartFailureCount: 1, lastRecoveryAt: f.now() / 1000 - 100 });
  f.coordinator.store('claude').write(state);
  await f.coordinator.notifyUserMessage('claude');
  f.setScenes([]);
  const reply = await f.coordinator.registerStartAttempt({ version: 1, type: 'start_attempt',
    requestId: `sa-${f.now()}-123456789abc`, runtime: 'claude', sessionGroup: scene.sessionGroup, runId: scene.runId });
  assert.equal(reply.result, 'registered');
  assert.equal(f.health().scheduling.restartFailureCount, 2);
  f.advance(3000);
  f.setScenes([scene]);
  const probe = f.observer.requestProbe('claude');
  await f.prepared();
  assert.equal(f.controls.length, 1, 'the registered attempt must not wait another five minutes');
  assert.equal(f.health().health, 'rate_limited', 'READY alone cannot clear a restriction');
  f.controls[0].status = 'done';
  await f.observer.tick();
  assert.equal((await probe).recovered, true);
  assert.equal(f.health().health, 'ok');
  assert.equal(f.now() - sentAt, 3000);
});

for (const health of ['unavailable', 'recovering', 'down']) {
  test(`registered ${health} recovery retains its retry interval`, { timeout: 5000 }, async t => {
    const f = fixture(t), scene = f.scene();
    t.after(() => f.observer.shutdown());
    f.setHealth(health);
    f.setScenes([]);
    const result = await f.coordinator.registerStartAttempt({ version: 1, type: 'start_attempt',
      requestId: `sa-${f.now()}-123456789abc`, runtime: 'claude', sessionGroup: scene.sessionGroup, runId: scene.runId });
    assert.equal(result.result, 'registered');
    const attempt = f.coordinator.registeredAttempt('claude');
    assert.equal(attempt.runId, scene.runId);
    attempt.runId = 'changed-copy';
    assert.equal(f.coordinator.registeredAttempt('claude').runId, scene.runId);
    f.setScenes([scene]);
    f.advance(3000);
    assert.equal((await f.observer.requestProbe('claude')).recovered, false);
    assert.equal(f.controls.length, 0);
    assert.equal(f.health().health, health);
    const interval = health === 'down' ? 3600000 : 60000;
    f.advance(interval - 3001);
    assert.equal(await f.observer.due('claude'), false);
    f.advance(1);
    const probe = f.observer.requestProbe('claude');
    await f.prepared();
    assert.equal(f.controls.length, 1);
    f.controls[0].status = 'done';
    await f.observer.tick();
    assert.equal((await probe).recovered, true);
  });
}

for (const restriction of ['cooldown', 'cache', 'replacement', 'fence', 'busy', 'auth', 'transition', 'not_ready', 'process_gone']) {
  test(`registered recovery still respects ${restriction}`, { timeout: 5000 }, async t => {
    const f = fixture(t), scene = f.scene();
    t.after(() => f.observer.shutdown());
    f.setHealth('rate_limited');
    f.setScenes([]);
    const result = await f.coordinator.registerStartAttempt({ version: 1, type: 'start_attempt',
      requestId: `sa-${f.now()}-123456789abc`, runtime: 'claude', sessionGroup: scene.sessionGroup, runId: scene.runId });
    assert.equal(result.result, 'registered');
    f.setScenes([scene]);
    const state = f.health();
    if (restriction === 'cooldown') { state.scheduling.cooldownUntil = f.now() / 1000 + 60; f.coordinator.store('claude').write(state); }
    if (restriction === 'cache') f.coordinator.readNegativeCache = () => ({ version: 2, runtime: 'claude',
      recovered: false, health: 'rate_limited', reason: state.reason || 'rate_limited', expiresAt: f.now() + 30000 });
    if (restriction === 'replacement') f.setScenes([{ ...scene, runId: randomUUID() }]);
    if (restriction === 'fence') f.fences.set(scene.sessionGroup, {});
    if (restriction === 'busy') f.setState({ state: 'busy' });
    if (restriction === 'auth') f.setHealth('auth_failed');
    if (restriction === 'transition') f.setTransition({ phase: 'gating' });
    if (restriction === 'not_ready') f.setScenes([{ ...scene, ready: false }]);
    if (restriction === 'process_gone') f.setScenes([{ ...scene, processRunning: false }]);
    await f.observer.requestProbe('claude');
    assert.equal(f.controls.length, 0);
    assert.notEqual(f.health().health, 'ok');
  });
}

test('an unrelated preferred scene cannot borrow a registered run confirmation', async t => {
  const f = fixture(t), scene = f.scene();
  t.after(() => f.observer.shutdown());
  f.setHealth('rate_limited'); f.setScenes([]);
  await f.coordinator.registerStartAttempt({ version: 1, type: 'start_attempt',
    requestId: `sa-${f.now()}-123456789abc`, runtime: 'claude', sessionGroup: scene.sessionGroup, runId: scene.runId });
  f.setScenes([{ ...scene, sessionGroup: 'origin', runId: randomUUID() }, scene]);
  const probe = f.observer.requestProbe('claude'); await f.prepared();
  assert.equal(f.controls.length, 1);
  assert.equal(f.controls[0].sessionGroup, scene.sessionGroup);
  f.controls[0].status = 'done'; await f.observer.tick();
  assert.equal((await probe).recovered, true);
});

test('a failed registered confirmation keeps rate limiting and consumes its single attempt', async t => {
  const f = fixture(t), scene = f.scene();
  t.after(() => f.observer.shutdown());
  f.setHealth('rate_limited'); f.setScenes([]);
  await f.coordinator.registerStartAttempt({ version: 1, type: 'start_attempt',
    requestId: `sa-${f.now()}-123456789abc`, runtime: 'claude', sessionGroup: scene.sessionGroup, runId: scene.runId });
  f.setScenes([scene]);
  const probe = f.observer.requestProbe('claude'); await f.prepared();
  assert.equal(f.controls.length, 1);
  f.setMatches({ rateLimit: { detected: true } });
  f.controls[0].status = 'failed'; await f.observer.tick();
  assert.equal((await probe).classification, 'rate_limited');
  assert.equal(f.health().health, 'rate_limited');
  assert.equal(f.health().scheduling.restartFailureCount, 1);
  assert.equal(f.coordinator.registeredAttempt('claude'), null);
  await f.observer.requestProbe('claude');
  assert.equal(f.controls.length, 1, 'a failed confirmation cannot reuse the old registration');
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
test('duplicate and older paste notifications preserve the silence boundary',async t=>{
  const f=fixture(t);f.delivered({pastedAt:f.now()-899999});await f.observer.tick();assert.equal(f.interrupts.length,0);
  f.delivered({pastedAt:f.now()-899999});f.delivered({pastedAt:f.now()-900000});f.advance(1);
  await f.observer.tick();assert.equal(f.events[0].event,'no_response_nudge');assert.equal(f.stops.length,0);
  f.advance(179999);await f.observer.tick();assert.equal(f.stops.length,0);
  f.advance(1);await f.observer.tick();assert.equal(f.events.at(-1).event,'no_response_restart');assert.equal(f.stops.length,1);
});
test('AI work permanently disarms a paste and only a later paste arms another observation',async t=>{
  const f=fixture(t);f.delivered();f.advance(1);f.setState({lastResponseAt:f.now()});await f.observer.tick();
  assert.equal(f.observer.sceneState(f.scene()).delivery.noResponseEligible,false);
  f.advance(1800000);await f.observer.tick();assert.equal(f.interrupts.length,0);
  f.delivered();f.advance(900000);await f.observer.tick();assert.equal(f.interrupts.length,1);
  f.advance(1);f.setState({lastResponseAt:f.now()});await f.observer.tick();
  f.advance(1800000);await f.observer.tick();assert.equal(f.interrupts.length,1);assert.equal(f.stops.length,0);
});
for(const evidence of ['lastActivityAt','transcriptMtimeMs','lastSubagentActivityAt'])test(`${evidence} alone cannot postpone an unanswered paste`,async t=>{
  const f=fixture(t);f.delivered();f.advance(899999);f.setState({[evidence]:f.now()});await f.observer.tick();
  f.advance(1);await f.observer.tick();assert.equal(f.interrupts.length,1);
});
test('silent active tools receive the same nudge and restart as an open quiet turn',async t=>{
  const f=fixture(t);f.observer.resolveToolRule=()=>null;f.setState({tools:[{id:'tool',startedAt:f.now(),name:'Bash'}]});
  f.delivered();f.advance(900000);await f.observer.tick();assert.equal(f.interrupts.length,1);
  f.advance(180000);await f.observer.tick();assert.equal(f.stops.length,1);
});
test('single mode and completed background waits do not arm no-response recovery',async t=>{
  for(const kind of ['single','completed','no-paste']) {
    const f=fixture(t);if(kind==='single')f.setMode('single');
    if(kind!=='no-paste')f.delivered();
    f.advance(1);if(kind==='completed')f.setState({lastResponseAt:f.now()});
    f.advance(1200000);await f.observer.tick();assert.equal(f.interrupts.length,0);assert.equal(f.stops.length,0);
    if(kind==='completed'){
      f.delivered();f.advance(900000);await f.observer.tick();assert.equal(f.interrupts.length,1);
    }
  }
});
test('sticky needs distinct delivered checks over 30 seconds and a delivered miss resets',async t=>{
  const f=fixture(t);f.delivered();f.setMatches({apiError:{detected:true}});f.advance(5000);await f.observer.tick();
  f.advance(24000);f.delivered();f.advance(5000);await f.observer.tick();assert.equal(f.stops.length,0);
  f.advance(1);f.setMatches({});f.delivered();f.advance(5000);await f.observer.tick();
  f.advance(1);f.setMatches({apiError:{detected:true}});f.delivered();f.advance(5000);await f.observer.tick();
  f.advance(25000);f.delivered();f.advance(5000);await f.observer.tick();assert.equal(f.events[0].event,'sticky_context_restart');assert.equal(f.health().health,'ok');
});
test('transition and accepted Origin manual request suppress pending health kills',async t=>{
  const f=fixture(t);f.setScenes([{...f.scene(),sessionGroup:'origin'}]);f.delivered({pastedAt:f.now()-900000});f.setTransition({phase:'gating'});await f.observer.tick();assert.equal(f.stops.length,0);f.setTransition(null);f.setManual(true);await f.observer.tick();assert.equal(f.stops.length,0);f.setManual(false);await f.observer.tick();assert.equal(f.interrupts.length,1);f.advance(180000);await f.observer.tick();assert.equal(f.stops.length,1);
});
test('watchdog waits interrupt grace without synthesizing tool completion',async t=>{
  const f=fixture(t);f.setState({tools:[{id:'one',name:'Bash',startedAt:f.now()-11000}]});await f.observer.tick();assert.equal(f.interrupts.length,1);f.advance(5000);await f.observer.tick();assert.equal(f.stops.length,0);f.advance(1);await f.observer.tick();assert.equal(f.events.at(-1).event,'tool_timeout_restart');assert.equal(f.health().health,'ok');
});
test('active tool remains running past the former process-sample interval',async t=>{
  const f=fixture(t);f.observer.resolveToolRule=()=>null;f.setState({tools:[{id:'one'}]});await f.observer.tick();f.advance(150000);await f.observer.tick();assert.deepEqual(f.stops,[]);assert.deepEqual(f.events,[]);assert.equal(f.health().health,'ok');
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

// Delivery boundary: delivered notifications, not observation ticks, are the boundary.
test('one delivery with persistent API text never becomes a sticky restart on idle ticks',async t=>{
  const f=fixture(t);let captures=0,matches=0;
  f.observer.readScreen=()=>{captures++;return 'invalid_request_error';};
  f.observer.matchScreen=()=>{matches++;return {apiError:{detected:true}};};
  f.delivered();f.advance(5000);await f.observer.tick();
  f.advance(30000);await f.observer.tick();f.advance(30000);await f.observer.tick();
  assert.equal(f.stops.length,0);assert.equal(captures,1);assert.equal(matches,1);
});

test('no new delivery means no repeated capture or authentication check',async t=>{
  const f=fixture(t);let captures=0,authChecks=0;
  f.observer.readScreen=()=>{captures++;return 'authentication required';};
  f.setMatches({authFailure:{detected:true}});
  f.observer.checkAuth=()=>{authChecks++;return {status:'uncertain'};};
  await f.observer.tick();assert.equal(captures,0);assert.equal(authChecks,0);
  const pastedAt=f.now();f.delivered();f.advance(5000);await f.observer.tick();
  for(let i=0;i<3;i++){f.advance(1000);f.delivered({pastedAt});await f.observer.tick();}
  assert.equal(captures,1);assert.equal(authChecks,1);
});

test('a second delivery after foreground completion starts its own silence timer',async t=>{
  const f=fixture(t);f.delivered();f.advance(1000);
  f.setState({lastResponseAt:f.now(),lastActivityAt:f.now()});await f.observer.tick();
  f.advance(1000);f.delivered();await f.observer.tick();
  f.advance(899999);await f.observer.tick();assert.equal(f.interrupts.length,0);
  f.advance(1);await f.observer.tick();assert.equal(f.events.at(-1)?.event,'no_response_nudge');
});

test('a new delivery during capture remains pending for its own screen check',async t=>{
  const f=fixture(t);let captures=0,release,started;
  const entered=new Promise(resolve=>{started=resolve;});
  const screen=new Promise(resolve=>{release=resolve;});
  f.observer.readScreen=()=>{captures++;if(captures===1){started();return screen;}return '';};
  f.delivered();f.advance(5000);const first=f.observer.tick();await entered;
  f.advance(1);f.delivered();release('');await first;
  await f.observer.tick();assert.equal(captures,1);
  f.advance(5000);await f.observer.tick();await f.observer.tick();assert.equal(captures,2);assert.equal(f.stops.length,0);
});


test('screen check waits five seconds after paste and is consumed only once',async t=>{
  const f=fixture(t);let captures=0;
  f.observer.readScreen=()=>{captures++;return '';};
  f.delivered();await f.observer.tick();assert.equal(captures,0);
  f.advance(4999);await f.observer.tick();assert.equal(captures,0);
  f.advance(1);await f.observer.tick();assert.equal(captures,1);
  f.advance(10000);await f.observer.tick();assert.equal(captures,1);
});


test('an inserted row without a positive integer id ends preparation with an error', { timeout: 5000 }, async t => {
  for (const row of [{}, { id: 0 }, { id: -1 }, { id: 1.5 }, { id: '1' }, 1, null]) {
    await t.test(JSON.stringify(row), async t => {
      const f = fixture(t); f.setHealth('rate_limited');
      f.observer.insertControl = () => row;
      const pending = f.observer.requestProbe('claude');
      await f.prepared();
      assert.deepEqual(await pending, { recovered: false, error: 'Recovery control was not inserted' });
      assert.equal(f.observer.probeInFlight('claude'), false);
      assert.equal(f.errors.length, 1);
      assert.equal(f.health().scheduling.lastRecoveryAt, 0);
      await f.observer.shutdown();
    });
  }
});

for(const gate of ['transition','manual','global-fence','group-fence','session','run','shutdown','new-paste','activity']) {
  test(`a ${gate} change before nudge admission suppresses stale control`,async t=>{
    const f=fixture(t);if(gate==='manual')f.setScenes([{...f.scene(),sessionGroup:'origin'}]);f.observer.resolveToolRule=()=>null;f.delivered();f.advance(900000);
    f.observer.nudge=async(scene,validate)=>{
      if(gate==='transition')f.setTransition({});
      if(gate==='manual')f.setManual(true);
      if(gate==='global-fence')f.fences.set('*',{});
      if(gate==='group-fence')f.fences.set(scene.sessionGroup,{});
      if(gate==='session')f.setScenes([{...scene,sessionId:'replacement'}]);
      if(gate==='run')f.setScenes([{...scene,runId:'replacement'}]);
      if(gate==='shutdown')await f.observer.shutdown();
      if(gate==='new-paste'){f.advance(1);f.delivered();}
      if(gate==='activity')f.setState({lastResponseAt:f.now()});
      if(await validate(scene))f.interrupts.push({scene});
      return {ok:f.interrupts.length>0};
    };
    await f.observer.tick();assert.equal(f.interrupts.length,0);assert.equal(f.stops.length,0);
  });
}
test('fresh activity at stop admission cancels restart',async t=>{
  const f=fixture(t);f.delivered();f.advance(900000);await f.observer.tick();
  f.observer.stop=async(scene,validate)=>{
    f.setState({lastSubagentActivityAt:f.now(),lastResponseAt:f.now()});
    if(await validate(scene))f.stops.push(scene);else return false;
  };
  f.advance(180000);await f.observer.tick();assert.equal(f.stops.length,0);
});
test('a newer paste during successful nudge completion retains the recovery episode',async t=>{
  const f=fixture(t);f.delivered();f.advance(900000);
  f.observer.nudge=async()=>{f.advance(1);f.delivered();return {ok:true};};
  await f.observer.tick();const delivery=f.observer.sceneState(f.scene()).delivery;
  assert.equal(delivery.pastedAt,f.now());assert.equal(delivery.recovery.nudgedAt,f.now());
});

test('no-response recovery takes precedence when the tool watchdog is also due',async t=>{
  const f=fixture(t);f.delivered();f.advance(900000);
  f.setState({tools:[{id:'web',name:'WebFetch',startedAt:f.now()-11000}]});
  await f.observer.tick();assert.equal(f.interrupts.length,1);
  assert.equal(f.events[0].event,'no_response_nudge');
  assert.equal(f.observer.sceneState(f.scene()).watchdog,null);
});
test('concurrent observations reserve only one pending nudge',async t=>{
  const f=fixture(t);f.delivered();f.advance(900000);let release,entered;
  const ready=new Promise(resolve=>entered=resolve),wait=new Promise(resolve=>release=resolve);
  f.observer.nudge=async()=>{f.interrupts.push({});entered();await wait;return {ok:true};};
  const first=f.observer.tick();await ready;await f.observer.tick();release();await first;
  assert.equal(f.interrupts.length,1);assert.equal(f.errors.length,0);
});
test('web watchdog preserves the configured default grace and records recovery context',async t=>{
  const {findMatchingToolRule}=await import('../tool-rules.js');
  const f=fixture(t);f.observer.resolveToolRule=(runtime,tool)=>findMatchingToolRule({runtimeId:runtime,toolName:tool.name});
  f.setState({tools:[{id:'web',name:'WebFetch',startedAt:f.now()-3600000}]});
  await f.observer.tick();assert.equal(f.interrupts.length,1);f.advance(15000);
  await f.observer.tick();assert.equal(f.stops.length,0);f.advance(1);await f.observer.tick();
  assert.equal(f.stops.length,1);
  for(const event of f.events){assert.equal(event.run_id,f.scene().runId);assert.equal(event.sessionGroup,f.scene().sessionGroup);assert.ok(Number.isFinite(event.silence_ms));}
  assert.deepEqual(f.events.map(event=>event.reason),['tool_timeout_nudge','tool_timeout_restart']);
});
test('unrelated activity does not exempt a web tool that remains past its fallback deadline',async t=>{
  const f=fixture(t);const tools=[{id:'web',name:'WebFetch',startedAt:f.now()-11000}];
  f.setState({tools});await f.observer.tick();f.advance(5001);
  f.setState({tools,lastSubagentActivityAt:f.now()});await f.observer.tick();
  assert.equal(f.stops.length,1);assert.equal(f.interrupts.length,1);
});

test('failed no-response nudges retry only after cooldown and record one event per attempt',async t=>{
  const f=fixture(t);f.delivered();f.advance(900000);let attempts=0;
  f.observer.nudge=async()=>{attempts++;return {ok:false,steps:[{ok:true},{ok:false}]};};
  await f.observer.tick();assert.equal(attempts,1);assert.equal(f.events.length,1);
  assert.equal(f.events[0].escape_enqueued,true);
  for(let i=0;i<59;i++){f.advance(1000);await f.observer.tick();}
  assert.equal(attempts,1);assert.equal(f.events.length,1);
  f.advance(1000);await f.observer.tick();assert.equal(attempts,2);assert.equal(f.events.length,2);
});
for(const failure of ['rejected','exception'])test(`new paste preserves failed nudge cooldown after ${failure}`,async t=>{
  const f=fixture(t);f.delivered();f.advance(900000);let attempts=0;
  f.observer.nudge=async()=>{
    attempts++;
    if(failure==='exception')throw Error('queue unavailable');
    return {ok:false};
  };
  await f.observer.tick();assert.equal(attempts,1);
  f.advance(10000);f.delivered();await f.observer.tick();assert.equal(attempts,1);
  f.advance(48000);await f.observer.tick();assert.equal(attempts,1);
  f.advance(1999);await f.observer.tick();assert.equal(attempts,1);
  f.advance(1);await f.observer.tick();assert.equal(attempts,2);
});
test('recovery blocked by fences or transition does not emit attempted-nudge events',async t=>{
  for(const gate of ['fence','transition','manual']){
    const f=fixture(t);f.setScenes([{...f.scene(),sessionGroup:'origin'}]);f.delivered();f.advance(900000);
    if(gate==='fence')f.fences.set('*',{});
    if(gate==='transition')f.setTransition({});
    if(gate==='manual')f.setManual(true);
    for(let i=0;i<3;i++){await f.observer.tick();f.advance(1000);}
    assert.equal(f.events.length,0);assert.equal(f.interrupts.length,0);
  }
});
test('ambiguous nudge exception is logged once and cooled down',async t=>{
  const f=fixture(t);f.delivered();f.advance(900000);let attempts=0;
  f.observer.nudge=async()=>{attempts++;throw Error('queue unavailable');};
  await f.observer.tick();f.advance(59000);await f.observer.tick();
  assert.equal(attempts,1);assert.equal(f.events.length,1);assert.equal(f.events[0].outcome,'unknown');
});
test('Stop and input metadata alone cannot disarm an unanswered paste',async t=>{
  const f=fixture(t);f.delivered();f.advance(1000);
  f.setState({lastActivityAt:f.now(),state:'idle'});await f.observer.tick();
  f.advance(899000);await f.observer.tick();assert.equal(f.interrupts.length,1);
});

test('Escape completion effects do not disarm recovery',async t=>{
  const f=fixture(t);f.delivered();f.advance(900000);
  f.observer.nudge=async()=>{f.advance(500);f.setState({lastActivityAt:f.now(),state:'idle'});return {ok:true};};
  await f.observer.tick();await f.observer.tick();assert.ok(f.observer.sceneState(f.scene()).delivery.recovery);
  f.advance(180000);await f.observer.tick();assert.equal(f.stops.length,1);
});
test('superseded nudge enqueue remains visible in the event log',async t=>{
  const f=fixture(t);f.delivered();f.advance(900000);
  f.observer.nudge=async()=>{f.advance(1);f.delivered();return {ok:true,steps:[{ok:true},{ok:true}]};};
  await f.observer.tick();assert.equal(f.events.length,1);assert.equal(f.events[0].superseded,true);assert.equal(f.events[0].enqueued,true);
});
test('health identity and stopping retain their run-scoped baseline behavior',async t=>{
  const f=fixture(t),scene=f.scene(),tracked=f.observer.sceneState(scene);
  f.setScenes([{...scene,sessionId:'cleared'}]);
  assert.equal(await f.observer.canAct(scene,{requireReady:true}),true);
  assert.equal(f.observer.sceneState(f.scene()),tracked);
  f.fences.set('*',{});assert.equal(await f.observer.stopScene(scene,'sticky_context_restart'),true);
  assert.equal(f.stops.length,1);
  f.observer.manualPending=()=>{throw Error('requests unreadable');};
  assert.equal(await f.observer.canAct(f.scene()),true,'non-Origin health checks do not read manual requests');
});
test('web nudge exceptions retain cooldown and record uncertain enqueue once',async t=>{
  const f=fixture(t);f.setState({tools:[{id:'web',name:'WebFetch',startedAt:f.now()-11000}]});let attempts=0;
  f.observer.nudge=async()=>{attempts++;throw Error('queue unavailable');};
  await f.observer.tick();f.advance(1999);await f.observer.tick();assert.equal(attempts,1);assert.equal(f.events.length,1);
  f.advance(1);await f.observer.tick();assert.equal(attempts,2);assert.equal(f.events.length,2);
  assert.equal(f.events[0].reason,'tool_timeout_nudge');assert.equal(f.events[0].outcome,'unknown');
});
test('new paste preserves the same web tool fallback deadline without another nudge',async t=>{
  const f=fixture(t),tools=[{id:'web',name:'WebFetch',startedAt:f.now()-11000}];f.setState({tools});
  await f.observer.tick();assert.equal(f.interrupts.length,1);
  f.advance(1);f.delivered();await f.observer.tick();assert.equal(f.interrupts.length,1);
  f.advance(5001);await f.observer.tick();assert.equal(f.stops.length,1);
});
test('a fast actual response during enqueue bookkeeping disarms on the next sample',async t=>{
  const f=fixture(t);f.delivered();f.advance(900000);
  f.observer.nudge=async()=>{const enqueuedAt=f.now();f.advance(1);f.setState({lastResponseAt:f.now()});f.advance(10);return {ok:true,enqueuedAt};};
  await f.observer.tick();await f.observer.tick();assert.equal(f.observer.sceneState(f.scene()).delivery.noResponseEligible,false);
});
test('unread transcript backlog defers decisions until factual records are sampled',async t=>{
  const f=fixture(t);f.delivered();f.advance(900000);f.setState({transcriptPending:true});
  await f.observer.tick();assert.equal(f.interrupts.length,0);f.setState({transcriptPending:false});
  await f.observer.tick();assert.equal(f.interrupts.length,1);f.advance(180000);
  f.setState({transcriptPending:true});await f.observer.tick();assert.equal(f.stops.length,0);
  f.setState({transcriptPending:false});await f.observer.tick();assert.equal(f.stops.length,1);
});
test('continuous pastes preserve web interrupt grace and failure cooldown',async t=>{
  const f=fixture(t),tools=[{id:'web',name:'WebFetch',startedAt:f.now()-11000}];f.setState({tools});
  await f.observer.tick();for(let i=0;i<5;i++){f.advance(1000);f.delivered();await f.observer.tick();}
  assert.equal(f.interrupts.length,1);assert.equal(f.stops.length,0);
  f.advance(1);f.delivered();await f.observer.tick();assert.equal(f.stops.length,1);
  const failed=fixture(t);failed.setState({tools:[{id:'web',name:'WebFetch',startedAt:failed.now()-11000}]});let attempts=0;
  failed.observer.nudge=async()=>{attempts++;return {ok:false};};await failed.observer.tick();
  failed.advance(1000);failed.delivered();await failed.observer.tick();assert.equal(attempts,1);
  failed.advance(1000);failed.delivered();await failed.observer.tick();assert.equal(attempts,2);
});

test('new pastes preserve the original no-response restart deadline',async t=>{
  const f=fixture(t);f.delivered();f.advance(900000);await f.observer.tick();
  const episode=f.observer.sceneState(f.scene()).delivery.recovery;
  for(let i=0;i<5;i++){f.advance(30000);f.delivered();await f.observer.tick();assert.equal(f.observer.sceneState(f.scene()).delivery.recovery,episode);}
  assert.equal(f.stops.length,0);f.advance(29999);f.delivered();await f.observer.tick();assert.equal(f.stops.length,0);
  f.advance(1);await f.observer.tick();assert.equal(f.stops.length,1);assert.equal(f.interrupts.length,1);
});
test('repeated input-side activity does not postpone the first silence deadline',async t=>{
  const f=fixture(t);f.delivered();
  for(let i=0;i<14;i++){f.advance(60000);f.delivered();f.setState({lastActivityAt:f.now(),transcriptMtimeMs:f.now()});await f.observer.tick();}
  assert.equal(f.interrupts.length,0);f.advance(60000);f.delivered();await f.observer.tick();assert.equal(f.interrupts.length,1);
});
test('work after an older paste but before the latest paste gives the latter its own interval',async t=>{
  const f=fixture(t),initial=f.now();f.delivered();f.advance(10000);
  f.setState({lastResponseAt:initial+500});f.delivered();await f.observer.tick();
  f.advance(899999);await f.observer.tick();assert.equal(f.interrupts.length,0);
  f.advance(1);await f.observer.tick();assert.equal(f.interrupts.length,1);
});
test('leaving multi clears recovery so re-entry cannot immediately execute the old stop',async t=>{
  const f=fixture(t);f.delivered();f.advance(900000);await f.observer.tick();f.setMode('single');f.advance(180000);
  await f.observer.tick();assert.equal(f.observer.sceneState(f.scene()).delivery.recovery,null);
  f.setMode('multi');await f.observer.tick();assert.equal(f.stops.length,0);assert.equal(f.interrupts.length,2);
});
test('work at or before paste does not disarm but later work does',async t=>{
  const f=fixture(t),at=f.now();f.delivered();f.setState({lastResponseAt:at});await f.observer.tick();
  assert.equal(f.observer.sceneState(f.scene()).delivery.noResponseEligible,true);
  f.advance(1);f.setState({lastResponseAt:f.now()});await f.observer.tick();
  assert.equal(f.observer.sceneState(f.scene()).delivery.noResponseEligible,false);
});
test('real-response disarming waits for transcript catch-up before and after nudge',async t=>{
  for(const nudged of [false,true]) {
    const f=fixture(t);f.delivered();if(nudged){f.advance(900000);await f.observer.tick();}
    f.advance(1);f.setState({lastResponseAt:f.now(),transcriptPending:true});await f.observer.tick();
    assert.equal(f.observer.sceneState(f.scene()).delivery.noResponseEligible,true);
    f.setState({lastResponseAt:f.now()});await f.observer.tick();
    assert.equal(f.observer.sceneState(f.scene()).delivery.noResponseEligible,false);
    assert.equal(f.observer.sceneState(f.scene()).delivery.recovery,null);
  }
});
test('web watchdog cannot nudge or restart while transcript records remain unread',async t=>{
  const f=fixture(t),tools=[{id:'web',name:'WebFetch',startedAt:f.now()-11000}];f.setState({tools,transcriptPending:true});
  await f.observer.tick();assert.equal(f.interrupts.length,0);f.setState({tools});f.advance(2000);await f.observer.tick();assert.equal(f.interrupts.length,1);
  f.advance(5001);f.setState({tools,transcriptPending:true});await f.observer.tick();assert.equal(f.stops.length,0);
  f.setState({tools});await f.observer.tick();assert.equal(f.stops.length,1);
});


test('future responses cannot disarm and foreign sessions cannot authorize recovery',async t=>{
  for(const evidence of [{lastResponseAt:1792001000000},{sessionId:'old-session',lastResponseAt:1792000899999}]) {
    const f=fixture(t);f.delivered();f.advance(899999);f.setState(evidence);await f.observer.tick();f.advance(1);await f.observer.tick();
    if(evidence.sessionId){assert.equal(f.interrupts.length,0);f.setState({});f.advance(60000);await f.observer.tick();}
    assert.equal(f.interrupts.length,1);
  }
});
