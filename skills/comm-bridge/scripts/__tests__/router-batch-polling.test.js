import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ChildProcess } from 'node:child_process';
import { createSessionReader } from '../../../../cli/lib/session-state-reader-async.js';
import { listGroupTmuxSessions } from '../../../../cli/lib/session-group-paths.js';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { routerFixture } from './helpers/router-fixture.js';

// Boundary: production router, real SQLite and reader on a private tmux socket.
// Run for scheduler lifecycle polling changes; unrelated delivery/UI changes
// may skip. The official runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR, and both
// fixtures clean their own database, tmux server and processes on failure.
for (const size of [6, 12]) test(`idle router maintains batched lifecycle observation with ${size} live groups`, { timeout: 20000 }, async t => {
  const target = readyTmuxTarget(t, { prefix: 'router-batch-', mode: 'multi' });
  for (let i = 1; i < size; i++) {
    const group = `extra${i}`;
    target.tmux('new-session', '-d', '-s', `zylos-group-${group}`,
      '-e', 'ZYLOS_RUN_ID=run-1', '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}',
      '-e', `ZYLOS_SESSION_GROUP=${group}`, 'sleep', '120');
    const readyPath = path.join(target.root, 'activity-monitor/session-groups', group, 'current-session.json');
    fs.mkdirSync(path.dirname(readyPath), { recursive: true });
    fs.writeFileSync(readyPath, JSON.stringify(target.ready));
  }
  const f = routerFixture(t);
  const connectionOptions = { socketPath: target.socketPath, binary: target.binary };
  const reader = createSessionReader({ env: target.env, connectionOptions });
  let batches = 0, singles = 0, listings = 0;
  f.deps.readLiveIdentities = async groups => { batches++; return reader.readLiveIdentities(groups); };
  f.deps.readLiveIdentity = async group => { singles++; return reader.readLiveIdentity(group); };
  f.deps.listGroupTmuxSessions = async () => { listings++; return listGroupTmuxSessions(connectionOptions); };
  const router = f.create();
  await router.initialize(); await router.idle();
  batches = 0; singles = 0; listings = 0;
  await f.rounds(4);
  assert.equal(batches, 4); assert.equal(singles, 0); assert.equal(listings, 4);
  batches = 0; listings = 0;
  f.db.insertControl('queued control', { sessionGroup: 'origin', priority: 1, appendAckSuffix: false });
  let spawned = 0;
  const spawn = ChildProcess.prototype.spawn;
  t.mock.method(ChildProcess.prototype, 'spawn', function(options) {
    if (options.file === target.binary || options.args?.includes(target.socketPath)) spawned++;
    return spawn.call(this, options);
  });
  await f.rounds(1);
  assert.equal(batches, 1); assert.equal(singles, 0); assert.equal(listings, 1);
  assert.ok(spawned <= 3, `periodic scene spawned ${spawned} tmux processes for ${size} groups`);
});

// Boundary: real router, SQLite, batched reader and private tmux scenes, with
// launch/stop as instrumented external actions. Run when activation readiness
// polling changes; unrelated UI/delivery work may skip. Official runner and
// fixture own isolated HOME/ZYLOS_DIR/PM2_HOME/TMPDIR, socket, database and cleanup.
for (const size of [6, 12]) test(`pending ${size} activations share readiness polling and reacquire identity only for timeout cleanup`, { timeout: 20000 }, async t => {
  const target = readyTmuxTarget(t, { prefix: 'activation-batch-', mode: 'multi' });
  const f = routerFixture(t, { poolSize: size, readyTimeoutMs: 10000 });
  const connectionOptions = { socketPath: target.socketPath, binary: target.binary };
  const reader = createSessionReader({ env: target.env, connectionOptions });
  let singles = 0, batches = 0;
  const stopped = [];
  f.deps.readLiveIdentities = async groups => { batches++; return reader.readLiveIdentities(groups); };
  f.deps.readLiveIdentity = async group => { singles++; return reader.readLiveIdentity(group); };
  f.deps.listGroupTmuxSessions = () => listGroupTmuxSessions(connectionOptions);
  f.deps.getSessionAdapter = () => ({
    launch: async input => target.tmux('new-session', '-d', '-s', `zylos-group-${input.sessionGroup}`,
      '-e', `ZYLOS_RUN_ID=${input.runId}`, '-e', `ZYLOS_MODEL_CONFIG=${JSON.stringify(input.launchConfig)}`,
      '-e', `ZYLOS_SESSION_GROUP=${input.sessionGroup}`, 'sleep', '120'),
    stop: async input => { stopped.push({ ...input, singleReads: singles }); },
  });
  const rows = Array.from({ length: size }, (_, i) => f.add(`pending${i}`));
  const router = f.create(); await router.initialize(); await f.rounds(3);
  assert.equal(router.state.activations.size, size);
  for (const activation of router.state.activations.values()) assert.equal(activation.launchSettled, true);
  singles = 0; batches = 0;
  let tmuxProcesses = 0;
  const spawn = ChildProcess.prototype.spawn;
  t.mock.method(ChildProcess.prototype, 'spawn', function(options) {
    if (options.file === target.binary || options.args?.includes(target.socketPath)) tmuxProcesses++;
    return spawn.call(this, options);
  });
  await f.rounds(3);
  assert.equal(batches, 3); assert.equal(singles, 0); assert.equal(stopped.length, 0);
  assert.equal(tmuxProcesses, 6);
  for (const row of rows) assert.equal(f.row(row.id).status, 'running');
  // Check absence of a batch identity and a READY from a different run as well.
  const group = 'pending0', activation = router.state.activations.get(group);
  router.state.live.delete(group);
  await router.state.lanes.get(group).kick();
  f.current.set(group, { runId: activation.runId, sessionId: 'prelaunch', startupControlIds: [] });
  router.state.live.set(group, { present: true, ready: true, runtime: 'claude', runId: activation.runId, sessionId: 'prelaunch' });
  activation.launchSettled = false;
  await router.state.lanes.get(group).kick();
  assert.equal(f.row(rows[0].id).status, 'running');
  activation.launchSettled = true;
  f.current.set(group, { runId: 'prior-run', sessionId: 'prior-session', startupControlIds: [] });
  router.state.live.set(group, { present: true, ready: true, runtime: 'claude', runId: 'prior-run', sessionId: 'prior-session' });
  await router.state.lanes.get(group).kick();
  assert.equal(singles, 0); assert.equal(f.row(rows[0].id).status, 'running');
  assert.equal(router.state.activations.get(group), activation);
  f.advance(10000);
  for (const [key, current] of router.state.activations) {
    const before = singles;
    await router.state.lanes.get(key).kick();
    assert.equal(singles, before + 1);
    assert.equal(stopped.at(-1).singleReads, singles);
    assert.equal(stopped.at(-1).expectedRunId, current.runId);
  }
  assert.equal(singles, size); assert.equal(stopped.length, size);
  assert.equal(router.state.activations.size, 0);
});

for (const failure of ['rejected batch', 'missing group']) test(`a ${failure} invalidates all cached identities and blocks capacity`, async t => {
  const f = routerFixture(t); f.put('origin'); f.put('a');
  const router = f.create(); await router.initialize(); await router.idle();
  assert.equal(router.state.live.get('a').ready, true);
  f.deps.readLiveIdentities = async () => {
    if (failure === 'rejected batch') throw Object.assign(new Error('offline'), { code: 'TMUX_UNAVAILABLE' });
    return new Map([['origin', f.scene.get('origin')]]);
  };
  router.tick(); await router.idle();
  assert.equal(router.state.live.size, 0);
  assert.equal(router.state.sceneObservable, false);
  assert.equal(router.availableCapacity(), 0);
  assert.ok(f.events.some(row => row.event === 'scene_unobservable'));
});

test('idle ready lanes retain supplementary Enter retries without single identity reads', async t => {
  const f = routerFixture(t); f.put('origin'); f.put('a');
  const enters = [];
  f.deps.maybePeriodicEnter = async group => enters.push(group);
  const router = f.create(); await router.initialize(); await router.idle();
  let singles = 0;
  f.deps.readLiveIdentity = async () => { singles++; throw new Error('periodic single read'); };
  await f.rounds(3);
  assert.equal(singles, 0);
  assert.equal(enters.filter(group => group === 'a').length, 3);
  assert.equal(enters.filter(group => group === 'origin').length, 3);
});

test('a READY activation clears a continuation recorded after its batch observation', async t => {
  const f = routerFixture(t); f.put('origin'); f.put('a');
  const router = f.create(); await router.initialize(); await f.rounds(3);
  // Pin a launch while recording a new restart marker after the shared snapshot.
  const live = f.scene.get('a');
  router.state.live.set('a', live);
  router.state.activations.set('a', { group: 'a', runId: live.runId, launchSettled: true, launchStarted: true,
    startedAt: f.now(), launchConfig: live.launchConfig, message: null });
  f.db.recordRunEnd('a', { runId: 'prior-run', reason: 'unexpected' });
  assert.equal(f.db.listRunEndings(['a'])[0].continuationPending, 1);
  await router.state.lanes.get('a').kick();
  assert.equal(f.db.listRunEndings(['a'])[0].continuationPending, 0);
});

test('a settled launch error reacquires identity and converges before the READY timeout', async t => {
  const f = routerFixture(t); f.put('origin');
  let afterLaunch = false, convergenceReads = 0;
  const read = f.deps.readLiveIdentity;
  f.deps.readLiveIdentity = async group => { if (afterLaunch) convergenceReads++; return read(group); };
  f.deps.getSessionAdapter = () => ({ launch: async () => {
      afterLaunch = true; throw Object.assign(new Error('failed'), { code: 'LAUNCH_FAILED' });
    }, stop: async input => { f.calls.push(['stop', input]); } });
  const row = f.add('a'); const router = f.create(); await router.initialize();
  const startedAt = f.now();
  await f.rounds(2);
  assert.equal(convergenceReads, 1);
  assert.equal(f.now() - startedAt, 0);
  assert.equal(router.state.activations.has('a'), false);
  assert.equal(f.calls.filter(call => call[0] === 'stop').length, 1);
  assert.equal(f.row(row.id).status, 'pending');
  assert.ok(f.events.some(event => event.event === 'activate_failed'));
});
