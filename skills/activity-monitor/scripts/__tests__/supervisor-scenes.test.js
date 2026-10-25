import test from 'node:test';
import assert from 'node:assert/strict';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { SupervisorScenes } from '../supervisor-scenes.js';

function service(f, options = {}) {
  return new SupervisorScenes({ env: f.env, connectionOptions: { socketPath: f.socketPath, binary: f.binary },
    readMode: () => ({ mode: 'multi' }), readActivity: () => ({ state: 'idle', idleSince: 123 }),
    readUsage: () => null, ...options });
}
// P05 T01/T05: real observations use same target facts and distinguish runtime from tmux.
test('scene joins real READY and process identity without treating configured F2 as liveness', { timeout: 15000 }, async t => {
  const f = readyTmuxTarget(t, { prefix: 'p05-scene-', mode: 'multi' });
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
  const f = readyTmuxTarget(t, { prefix: 'p05-single-scene-', mode: 'single', runtimeProcess: true });
  const scenes = service(f, { readMode: () => ({ mode: 'single' }) });
  const listed = await scenes.observe({ configuration: { mode: 'single' } });
  assert.equal(listed[0].sessionGroup, 'origin'); assert.equal(listed[0].ready, true); assert.equal(listed[0].processRunning, true);
  const machine = await scenes.observeGroup(null);
  assert.equal(machine.sessionGroup, null); assert.equal(machine.ready, true);
  assert.ok(Number.isSafeInteger(machine.runtimePid));
  assert.deepEqual(machine.healthIdentity, { runtime: 'claude', session_id: 'session-1', claude_pid: machine.runtimePid });
  assert.equal(machine.proc.pid, machine.runtimePid); assert.equal(machine.proc.alive, true);
  assert.ok(Number.isFinite(machine.contextSwitches));
});
// P05 T07 / IF-36: fixed persisted object never resolves a replacement name.
test('manual target is immutable through rename; stopping it preserves same-name replacement', { timeout: 15000 }, async t => {
  const f = readyTmuxTarget(t, { prefix: 'p05-fixed-scene-', mode: 'multi' });
  const scenes = service(f), old = await scenes.readRun('origin');
  f.tmux('rename-session', '-t', '=zylos-group-origin', 'old-renamed');
  f.tmux('new-session', '-d', '-s', 'zylos-group-origin', '-e', 'ZYLOS_RUN_ID=new-run', 'sleep', '120');
  const request = { expectedRunId: old.runId, tmuxTarget: old.tmuxTarget };
  assert.equal((await scenes.observeFixedTarget(request)).present, true);
  await scenes.stopFixedTarget(request);
  assert.equal((await scenes.observeFixedTarget(request)).present, false);
  assert.equal(f.tmux('show-environment', '-t', '=zylos-group-origin', 'ZYLOS_RUN_ID'), 'ZYLOS_RUN_ID=new-run');
});
test('lost pane does not prove session stopped; fixed session cleanup preserves unrelated target', { timeout: 15000 }, async t => {
  const f = readyTmuxTarget(t, { prefix: 'p05-fixed-pane-', mode: 'multi' });
  const scenes = service(f), old = await scenes.readRun('origin');
  f.tmux('new-session', '-d', '-s', 'fixture-keeper', 'sleep', '120');
  f.tmux('split-window', '-d', '-t', '=zylos-group-origin:', 'sleep', '120');
  f.tmux('kill-pane', '-t', old.tmuxTarget.paneId);
  const request = { expectedRunId: old.runId, tmuxTarget: old.tmuxTarget };
  assert.equal((await scenes.observeFixedTarget(request)).present, true);
  await scenes.stopFixedTarget(request);
  assert.equal((await scenes.observeFixedTarget(request)).present, false);
  assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-keeper'));
});
test('run identity mutation fails closed and cannot kill the changed object', { timeout: 15000 }, async t => {
  const f = readyTmuxTarget(t, { prefix: 'p05-run-mismatch-', mode: 'multi' });
  const scenes = service(f), old = await scenes.readRun('origin');
  f.tmux('set-environment', '-t', '=zylos-group-origin', 'ZYLOS_RUN_ID', 'other');
  const request = { expectedRunId: old.runId, tmuxTarget: old.tmuxTarget };
  await assert.rejects(scenes.observeFixedTarget(request), { code: 'RUNID_MISMATCH' });
  await assert.rejects(scenes.stopFixedTarget(request), { code: 'RUNID_MISMATCH' });
  assert.doesNotThrow(() => f.tmux('has-session', '-t', '=zylos-group-origin'));
});
test('unknown process data remains unknown and unreadable tmux is never absent', { timeout: 15000 }, async t => {
  const f = readyTmuxTarget(t, { prefix: 'p05-unknown-scene-', mode: 'multi' });
  const scenes = service(f, { readProcessTree: async () => { throw new Error('process snapshot unavailable'); } });
  assert.equal((await scenes.observeGroup('origin')).processRunning, undefined);
  const bad = service(f, { open: async () => { throw Object.assign(new Error('unobservable'), { code: 'TMUX_UNAVAILABLE' }); } });
  await assert.rejects(bad.readRun('origin'), { code: 'TMUX_UNAVAILABLE' });
});
