import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSupervisor } from '../supervisor.js';
import { RestartRequestStore } from '../restart-request-store.js';
function fixture(t,{badRequests=false,readMode=()=>({mode:'multi'}),resolveLaunchConfig=()=>({runtime:'claude',mode:'default'}),consumeHealthEvents,readConfiguration=async()=>({mode:'multi',runtime:'claude',capacity:2}),checkAuth=async()=>({status:'uncertain'}),alert}={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'supervisor-assembly-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'requests.json');if(badRequests)fs.writeFileSync(file,'broken');
 const calls=[],db={getOriginNeed:()=>({controls:{count:0},inbound:{oldestAt:null}}),getModeTransition:()=>null,listDrainFences:()=>[],getDrainFence:()=>null,listPendingContinuations:()=>[],listRunEndings:()=>[],getLastCompletedModeTransition:()=>null,listPendingSessionGroups:()=>[],getControlById:()=>null,resolveSessionLaunchConfig:resolveLaunchConfig};
 const scenes={observe:async()=>[],readIdentity(group) { return this.observeGroup(group); }, observeGroup:async()=>({present:false}),listRuns:async()=>[],readRun:async()=>null};
 const supervisor=createSupervisor({db,scenes,zylosDir:root,env:{ZYLOS_DIR:root},readConfiguration,readMode,resolveTargetRuntime:async()=> 'claude',requestStore:new RestartRequestStore({file}),consumeHealthEvents,checkAuth,alert,log:item=>calls.push(item),loopOptions:{schedule:()=>1,cancel:()=>{}}});
 t.after(()=>supervisor.stop());return {supervisor,calls,file,root,scenes,db};
}
test('assembly: restore health before admission; no-launch empty round executes',async t=>{
 const {supervisor}=fixture(t);assert.equal(supervisor.admission.open,false);await supervisor.loop.start();assert.equal(supervisor.admission.open,true);assert.equal(supervisor.health.stores.size,2);
 const reply=await supervisor.admission.handle({version:1,type:'restart_all',requestId:'empty',reason:'upgrade'});assert.equal(reply.result,'done_empty');
});
test('assembly: damaged retained while existing lifecycle loop stays scheduled',async t=>{
 const {supervisor,calls,file}=fixture(t,{badRequests:true});await supervisor.loop.start();assert.equal(supervisor.admission.open,true);assert.equal(fs.readFileSync(file,'utf8'),'broken');assert.ok(calls.some(row=>row.error==='requests_unreadable'));
 const reply=await supervisor.admission.handle({version:1,type:'restart_all',requestId:'bad',reason:'upgrade'});assert.equal(reply.code,'requests_unreadable');assert.equal(fs.readFileSync(file,'utf8'),'broken');
});


async function capturedAuthRecovery(supervisor,runtime='claude') {
 const store=supervisor.health.store(runtime),state=store.read();
 state.health='auth_failed';state.reason='authentication_failed';store.write(state);
 await supervisor.health.beginAuthRecovery(runtime,{status:'success'},[]);
}

test('assembly: unwritable diagnostic output cannot block completed authentication recovery',async t=>{
 const {supervisor,calls,root}=fixture(t);
 await supervisor.loop.deps.readConfiguration();
 await capturedAuthRecovery(supervisor);
 // A directory at the file path fails actual append and rotation without needing
 // privilege-sensitive chmod assumptions (the test may run as root).
 fs.mkdirSync(path.join(root,'activity-monitor','pool-metrics.jsonl'),{recursive:true});
 fs.mkdirSync(path.join(root,'activity-monitor','pool-metrics.0.jsonl')); // Retention unlink also fails.
 await supervisor.loop.deps.writeMetricsAndMaintain({scenes:[],fences:[]});
 assert.equal(supervisor.health.store('claude').read().health,'ok');
 assert.equal(supervisor.health.authRecoveries.has('claude'),false);
 assert.ok(calls.some(row=>row.phase==='pool-metrics'));
 assert.ok(calls.some(row=>row.phase==='log-maintenance'));
});

test('assembly: maintenance retains current and recent logs while pruning absent valid groups only',async t=>{
 const {supervisor,root}=fixture(t);await supervisor.loop.deps.readConfiguration();
 const groups=path.join(root,'activity-monitor','session-groups'),valid=path.join(groups,'telegram:absent'),invalid=path.join(groups,'void'),target=path.join(root,'symlink-target');
 for(const dir of [valid,invalid,target])fs.mkdirSync(dir,{recursive:true});
 const now=Date.now(),expired=1,recent=now-1000;
 for(const dir of [valid,invalid,target]){
  fs.writeFileSync(path.join(dir,'events.jsonl'),'current\n');
  fs.writeFileSync(path.join(dir,`events.${expired}.jsonl`),'old\n');
 }
 fs.writeFileSync(path.join(valid,`events.${recent}.jsonl`),'recent\n');
 fs.writeFileSync(path.join(groups,'telegram:file'),'not a directory');
 fs.symlinkSync(target,path.join(groups,'telegram:link'));
 await supervisor.loop.deps.writeMetricsAndMaintain({scenes:[],fences:[]});
 assert.equal(fs.existsSync(path.join(valid,`events.${expired}.jsonl`)),false);
 assert.equal(fs.existsSync(path.join(valid,`events.${recent}.jsonl`)),true);assert.equal(fs.existsSync(path.join(valid,'events.jsonl')),true);
 assert.equal(fs.existsSync(path.join(invalid,`events.${expired}.jsonl`)),true);assert.equal(fs.existsSync(path.join(target,`events.${expired}.jsonl`)),true);
 assert.equal(fs.readFileSync(path.join(groups,'telegram:file'),'utf8'),'not a directory');
});

test('assembly: one failed probe poll cannot starve another runtime or auth recovery',async t=>{
 const {supervisor,calls}=fixture(t);
 await supervisor.loop.deps.readConfiguration();await capturedAuthRecovery(supervisor,'codex');
 const polled=[];
 supervisor.observer.probes.set('claude',{runtime:'claude',resolve:()=>{}});
 supervisor.observer.probes.set('codex',{runtime:'codex',resolve:()=>{}});
 supervisor.observer.pollProbe=async probe=>{polled.push(probe.runtime);if(probe.runtime==='claude')throw Object.assign(new Error('pane unreadable'),{code:'TMUX_UNAVAILABLE'});};
 await supervisor.loop.deps.writeMetricsAndMaintain({scenes:[],fences:[]});
 assert.deepEqual(polled,['claude','codex']);
 assert.equal(supervisor.health.store('codex').read().health,'ok');
 assert.ok(calls.some(row=>row.phase==='recovery-probe' && row.runtime==='claude'));
});


test('assembly: config reclaim resolves mode at admission, after cutover',async t=>{
 let mode='single';const selected=[];
 const {supervisor}=fixture(t,{readMode:()=>({mode}),resolveLaunchConfig:input=>{selected.push(input);return {runtime:'claude',mode:'default'};}});
 await supervisor.loop.deps.readConfiguration();
 await supervisor.admission.resolveLaunchConfig('chat:A');mode='multi';
 await supervisor.admission.resolveLaunchConfig('chat:A');
 assert.deepEqual(selected,[{sessionGroup:'chat:A',sessionMode:'single'},{sessionGroup:'chat:A',sessionMode:'multi'}]);
});

test('assembly: stopped, unknown, or no-longer-ready processes cannot refresh',async t=>{
 const {supervisor,scenes,root}=fixture(t);
 const scene={sessionGroup:'chat:A',runtime:'claude',runId:'r',sessionId:'s',runDir:root,createdAt:100,ready:true,present:true,processRunning:true};
 const file=path.join(root,'agent-status.json');fs.writeFileSync(file,'prior state');let observations=0;
 let current=scene;scenes.readIdentity=async()=>{observations++;return current;};
 scenes.observeGroup=async()=>{throw new Error("publication must not resample processes");};
 await supervisor.loop.deps.probeAndPublish({...scene,processRunning:false},{});
 await supervisor.loop.deps.probeAndPublish({...scene,processRunning:undefined},{});
 assert.equal(observations,0);
 for(const change of [{present:false},{runId:'replacement'},{sessionId:'replacement'},{ready:false}]){
  current={...scene,...change};await supervisor.loop.deps.probeAndPublish(scene,{});
  assert.equal(fs.readFileSync(file,'utf8'),'prior state');
 }
 current=scene;await supervisor.loop.deps.probeAndPublish(scene,{});
 assert.equal(JSON.parse(fs.readFileSync(file)).runId,'r');
});


test('assembly: hooks and status share the round sample; replacement identity blocks publication',async t=>{
 const consumed=[];let current,replaceDuringConsume=false;
 const {supervisor,scenes,root}=fixture(t,{consumeHealthEvents:async scene=>{
  consumed.push(scene.runtimePid);
  if(replaceDuringConsume)current={...current,sessionId:'replacement-session'};
 }});
 const sampled={sessionGroup:'chat:A',runtime:'claude',runId:'r',sessionId:'s',runDir:root,createdAt:100,ready:true,present:true,processRunning:true,runtimePid:1,proc:{pid:1,alive:true}};
 current=sampled;
 scenes.readIdentity=async()=>current;
 scenes.observeGroup=async()=>{throw new Error('publication must reuse the round process sample');};
 await supervisor.loop.deps.probeAndPublish(sampled,{});
 const file=path.join(root,'agent-status.json'),saved=fs.readFileSync(file,'utf8');
 assert.deepEqual(consumed,[1]);assert.equal(JSON.parse(saved).proc.pid,1);
 replaceDuringConsume=true;await supervisor.loop.deps.probeAndPublish(sampled,{});
 assert.deepEqual(consumed,[1,1]);assert.equal(fs.readFileSync(file,'utf8'),saved);
});


test('shutdown: accepted lifecycle mutation finishes before Supervisor stop resolves',async t=>{
 const {supervisor}=fixture(t);supervisor.admission.openEntry();
 let release,entered;const running=new Promise(resolve=>{entered=resolve;});
 const barrier=new Promise(resolve=>{release=resolve;});let written=false;
 const accepted=supervisor.admission.serialize(async()=>{entered();await barrier;written=true;});
 await running;let stopped=false;const stopping=supervisor.stop().then(()=>{stopped=true;});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(supervisor.admission.open,false);assert.equal(stopped,false);assert.equal(written,false);
 release();await accepted;await stopping;assert.equal(written,true);assert.equal(stopped,true);
});


test('shutdown: detached route auth and accepted health writes drain before return',async t=>{
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

// B2 / metrics uses the lifecycle round, including its stop updates.
test('assembly: metrics reuses scene and fence snapshots and excludes stopped entries',async t=>{
 const {supervisor,scenes,db,root}=fixture(t);
 await supervisor.loop.deps.readConfiguration();
 scenes.observe=async()=>{throw new Error('metrics must not resample scenes');};
 db.listDrainFences=()=>{throw new Error('metrics must not reread D8');};
 const snapshot=[{runDir:root,sessionGroup:'chat:ready',present:true,ready:true},
  {runDir:root,sessionGroup:'chat:unknown',present:true,ready:false},
  {runDir:root,sessionGroup:'chat:stopped',present:false,ready:false}];
 await supervisor.loop.deps.writeMetricsAndMaintain({scenes:snapshot,fences:[{sessionGroup:'chat:unknown',reason:'upgrade'}]});
 const metrics=JSON.parse(fs.readFileSync(path.join(root,'activity-monitor','pool-metrics.jsonl'),'utf8').trim());
 assert.deepEqual({ready:metrics.ready,starting:metrics.starting,reclaiming:metrics.reclaiming,waiting:metrics.waiting},
  {ready:1,starting:1,reclaiming:1,waiting:0});
});

// B2: confirmed health/exit cleanup must update the shared publication sample.
for(const source of ['health','exit'])test(`assembly: ${source} stop removes the run from subsequent round metrics`,async t=>{
 const {supervisor,scenes,root}=fixture(t);
 const scene={sessionGroup:'chat:stop',runtime:'claude',runId:'r',sessionId:'s',runDir:root,createdAt:100,present:true,ready:true,processRunning:source==='health'};
 scenes.observe=async()=>[scene];scenes.readIdentity=async()=>scene;scenes.observeGroup=async()=>scene;
 let stops=0;scenes.stop=async()=>{stops++;};
 await supervisor.loop.deps.readConfiguration();
 const context={fences:[]};context.scenes=await supervisor.loop.deps.observe(context);
 if(source==='health'){
  await supervisor.loop.deps.observeExits([scene]);
  await supervisor.observer.stopScene(scene,'fixture-health-stop');
  await supervisor.loop.deps.observeExits([]);
  const events=fs.readFileSync(path.join(root,'activity-monitor','supervisor-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(row=>row.event==='crash_detected'&&row.runId==='r').length,1);
 }
 else await supervisor.loop.deps.observeExits(context.scenes);
 assert.equal(stops,1);assert.equal(context.scenes[0].present,false);assert.equal(context.scenes[0].ready,false);
 await supervisor.loop.deps.writeMetricsAndMaintain(context);
 const metrics=JSON.parse(fs.readFileSync(path.join(root,'activity-monitor','pool-metrics.jsonl'),'utf8').trim());
 assert.equal(metrics.ready,0);assert.equal(metrics.starting,0);
});

test('assembly: single auth null scope invalidates only its matching Origin run',async t=>{
 const {supervisor,scenes}=fixture(t);
 const original={sessionGroup:'origin',runId:'old',present:true,ready:true};
 scenes.observe=async()=>[original];scenes.stop=async()=>{};
 await supervisor.loop.deps.readConfiguration();
 const context={configuration:{mode:'single'},fences:[]};context.scenes=await supervisor.loop.deps.observe(context);
 await supervisor.lifecycle.d.stop({sessionGroup:null,runId:'old'});
 assert.equal(original.present,false);
 context.scenes[0]={sessionGroup:'origin',runId:'replacement',present:true,ready:true};
 await supervisor.lifecycle.d.stop({sessionGroup:null,runId:'old'});
 assert.equal(context.scenes[0].present,true);assert.equal(context.scenes[0].runId,'replacement');
});

test('assembly: single null scope forgets the exact Origin run from the shared exit memory',async t=>{
 const {supervisor,scenes,db,root}=fixture(t,{readMode:()=>({mode:'single'})});
 const original={sessionGroup:'origin',runId:'old',runtime:'claude',sessionId:'session-old',present:true,ready:true,processRunning:true};
 scenes.observeGroup=async()=>({present:false});
 db.countGlobalRunningConversations=()=>0;db.countNonTerminalControls=()=>({running:0,runningWithoutDeadline:0});
 db.expireStaleRunningControls=()=>[];
 await supervisor.loop.deps.observeExits([original]);
 const context={configuration:{mode:'single'},scenes:[{...original,processRunning:false}],fences:[],restartRequests:[]};
 assert.equal(await supervisor.lifecycle.advanceReclaim({reason:'auth',runId:'old'},context,{unfenced:true,singleAuth:true}),'done');
 await supervisor.loop.deps.observeExits([]);
 const eventsFile=path.join(root,'activity-monitor','supervisor-events.jsonl');
 const events=fs.existsSync(eventsFile)?fs.readFileSync(eventsFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 assert.equal(events.some(row=>row.event==='crash_detected' && row.runId==='old'),false);
});

test('C3 each unavailable dependency logs once while unrelated failures remain visible',async t=>{
 const {supervisor,calls}=fixture(t);
 await supervisor.loop.deps.advanceTransition({});await supervisor.loop.deps.advanceTransition({});
 const report=supervisor.loop.deps.reportError;
 for(const dependency of [' pool',' Sync',' migration'])for(let i=0;i<3;i++)report(Object.assign(new Error(dependency),{code:'DEPENDENCY_UNAVAILABLE'}),{phase:'fixture',sessionGroup:String(i)});
 for(let i=0;i<2;i++)report(Object.assign(new Error('unrelated failure'),{code:'EIO'}));
 assert.equal(calls.filter(row=>row.error==='DEPENDENCY_UNAVAILABLE').length,3);
 assert.equal(calls.filter(row=>row.error==='EIO').length,2);
});


test('real supervisor rounds deduplicate configuration read failures and reset on recovery', async t => {
  let failure = null;
  const { supervisor, root, calls, db } = fixture(t, {
    readConfiguration: async () => {
      if (failure) throw failure;
      return { mode: 'multi', runtime: 'claude', capacity: 2 };
    },
  });
  await supervisor.loop.start();
  let transitionReads = 0;
  supervisor.loop.deps.getModeTransition = () => { transitionReads++; return null; };
  db.getModeTransition = () => { throw new Error('configuration wrapper must not query D9'); };
  for (const code of ['EACCES', 'EACCES', 'EIO', 'EIO', 'EACCES']) {
    failure = Object.assign(new Error(code), { code });
    await supervisor.loop.tick();
  }
  assert.equal(transitionReads, 5, 'one loop authority read; failed configuration wrapper must not query D9');
  const events = () => fs.readFileSync(path.join(root, 'activity-monitor/supervisor-events.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line)).filter(row => row.event === 'auto_migration_skipped');
  assert.deepEqual(events().map(row => [row.session_group, row.reason]), [['*', 'EACCES'], ['*', 'EIO'], ['*', 'EACCES']]);
  assert.deepEqual(calls.filter(row => row.phase === 'round').map(row => row.error), ['EACCES', 'EACCES', 'EIO', 'EIO', 'EACCES']);
  failure = null; await supervisor.loop.tick();
  failure = Object.assign(new Error('again'), { code: 'EACCES' });
  await supervisor.loop.tick(); await supervisor.loop.tick();
  assert.equal(events().length, 4);
  assert.equal(events().at(-1).reason, 'EACCES');
});


test('open transition configuration failure does not emit automatic-migration skip', async t => {
  let failure = null;
  const { supervisor, root, calls, db } = fixture(t, {
    readConfiguration: async () => {
      if (failure) throw failure;
      return { mode: 'multi', runtime: 'claude', capacity: 2 };
    },
  });
  await supervisor.loop.start();
  const transition = { run_id: 'open', source_mode: 'single', target_mode: 'multi', phase: 'gating', reason: null };
  supervisor.loop.deps.getModeTransition = () => transition;
  // The real transition advance fails its F1 read; the round then reads F1 too.
  supervisor.modeSwitch.readMode = () => { throw Object.assign(new Error('unreadable mode'), { code: 'EIO' }); };
  db.getModeTransition = () => transition;
  db.setModeTransitionPhase = (runId, phase, { reason }) => { transition.reason = reason; };
  failure = Object.assign(new Error('unreadable configuration'), { code: 'EIO' });
  await supervisor.loop.tick(); await supervisor.loop.tick();
  assert.equal(transition.reason, 'config_unreadable');
  assert.equal(calls.filter(row => row.phase === 'round' && row.error === 'EIO').length, 2);
  const events = fs.readFileSync(path.join(root, 'activity-monitor/supervisor-events.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.some(row => row.event === 'auto_migration_skipped'), false);
  assert.equal(events.filter(row => row.event === 'transition_blocked').length, 1);
});

test('unreadable startup configuration stops before transition sampling or migration diagnostics', async t => {
  const failure = Object.assign(new Error('unreadable startup configuration'), { code: 'EIO' });
  const alerts=[];const { supervisor, root, calls, db } = fixture(t, { readConfiguration: async () => { throw failure; },alert:async event=>alerts.push(event) });
  let transitionReads = 0;
  db.getModeTransition = () => { transitionReads++; return null; };
  await supervisor.loop.start();
  assert.equal(supervisor.loop.configurationError, failure);
  assert.equal(supervisor.admission.open, false);
  assert.equal(transitionReads, 0);
  assert.equal(calls.filter(row => row.phase === 'configuration' && row.error === 'EIO').length, 1);
  assert.deepEqual(alerts,[{event:'startup_configuration_unreadable',session_group:'*',reason:'EIO'}]);
  await supervisor.loop.start();await supervisor.loop.tick();assert.equal(alerts.length,1);
  assert.equal(fs.existsSync(path.join(root, 'activity-monitor/supervisor-events.jsonl')), false);
});

test('assembly: startup alert failure is logged while admission and scheduling stay closed',async t=>{
 const failure=Object.assign(new Error('bad config'),{code:'EIO'});
 const {supervisor,calls}=fixture(t,{readConfiguration:async()=>{throw failure;},alert:async()=>{throw Object.assign(new Error('alert unavailable'),{code:'ALERT_DOWN'});}});
 await supervisor.loop.start();await supervisor.loop.tick();
 assert.equal(supervisor.admission.open,false);assert.equal(calls.filter(row=>row.phase==='startup-alert'&&row.error==='ALERT_DOWN').length,1);
});

test('configuration recovery during an open transition resets automatic-skip deduplication', async t => {
  let failure = null, transition = null;
  const { supervisor, root, db } = fixture(t, {
    readMode: () => {
      if (failure) throw failure;
      return { mode: 'single' };
    },
    readConfiguration: async () => {
      if (failure) throw failure;
      return { mode: 'single', runtime: 'claude', capacity: 2 };
    },
  });
  db.getModeTransition = () => transition;
  supervisor.loop.deps.getModeTransition = () => transition;
  db.setModeTransitionPhase = (runId, phase, { reason }) => { transition.reason = reason; };
  db.setDrainFence = () => {};
  db.listRunningControlsWithoutDeadline = scope => scope.machine ? [1] : [];
  const events = () => fs.readFileSync(path.join(root, 'activity-monitor/supervisor-events.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line)).filter(row => row.event === 'auto_migration_skipped');
  await supervisor.loop.start();
  failure = Object.assign(new Error('unreadable configuration'), { code: 'EIO' });
  await supervisor.loop.tick();
  assert.equal(events().length, 1);
  transition = { run_id: 'open', source_mode: 'single', target_mode: 'multi', phase: 'gating', reason: null };
  await supervisor.loop.tick();
  assert.equal(transition.reason, 'config_unreadable');
  failure = null;
  await supervisor.loop.tick();
  assert.equal(transition.reason, 'running_control_without_deadline:machine:1');
  assert.equal(events().length, 1);
  transition = null;
  failure = Object.assign(new Error('same failure after transition'), { code: 'EIO' });
  await supervisor.loop.tick(); await supervisor.loop.tick();
  assert.deepEqual(events().map(row => [row.session_group, row.reason]), [['*', 'EIO'], ['*', 'EIO']]);
});

// Real assembly boundary: run for supervisor reconciliation or lifecycle wiring
// changes. Private current-session files and injected scene I/O avoid live runtimes.
test('assembled round records an absent persisted run exactly once', async t => {
 const {supervisor,db,root,calls}=fixture(t);
 const group='telegram:assembled',runId='persisted-run';
 const directory=path.join(root,'activity-monitor','session-groups',group);
 fs.mkdirSync(directory,{recursive:true});
 fs.writeFileSync(path.join(directory,'current-session.json'),JSON.stringify({runId,ts:Date.now()-1000}));
 const records=[];
 db.recordRunEnd=(sessionGroup,options)=>{records.push({sessionGroup,...options});return {recorded:true};};
 await supervisor.loop.start();
 assert.deepEqual(records,[{sessionGroup:group,runId,reason:'unexpected'}]);
 assert.equal(calls.some(row=>row.phase==='run-ending-reconciliation' || row.phase==='round'),false);
});

test('assembled round clears an upgrade fence without recording a replacement run', async t => {
 const {supervisor,db,root,scenes,calls}=fixture(t);
 const group='telegram:replacement',runId='replacement-run';
 const directory=path.join(root,'activity-monitor','session-groups',group);
 fs.mkdirSync(directory,{recursive:true});
 fs.writeFileSync(path.join(directory,'current-session.json'),JSON.stringify({runId,ts:Date.now()-1000}));
 let fence={sessionGroup:group,reason:'upgrade',runId:'old-run'};
 const records=[],cleared=[];
 // Keep the replacement in startup: it has an authoritative new identity while
 // unrelated ready-only health/status and idle checks remain outside this case.
 const replacement={sessionGroup:group,runId,runtime:'claude',runDir:directory,present:true,ready:false,processRunning:true};
 scenes.observe=async()=>[replacement];
 scenes.observeGroup=async()=>replacement;
 db.listDrainFences=()=>fence?[fence]:[];
 supervisor.loop.deps.listDrainFences=db.listDrainFences;
 db.getDrainFence=sessionGroup=>sessionGroup===group?fence:null;
 db.clearDrainFence=(sessionGroup,expected)=>{cleared.push({sessionGroup,...expected});fence=null;};
 db.recordRunEnd=(sessionGroup,options)=>{records.push({sessionGroup,...options});return {recorded:true};};
 db.countRunningConversations=()=>0;
 db.countNonTerminalControls=()=>({running:0});
 await supervisor.loop.start();
 assert.deepEqual(cleared,[{sessionGroup:group,expectedReason:'upgrade',expectedRunId:'old-run'}]);
 assert.equal(fence,null);assert.equal(records.length,0);
 assert.equal(calls.some(row=>['reclaim','run-ending-reconciliation','round'].includes(row.phase)),false);
});
