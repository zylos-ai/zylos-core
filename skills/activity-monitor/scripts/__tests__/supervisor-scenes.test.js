import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { ChildProcess } from 'node:child_process';
import { ClaudeAdapter } from '../../../../cli/lib/runtime/claude.js';
import { sceneRotationThreshold } from '../supervisor-lifecycle.js';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { SupervisorScenes } from '../supervisor-scenes.js';
import { SupervisorServerObservation } from '../supervisor-server-observation.js';
import { SupervisorServerHealth } from '../supervisor-server-health.js';

function service(f, options = {}) {
  return new SupervisorScenes({ env: f.env, connectionOptions: { socketPath: f.socketPath, binary: f.binary },
    readMode: () => ({ mode: 'multi' }), readActivity: () => ({ state: 'idle', idleSince: 123 }),
    readUsage: () => null, ...options });
}
// Boundary: real READY/process observation and activity field propagation on a
// private tmux socket/SQLite fixture. Run for scene/activity projection changes;
// unrelated UI work may skip. Official runner isolates HOME/ZYLOS_DIR/PM2_HOME
// and short TMPDIR; readyTmuxTarget owns and cleans every tmux/database resource.
test('scene joins real READY and process identity with live pane liveness', { timeout: 15000 }, async t => {
  const f = readyTmuxTarget(t, { prefix: 'supervisor-scene-', mode: 'multi' });
  const facts = { state: 'busy', idleSince: null, busySince: 75, turnOpen: true, lastActivityAt: 100,
    activeSubagents: [{ agentId: 'child', lastActivityAt: 456 }], lastSubagentActivityAt: 456 };
  const scenes = service(f, { readActivity: () => facts }), scene = await scenes.observeGroup('origin');
  assert.equal(scene.ready, true); assert.equal(scene.runtime, 'claude'); assert.equal(scene.processRunning, true);
  assert.equal(scene.runId, 'run-1'); assert.equal(scene.sessionId, 'session-1');
  assert.equal(scene.currentSessionTs, 1); assert.equal(scene.createdAt % 1000, 0);
  assert.equal(scene.state, 'busy'); assert.equal(scene.idleSince, null); assert.equal(scene.busySince, 75); assert.equal(scene.usagePercent, null);
  assert.equal(scene.turnOpen, true);
  assert.equal(scene.lastActivityAt, 100);
  assert.deepEqual(scene.activeSubagents, facts.activeSubagents); assert.equal(scene.lastSubagentActivityAt, 456);
  assert.deepEqual(await scenes.bindTarget(scene), { expectedRunId: 'run-1', tmuxTarget: scene.tmuxTarget });
  assert.equal((await scenes.listRuns())[0].runId, 'run-1');
  assert.equal(typeof await scenes.readScreen(scene), 'string');
});
test('single lists Origin identity but machine observation retains NULL scope', { timeout: 15000 }, async t => {
  const f = readyTmuxTarget(t, { prefix: 'supervisor-single-scene-', mode: 'single', runtimeProcess: true });
  const scenes = service(f, { readMode: () => ({ mode: 'single' }) });
  const listed = await scenes.observe({ configuration: { mode: 'single' } });
  assert.equal(listed[0].sessionGroup, 'origin'); assert.equal(listed[0].ready, true); assert.equal(listed[0].processRunning, true);
  const machine = await scenes.observeGroup(null);
  assert.equal(machine.sessionGroup, null); assert.equal(machine.ready, true);
  assert.ok(Number.isSafeInteger(machine.runtimePid));
  assert.deepEqual(machine.healthIdentity, { runtime: 'claude', session_id: 'session-1', claude_pid: machine.runtimePid });
  assert.deepEqual(machine.proc, { pid: machine.runtimePid, alive: true, last_sample_at: machine.proc.last_sample_at });
  assert.equal(Number.isFinite(machine.proc.last_sample_at), true);
});
test('pane liveness survives unavailable process scans and unreadable tmux is never absent', { timeout: 15000 }, async t => {
  const f = readyTmuxTarget(t, { prefix: 'supervisor-unknown-scene-', mode: 'multi' });
  const scenes = service(f, { readProcessTree: async () => { throw new Error('process snapshot unavailable'); } });
  assert.equal((await scenes.observeGroup('origin')).processRunning, true);
  const bad = service(f, { open: async () => { throw Object.assign(new Error('unobservable'), { code: 'TMUX_UNAVAILABLE' }); } });
  await assert.rejects(bad.readRun('origin'), { code: 'TMUX_UNAVAILABLE' });
});

// Complexity revision / identity guards must not sample activity or liveness.
test('identity-only checks skip process, usage and activity sampling and reject a changed run', { timeout: 15000 }, async t => {
  const f = readyTmuxTarget(t, { prefix: 'supervisor-identity-', mode: 'multi' });
  const unexpected = () => { throw Error('identity check sampled activity'); };
  const scenes = service(f, { readProcessTree: unexpected, readActivity: unexpected, readUsage: unexpected });
  const old = await scenes.readIdentity('origin');
  assert.equal(old.ready, true); assert.equal(old.runId, 'run-1');
  assert.deepEqual(await scenes.bindTarget(old), { expectedRunId:'run-1', tmuxTarget:old.tmuxTarget });
  assert.equal(typeof await scenes.readScreen(old), 'string');
  f.tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_RUN_ID', 'replacement');
  await assert.rejects(scenes.bindTarget(old), { code:'TARGET_MISMATCH' });
});
// health stops use the adapter's run fence and confirmed session removal.
test('health stop preserves a replacement run and confirms the original session is gone', { timeout:15000 }, async t => {
  const f = readyTmuxTarget(t, { prefix:'supervisor-health-stop-', mode:'multi' });
  f.tmux('new-session', '-d', '-s', 'fixture-keeper', 'sleep', '120');
  const scenes = service(f), old = await scenes.readIdentity('origin');
  f.tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_RUN_ID', 'replacement');
  await assert.rejects(scenes.stop(old), {code:'RUNID_MISMATCH'});
  assert.doesNotThrow(() => f.tmux('has-session', '-t', '=zylos-group-origin'));
  f.tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_RUN_ID', old.runId);
  await scenes.stop(old);
  assert.equal((await scenes.readIdentity('origin')).present, false);
  assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-keeper'));
});

// : identity checks must not replace full occupancy metadata.
test('identity checks preserve the full occupancy snapshot during tmux unavailability', { timeout:15000 }, async t => {
  const f = readyTmuxTarget(t, { prefix:'supervisor-identity-cache-', mode:'multi' });
  const base = service(f);
  const scenes = new SupervisorServerObservation(base, { guard:new SupervisorServerHealth() });
  const full = await scenes.observeGroup('origin');
  const identity = await scenes.readIdentity('origin');
  for (const key of ['runDir','createdAt','currentSessionTs']) assert.equal(Object.hasOwn(identity,key),false);
  base.observe = async () => { throw Object.assign(new Error('timeout'), {code:'TMUX_UNAVAILABLE',cause:'timeout'}); };
  const [cached] = await scenes.observe();
  // C log maintenance uses runDir; Codex exit classification uses currentSessionTs.
  assert.equal(path.join(cached.runDir, 'events.jsonl'), path.join(full.runDir, 'events.jsonl'));
  assert.equal(cached.currentSessionTs, full.currentSessionTs);
  assert.equal(cached.createdAt, full.createdAt);
  assert.equal(cached.present, true);
  assert.equal(cached.ready, false);
  assert.equal(cached.processRunning, undefined);
  assert.equal(cached.runId, null);
  assert.equal(cached.healthIdentity, undefined);
});

// New observation boundary: real private tmux identity and statusline file.
// Run when scene model/window extraction changes; no adapter commands changed.
test('scene threshold uses the identity-validated model and observed window', {timeout:15000}, async t => {
  const f=readyTmuxTarget(t,{prefix:'model-scene-',mode:'multi'});
  const scenes=service(f,{readUsage:undefined});
  const configuration={rotationPolicy:{model_rotation_thresholds:{claude:{'claude-sonnet-4-6':63,'claude-opus-4-6[1m]':36}}},defaultModels:{claude:'haiku'}};
  for(const [model,window,expected] of [['claude-sonnet-4-6',200000,63],['claude-opus-4-6',1000000,36]]){
    fs.writeFileSync(path.join(path.dirname(f.readyPath),'statusline.json'),JSON.stringify({session_id:'session-1',zylos:{v:1,runId:'run-1',capturedAt:Date.now()},model:{id:model},context_window:{context_window_size:window,used_percentage:50}}));
    const observed=await scenes.observeGroup('origin');
    assert.equal(observed.model,model);assert.equal(observed.contextWindow,window);assert.equal(observed.usagePercent,50);
    assert.equal(sceneRotationThreshold(observed,configuration),expected);
    const [batched]=await scenes.observe({configuration:{mode:'multi'}});
    assert.equal(batched.model,model);assert.equal(batched.contextWindow,window);assert.equal(batched.usagePercent,50);
  }
});


// Boundary: repeated READY observations and adapter calls on a private tmux
// socket. Run for pane observation/liveness changes; unrelated work may skip.
// readyTmuxTarget owns isolated environment, SQLite, processes and cleanup.
test('repeated multi READY observations and adapter liveness use pane PID without ps', {timeout:30000}, async t => {
  const f = readyTmuxTarget(t, {prefix:'supervisor-pane-liveness-',mode:'multi'});
  for (const group of ['alpha', 'beta']) {
    f.tmux('new-session','-d','-s',`zylos-group-${group}`,
      '-e','ZYLOS_RUN_ID=run-1','-e','ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}',
      '-e',`ZYLOS_SESSION_GROUP=${group}`,'sleep','120');
    const readyPath = path.join(f.root,'activity-monitor/session-groups',group,'current-session.json');
    fs.mkdirSync(path.dirname(readyPath),{recursive:true});
    fs.writeFileSync(readyPath,JSON.stringify(f.ready));
  }
  let treeCalls = 0;
  const forbiddenTree = async () => { treeCalls++; throw Error('READY observation scanned process tree'); };
  const scenes = service(f, {readProcessTree:forbiddenTree});
  const defaults = service(f);
  const adapter = new ClaudeAdapter({tmux:{socketPath:f.socketPath,binary:f.binary},env:f.env,readProcessTree:forbiddenTree});
  const defaultAdapter = new ClaudeAdapter({tmux:{socketPath:f.socketPath,binary:f.binary},env:f.env});
  const spawned = [], spawn = ChildProcess.prototype.spawn;
  t.mock.method(ChildProcess.prototype,'spawn',function(options) {
    spawned.push(path.basename(options.file));
    return spawn.call(this,options);
  });
  for (let round = 0; round < 4; round++) {
    for (const source of [scenes, defaults]) {
      const observed = await source.observe();
      assert.equal(observed.length,3);
      for (const scene of observed) {
        const panePid = Number(f.tmux('display-message','-p','-t',scene.tmuxTarget.paneId,'#{pane_pid}'));
        assert.equal(scene.ready,true); assert.equal(scene.processRunning,true);
        assert.equal(scene.runtimePid,panePid); assert.equal(scene.proc.pid,panePid); assert.equal(scene.proc.alive,true);
        assert.deepEqual(await adapter.isRunning({tmuxName:scene.tmuxName}),{tmux:true,process:true});
        assert.deepEqual(await defaultAdapter.isRunning({tmuxName:scene.tmuxName}),{tmux:true,process:true});
      }
    }
  }
  assert.equal(treeCalls,0);
  assert.equal(spawned.includes('ps'),false,`unexpected process snapshot: ${spawned.join(', ')}`);
});

// Boundary: batch scene sampling on a real private tmux socket; the fixture and
// official runner isolate all runtime paths and reclaim processes on failure.
// Run for polling/scene projection changes; unrelated lifecycle actions may skip.
for (const size of [6, 12]) test(`scene polling uses bounded tmux processes for ${size} groups and detects disappearance next round`, { timeout: 20000 }, async t => {
  const f = readyTmuxTarget(t, { prefix: 'scene-batch-', mode: 'multi' });
  for (let i = 1; i < size; i++) f.tmux('new-session', '-d', '-s', `zylos-group-extra${i}`, 'sleep', '120');
  const scenes = service(f);
  const spawn = ChildProcess.prototype.spawn;
  let spawned = 0;
  t.mock.method(ChildProcess.prototype, 'spawn', function(options) {
    if (options.file === f.binary || options.args?.includes(f.socketPath)) spawned++;
    return spawn.call(this, options);
  });
  const observed = await scenes.observe({ configuration: { mode: 'multi' } });
  assert.equal(observed.length, size);
  assert.equal(observed.find(scene => scene.sessionGroup === 'origin').ready, true);
  // Each bracket boundary reads panes and session-local environments in one batch.
  assert.ok(spawned <= 4, `scene polling spawned ${spawned} tmux processes for ${size} groups`);
  f.tmux('kill-session', '-t', '=zylos-group-origin');
  const next = await scenes.observe({ configuration: { mode: 'multi' } });
  assert.equal(next.some(scene => scene.sessionGroup === 'origin' && scene.present), false);
});

// Boundary: sampling callbacks change a real private tmux session inside the
// batch bracket. Run for sampling fences; unrelated lifecycle work may skip.
for (const phase of ['activity', 'usage']) for (const change of ['disappearance', 'replacement']) test(`batch scene rejects ${change} during ${phase} sampling`, {timeout:15000}, async t=>{
  const f=readyTmuxTarget(t,{prefix:'scene-sampling-',mode:'multi'});
  f.tmux('new-session','-d','-s','keeper','sleep','120');
  let activityCalls=0, usageCalls=0;
  const changeTarget=()=>{
    if(change==='disappearance')f.tmux('kill-session','-t','=zylos-group-origin');
    else f.tmux('set-environment','-t','=zylos-group-origin','ZYLOS_RUN_ID','replacement');
  };
  const scenes=service(f,{readActivity:()=>{activityCalls++;if(phase==='activity')changeTarget();return {state:'idle',idleSince:123};},
    readUsage:()=>{usageCalls++;if(phase==='usage')changeTarget();return 75;}});
  const [scene]=await scenes.observe({configuration:{mode:'multi'}});
  assert.equal(activityCalls,1);assert.equal(usageCalls,1);
  assert.ok(scene.observationError);assert.equal(scene.ready,false);
  assert.equal(scene.processRunning,undefined);assert.equal(scene.usagePercent,null);
});

// Boundary: source single/multi identities stay authoritative after F1 cutover,
// on real private tmux. Run for scope/transition changes; other work may skip.
for(const sourceMode of ['single','multi'])test(`batch observation preserves ${sourceMode} source scope across configuration cutover`,{timeout:15000},async t=>{
  const f=readyTmuxTarget(t,{prefix:'scene-source-scope-',mode:sourceMode});
  const destinationMode=sourceMode==='single'?'multi':'single';
  const scenes=service(f,{readMode:()=>{throw Error('batch observation reread mode');}});
  const [scene]=await scenes.observe({configuration:{mode:destinationMode}});
  assert.equal(scene.sessionGroup,'origin');assert.equal(scene.ready,true);
  const targets=await scenes.reader.readSessionTargets();
  const target=targets.get('origin');
  const rejected=await scenes.observeGroup('origin',{sample:{target},scope:sourceMode==='single'?'origin':null});
  assert.equal(rejected.ready,false);
});

// Boundary: real private tmux environment and READY, no authenticated runtime or
// services. Run for Origin scope/readiness changes; unrelated changes may skip.
// readyTmuxTarget owns its socket/process/database cleanup; the official runner
// isolates HOME, ZYLOS_DIR, PM2_HOME and a short TMPDIR.
for (const scoped of [true,false]) for (const mode of ['single','multi']) {
  const runtime = 'claude';
  test(`Origin observations derive ${scoped?'group':'global'} scope from its ${runtime} environment in ${mode}`, {timeout:15000}, async t => {
    const f = readyTmuxTarget(t, {prefix:'origin-scope-',mode:scoped?'multi':'single',runtime});
    const scenes = service(f, {readMode:()=>({mode})});
    for (const observed of [await scenes.observeGroup('origin'), await scenes.readIdentity('origin'),
      (await scenes.readIdentities(['origin'])).get('origin'), (await scenes.observe({configuration:{mode}}))[0]]) {
      assert.equal(observed.ready, true); assert.equal(observed.runId, 'run-1'); assert.equal(observed.runtime,runtime);
      assert.equal(observed.sourceScope, scoped?'origin':null);
    }
    assert.equal((await scenes.bindTarget(await scenes.readIdentity('origin'))).expectedRunId, 'run-1');
    t.diagnostic(JSON.stringify({socket:f.socketPath,root:f.root,mode,scoped}));
  });
}
