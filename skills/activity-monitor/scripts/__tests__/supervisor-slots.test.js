import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixture as databaseFixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { SupervisorRunEndings } from '../supervisor-run-endings.js';
import { routerFixture } from '../../../comm-bridge/scripts/__tests__/helpers/router-fixture.js';
import { PRE_RECLAIM_CHECK_PROMPT } from '../reclaim-prompts.js';
import { SupervisorLifecycle } from '../supervisor-lifecycle.js';

// Integration boundary: real Store, reconciliation, lifecycle completion and slot
// transactions; run for occupancy/reclaim wiring changes, skip unrelated UI work.
// Runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; this fixture owns a private
// run root and in-memory SQLite. Scene I/O is injected, no tmux/runtime/network.
// No processes or timers are started; close SQLite and remove only owned files.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'supervisor-slots-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f = { root, now: 2_000_000, errors: [], live: new Map(), observable: true,
    context: { configuration: { mode: 'multi' }, transition: null, fences: [], scenes: [] } };
  const { db, store } = databaseFixture(t, { now: () => f.now });
  Object.assign(f, { db, store });
  f.service = new SupervisorRunEndings({ db: store, env: { ZYLOS_DIR: root }, now: () => f.now,
    readIdentity: group => f.live.get(group) ?? { present: false }, isObservable: () => f.observable,
    reportError: e => f.errors.push(e) });
  f.take = (group = 'test:group', runId = 'old') => store.takeSlot(group, { runId, k: 4 });
  f.write = async (runId = 'old') => {
    const dir = path.join(root, 'activity-monitor/session-groups/test:group');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'current-session.json'), JSON.stringify({ runId, ts: f.now - 1000 }));
  };
  f.rows = () => store.listSlotOccupancy();
  return f;
}

test('orphan startup occupancy survives until the readiness deadline without a session file', async t => {
  const f = await fixture(t); f.take(); f.now += 29999;
  await f.service.advance(f.context); assert.equal(f.rows().length, 1);
  assert.equal(f.store.takeSlot('test:group', { runId: 'next', k: 4 }).reason, 'own_running');
  f.now++; await f.service.advance(f.context); assert.equal(f.rows().length, 0);
  assert.equal(f.store.listRunEndings(['test:group']).length, 0);
  assert.equal(f.store.takeSlot('test:group', { runId: 'next', k: 4 }).taken, true);
});

test('reconciliation records before pruning so a crashed run retains its occupancy', async t => {
  const f = await fixture(t); f.take(); await f.write(); f.now += 31000;
  await f.service.advance(f.context);
  assert.equal(f.store.listRunEndings(['test:group'])[0].reason, 'unexpected');
  assert.equal(f.rows()[0].state, 'held');
  assert.equal(f.rows()[0].heldUntil, Math.floor(f.now / 1000) + 120);
});

// Integration boundary: real Router admission, lifecycle LRU selection/reclaim,
// and Store occupancy transactions. Run for current-capacity admission or reclaim
// wiring changes; skip unrelated runtime adapters and UI. The official runner
// isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/TMUX_TMPDIR; memory SQLite and
// injected scene/stop I/O create no tmux/socket/process/network resources.
// Router stop and database closure are bound to the fixture's test teardown.
test('lower capacity admits a waiting group only after both required idle reclaims complete', async t => {
  let capacity = 4;
  const f = routerFixture(t, { poolSize: () => capacity });
  f.put('origin');
  for (const [group, age, state] of [
    ['test:older', 600000, 'idle'],
    ['test:busy', 1200000, 'busy'],
    ['test:oldest', 900000, 'idle'],
    ['test:recent', 100000, 'idle'],
  ]) {
    f.put(group, { createdAt: Math.floor((f.now() - age) / 1000),
      lastActivityAt: f.now() - age, idleSince: f.now() - age, processRunning: true, state });
  }
  await f.create().initialize(); await f.rounds(3);
  assert.equal(f.db.listSlotOccupancy().length, 4);
  assert.equal(f.router.availableCapacity(), 0);
  capacity = 3;
  await f.rounds(2);
  assert.equal(f.router.availableCapacity(), -1);

  const stops = [], admissionLimits = [];
  const takeSlot = f.db.takeSlot;
  f.db.takeSlot = (group, options) => {
    if (group === 'test:waiting' && options.k !== 100000) admissionLimits.push(options.k);
    return takeSlot(group, options);
  };
  const lifecycle = new SupervisorLifecycle({ db: f.db,
    observeGroup: async group => {
      const live = f.scene.get(group);
      return live ? { ...live, sessionGroup: group, createdAt: live.createdAt * 1000 } : { present: false };
    },

    bindTarget: scene => ({ expectedRunId: scene.runId, tmuxTarget: { serverGeneration: 'private-server', sessionId: '$1', paneId: '%1' } }),
    prompts: { PRE_RECLAIM_CHECK_PROMPT },
    stop: async scene => {
      assert.equal(f.scene.get(scene.sessionGroup)?.runId, scene.runId);
      stops.push(scene.sessionGroup);
      await f.deps.session.stop({ tmuxName: scene.tmuxName, expectedRunId: scene.runId });
    },
  }, { now: f.now });
  const context = { configuration: { mode: 'multi', capacity }, transition: null, restartRequests: [],
    fences: f.db.listDrainFences(), scenes: [...f.scene].map(([sessionGroup, live]) =>
      ({ ...live, sessionGroup, createdAt: live.createdAt * 1000 })) };
  assert.equal((await lifecycle.checkEviction(context.scenes, context)).need, 0);
  assert.equal(f.db.listDrainFences().length, 0);
  const message = f.add('test', { groupName: 'waiting' });
  await f.rounds(3);
  assert.equal(f.row(message.id).status, 'pending');
  assert.equal(f.scene.has('test:waiting'), false);
  assert.equal(admissionLimits.length, 0);

  assert.deepEqual((await lifecycle.evictionCandidates(context.scenes, context)).map(scene => scene.sessionGroup),
    ['test:oldest', 'test:older']);
  assert.deepEqual(await lifecycle.checkEviction(context.scenes, context),
    { waiting: 1, free: -1, inflight: 0, need: 2, selected: 0, preparing: 2 });
  const checks = () => f.sqlite.prepare('SELECT id, session_group, status FROM control_queue WHERE raw_content=? ORDER BY id').all(PRE_RECLAIM_CHECK_PROMPT);
  assert.deepEqual(checks().map(row => row.session_group), ['test:oldest', 'test:older']);
  assert.equal(f.db.listDrainFences().length, 0);
  // One check is acknowledged; the other is still unanswered when its short deadline passes.
  f.sqlite.prepare("UPDATE control_queue SET status='done' WHERE id=?").run(checks()[0].id);
  f.advance(60000);
  assert.deepEqual(await lifecycle.checkEviction(context.scenes, context),
    { waiting: 1, free: -1, inflight: 0, need: 2, selected: 2, preparing: 0 });
  assert.equal(checks().length, 2);
  // C4 marks the unanswered check timed out at the same deadline.
  f.sqlite.prepare("UPDATE control_queue SET status='timeout' WHERE id=?").run(checks()[1].id);
  assert.equal(f.db.getDrainFence('test:busy'), null);
  assert.equal(f.db.getDrainFence('test:recent'), null);

  assert.equal(await lifecycle.advanceReclaim(f.db.getDrainFence('test:oldest'), context), 'done');
  assert.equal(f.db.listSlotOccupancy().length, 3);
  await f.rounds(3);
  assert.equal(f.row(message.id).status, 'pending');
  assert.equal(f.scene.has('test:waiting'), false);
  assert.equal(admissionLimits.length, 0);
  assert.equal(await lifecycle.advanceReclaim(f.db.getDrainFence('test:older'), context), 'done');
  assert.equal(f.db.listSlotOccupancy().length, 2);
  await f.rounds(4);
  assert.equal(f.row(message.id).status, 'delivered');
  assert.equal(f.scene.has('test:waiting'), true);
  assert.deepEqual(admissionLimits, [3]);
  assert.deepEqual(stops, ['test:oldest', 'test:older']);
  assert.equal(f.scene.has('test:busy'), true);
  assert.equal(f.scene.has('test:recent'), true);
  assert.equal(f.db.listSlotOccupancy().length, 3);
  assert.deepEqual(f.db.listRunEndings(['test:oldest', 'test:older']).map(row => row.reason), ['evict', 'evict']);
  assert.equal(f.db.listPendingContinuations().length, 0);
  assert.equal(f.db.listDrainFences().length, 0);
});
