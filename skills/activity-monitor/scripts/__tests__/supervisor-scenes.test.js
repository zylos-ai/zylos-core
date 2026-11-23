import test from 'node:test';
import assert from 'node:assert/strict';

import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { SupervisorScenes } from '../supervisor-scenes.js';

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
test('pane liveness survives unavailable process scans and unreadable tmux is never absent', { timeout: 15000 }, async t => {
  const f = readyTmuxTarget(t, { prefix: 'supervisor-unknown-scene-', mode: 'multi' });
  const scenes = service(f, { readProcessTree: async () => { throw new Error('process snapshot unavailable'); } });
  assert.equal((await scenes.observeGroup('origin')).processRunning, true);
  const bad = service(f, { open: async () => { throw Object.assign(new Error('unobservable'), { code: 'TMUX_UNAVAILABLE' }); } });
  await assert.rejects(bad.readRun('origin'), { code: 'TMUX_UNAVAILABLE' });
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

