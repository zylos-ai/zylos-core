import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { SupervisorScenes } from '../supervisor-scenes.js';
import { SupervisorServerObservation } from '../supervisor-server-observation.js';
import { SupervisorServerHealth } from '../supervisor-server-health.js';

function service(f, options = {}) {
  return new SupervisorScenes({ env: f.env, connectionOptions: { socketPath: f.socketPath, binary: f.binary },
    readMode: () => ({ mode: 'multi' }), readActivity: () => ({ state: 'idle', idleSince: 123 }),
    readUsage: () => null, ...options });
}
// real observations use same target facts and distinguish runtime from tmux.
test('scene joins real READY and process identity without treating configured F2 as liveness', { timeout: 15000 }, async t => {
  const f = readyTmuxTarget(t, { prefix: 'supervisor-scene-', mode: 'multi' });
  const scenes = service(f), scene = await scenes.observeGroup('origin');
  assert.equal(scene.ready, true); assert.equal(scene.runtime, 'claude'); assert.equal(scene.processRunning, false);
  assert.equal(scene.runId, 'run-1'); assert.equal(scene.sessionId, 'session-1');
  assert.equal(scene.currentSessionTs, 1); assert.equal(scene.createdAt % 1000, 0);
  assert.equal(scene.state, 'idle'); assert.equal(scene.idleSince, 123); assert.equal(scene.usagePercent, null);
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
test('unknown process data remains unknown and unreadable tmux is never absent', { timeout: 15000 }, async t => {
  const f = readyTmuxTarget(t, { prefix: 'supervisor-unknown-scene-', mode: 'multi' });
  const scenes = service(f, { readProcessTree: async () => { throw new Error('process snapshot unavailable'); } });
  assert.equal((await scenes.observeGroup('origin')).processRunning, undefined);
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
