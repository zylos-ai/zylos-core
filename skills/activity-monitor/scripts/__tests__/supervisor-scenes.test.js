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
  const facts = { state: 'idle', idleSince: 123, lastActivityAt: 100,
    activeSubagents: [{ agentId: 'child', lastActivityAt: 456 }], lastSubagentActivityAt: 456 };
  const scenes = service(f, { readActivity: () => facts }), scene = await scenes.observeGroup('origin');
  assert.equal(scene.ready, true); assert.equal(scene.runtime, 'claude'); assert.equal(scene.processRunning, true);
  assert.equal(scene.runId, 'run-1'); assert.equal(scene.sessionId, 'session-1');
  assert.equal(scene.currentSessionTs, 1); assert.equal(scene.createdAt % 1000, 0);
  assert.equal(scene.state, 'idle'); assert.equal(scene.idleSince, 123); assert.equal(scene.usagePercent, null);
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
