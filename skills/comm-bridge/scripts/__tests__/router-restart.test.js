import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './c4-v2-test-helpers.js';
import { createRouter } from '../router/scheduler.js';
import { tmuxNameForGroup } from '../../../../cli/lib/session-group-paths.js';

// Restart-state fixtures: close/reopen the persisted SQLite file and construct
// a fresh Router. Terminal/READY is injected; this is not a process-crash test.
function persistedRouter(t) {
  const now = 1800000000000;
  const dependencies = { now: () => now, readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) };
  let database = fixture(t, dependencies, true);
  let router;
  const scene = new Map(), current = new Map(), calls = [], events = [];
  let generation = 0, launchReady = false;
  const put = (group, values = {}) => {
    const live = { present: true, ready: true, runtime: 'claude', tmuxName: tmuxNameForGroup(group),
      runId: `run-${group}`, sessionId: `session-${group}`, createdAt: now / 1000, ...values };
    scene.set(group, live);
    if (live.ready) current.set(group, { runId: live.runId, sessionId: live.sessionId, startupControlIds: [] });
    return live;
  };
  put('origin');
  const api = () => ({ ...database.store,
    // Legacy ancillary operations are not exposed by createStore. D1 recovery,
    // claim and finalization, and D3 insert/claim use the real P01 implementation.
    getControlById: id => database.db.prepare('SELECT * FROM control_queue WHERE id=?').get(id),
    expireTimedOutControls: seconds => database.db.prepare("UPDATE control_queue SET status='timeout' WHERE status IN ('pending','running') AND ack_deadline_at<?").run(seconds).changes,
    cleanupControlQueue: cutoff => database.db.prepare("DELETE FROM control_queue WHERE status IN ('done','timeout','cancelled') AND created_at<?").run(cutoff).changes,
    recoverOrphanRunning: options => { calls.push(['recover', generation]); return database.store.recoverOrphanRunning(options); },
  });
  function prompts(group) {
    const recovery = database.store.insertControl('recovery', { sessionGroup: group, priority: 0, bypassState: true, appendAckSuffix: false });
    const prompt = database.store.insertControl('startup', { sessionGroup: group, priority: 2, appendAckSuffix: false });
    current.get(group).startupControlIds = [prompt.id];
    return [recovery.id, prompt.id];
  }
  function create() {
    generation++;
    router = createRouter({ db: api(), now: () => now,
      readSessionMode: () => ({ mode: 'multi', keyPresent: true }),
      readLiveIdentity: async group => scene.get(group) ?? { present: false, ready: false },
      listGroupTmuxSessions: async () => [...scene].map(([sessionGroup, live]) => ({ sessionGroup, tmuxName: live.tmuxName })),
      readCurrentSession: async group => current.get(group), readRuntimeHealth: () => ({ health: 'ok' }),
      getSessionAdapter: () => ({ launch: async input => {
        assert.equal(scene.has(input.sessionGroup), false, 'never launch a second managed scene for the group');
        calls.push(['launch', generation, input]);
        put(input.sessionGroup, { ready: launchReady, runId: input.runId });
        if (launchReady) calls.push(['prompts', generation, prompts(input.sessionGroup)]);
      }, stop: async input => { calls.push(['stop', generation, input]); scene.delete('a'); } }),
      submit: async () => assert.fail('healthy runtime must not register'),
      deliverControl: async row => {
        calls.push(['control', generation, row.id]);
        database.db.prepare("UPDATE control_queue SET status='done' WHERE id=? AND status='running'").run(row.id);
      },
      deliverConversation: async (row, live) => { calls.push(['conversation', generation, row.id]); database.store.markDelivered(row.id, { sessionId: live.sessionId }); },
      handleExpired: async () => {}, prepareSingle: async () => {}, findLegacySessions: async () => [], advanceLegacy: async () => {},
      diagnostic: (event, fields) => events.push({ generation, event, ...fields }),
      alert: (event, fields) => calls.push(['alert', generation, event, fields]),
    }, { poolSize: 1, readyTimeoutMs: 1000 });
    return router;
  }
  async function rounds(count) { for (let i = 0; i < count; i++) { router.tick(); await router.idle(); await new Promise(resolve => setImmediate(resolve)); } }
  async function restart() {
    await router.stop(); database.db.close();
    database = fixture(t, dependencies, database.filename);
    return create();
  }
  t.after(async () => { await router?.stop(); });
  return { create, restart, rounds, scene, current, calls, events, put, prompts,
    readyOnLaunch: () => { launchReady = true; },
    get db() { return database.store; }, get sqlite() { return database.db; },
    row: id => database.db.prepare('SELECT * FROM conversations WHERE id=?').get(id),
    add: () => { const row = database.store.insertConversation('in', 'a', 'endpoint', 'body');
      database.db.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(now / 1000, row.id); return row; }, now };
}

for (const sceneState of ['absent', 'unready', 'ready']) {
  test(`T01 restart-state fixture: running with ${sceneState} scene recovers before startup and business`, async t => {
    const f = persistedRouter(t); const row = f.add();
    const first = f.create(); await first.initialize(); await f.rounds(3);
    assert.equal(f.row(row.id).status, 'running'); assert.equal(first.state.activations.size, 1);
    const originalRun = f.scene.get('a').runId;
    let expected;
    if (sceneState === 'absent') { f.scene.delete('a'); f.readyOnLaunch(); }
    if (sceneState === 'ready') { f.put('a', { runId: originalRun }); expected = f.prompts('a'); }
    const second = await f.restart();
    await Promise.all([second.initialize(), second.initialize()]);
    assert.equal(second.state.activations.size, 0, 'private activation must not survive restart');
    assert.equal(f.row(row.id).status, 'pending'); assert.equal(f.row(row.id).retry_count, 1);
    if (sceneState === 'unready') {
      await f.rounds(3);
      assert.equal(f.row(row.id).status, 'pending'); assert.equal(second.availableCapacity(), 0);
      assert.equal(f.calls.some(x => x[1] === 2 && ['launch', 'conversation', 'stop'].includes(x[0])), false);
      f.put('a', { runId: originalRun }); expected = f.prompts('a');
    }
    await f.rounds(8);
    if (sceneState === 'absent') expected = f.calls.find(x => x[0] === 'prompts' && x[1] === 2)[2];
    const deliveries = f.calls.filter(x => x[1] === 2 && ['control', 'conversation'].includes(x[0])).map(x => [x[0], x[2]]);
    assert.deepEqual(deliveries, [['control', expected[0]], ['control', expected[1]], ['conversation', row.id]]);
    assert.equal(f.row(row.id).status, 'delivered'); assert.equal(f.row(row.id).retry_count, 1);
    assert.equal(f.calls.filter(x => x[0] === 'launch' && x[1] === 2).length, sceneState === 'absent' ? 1 : 0);
    await second.initialize(); await f.rounds(3);
    assert.deepEqual(f.calls.filter(x => x[0] === 'recover').map(x => x[1]), [1, 2]);
    assert.equal(f.calls.filter(x => x[0] === 'conversation' && x[1] === 2).length, 1);
    await second.stop();
  });
}

test('T01 persisted restart recovery respects 1799/1800/1801 and exhausted retry, logs each dead letter once', async t => {
  const f = persistedRouter(t); const first = f.create(); await first.initialize();
  const inputs = [[1799, 0], [1800, 0], [1801, 0], [20, 1]];
  const rows = inputs.map(([age, retry]) => {
    const row = f.add(); assert.equal(f.db.claimConversation(row.id), true);
    f.sqlite.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch'),retry_count=? WHERE id=?").run(f.now / 1000 - age, retry, row.id);
    return row;
  });
  f.db.setDrainFence('*');
  const second = await f.restart(); await second.initialize();
  assert.deepEqual(rows.map(row => [f.row(row.id).status, f.row(row.id).retry_count]), [['pending', 1], ['pending', 1], ['failed', 0], ['failed', 2]]);
  await second.initialize(); await f.rounds(5);
  assert.deepEqual(f.calls.filter(x => x[0] === 'recover').map(x => x[1]), [1, 2]);
  const events = f.events.filter(x => x.generation === 2);
  assert.deepEqual(events.filter(x => x.event === 'orphan_expired').map(x => x.conversation_id), [rows[2].id]);
  assert.deepEqual(events.filter(x => x.event === 'orphan_retry_exhausted').map(x => x.conversation_id), [rows[3].id]);
  assert.equal(events.filter(x => x.event === 'orphan_recovery_summary').length, 1);
  assert.equal(events.find(x => x.event === 'orphan_recovery_summary').oldestId, rows[0].id);
  assert.equal(f.calls.some(x => x[1] === 2 && ['launch', 'conversation'].includes(x[0])), false);
  await second.stop();
});
