import test from 'node:test';
import assert from 'node:assert/strict';
import { routerFixture, deferred, flush } from './helpers/router-fixture.js';
import path from 'node:path';
import { SupervisorRunEndings } from '../../../activity-monitor/scripts/supervisor-run-endings.js';

// Integration boundary: real Router and C4 store, injected scene/runtime I/O
// and clock. Run for ready-session adoption or capacity ordering changes; skip
// unrelated UI work. Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short
// TMPDIR; SQLite is private and no tmux, PM2, network or runtime is contacted.
// Router work is stopped by the fixture; every held launch is released in cleanup.
function ready(f, group, runId, values = {}) {
  const live = f.identity(group, { runId, ...values });
  f.scene.set(group, live);
  if (live.ready) f.current.set(group, { runId, sessionId: live.sessionId, startupControlIds: [], ts: f.now() });
  return live;
}
async function start(f, rounds = 2) {
  f.put('origin', { runtime: 'codex' });
  await f.create().initialize();
  await f.router.idle();
  await f.rounds(rounds);
}
function countAdoptions(f) {
  const adopt = f.db.adoptSlot;
  const calls = [];
  f.db.adoptSlot = (group, options) => { calls.push([group, options.runId]); return adopt(group, options); };
  return calls;
}
async function pump(count = 6) { for (let i = 0; i < count; i++) await flush(); }

test('ready sessions are adopted before an observed waiting group receives newly free capacity', async t => {
  const f = routerFixture(t, { poolSize: 1, readyTimeoutMs: 10000 });
  f.db.takeSlot('blocker', { runId: 'blocker-run', k: 1 });
  const waiting = f.add('waiting');
  ready(f, 'arrived', 'late-run', { ready: false });
  const adoptions = countAdoptions(f);
  await start(f);
  assert.equal(f.router.state.live.get('waiting').present, false);
  ready(f, 'arrived', 'late-run');
  f.router.tick(); await pump();
  assert.equal(f.router.state.live.get('arrived').ready, true);
  assert.equal(adoptions.length, 0, 'this round observed readiness after synchronous scheduling');
  assert.deepEqual(f.db.releaseSlot('blocker', { runId: 'blocker-run', prior: null }), { released: true });
  assert.equal(f.db.listSlotOccupancy().length, 0);
  f.router.tick();
  assert.deepEqual(adoptions, [['arrived', 'late-run']]);
  assert.equal(f.db.listSlotOccupancy().length, 1);
  assert.equal(f.router.availableCapacity(), 0);
  await f.router.idle(); await pump();
  assert.equal(f.calls.filter(row => row[0] === 'launch').length, 0);
  assert.equal(f.row(waiting.id).status, 'pending');
});

test('an existing development scene is adopted even when its row count exceeds capacity', async t => {
  const f = routerFixture(t, { poolSize: 1 });
  ready(f, 'a', 'a-run'); ready(f, 'b', 'b-run');
  const adoptions = countAdoptions(f);
  await start(f);
  assert.equal(adoptions.length, 2);
  assert.deepEqual(f.db.listSlotOccupancy().map(row => row.sessionGroup), ['a', 'b']);
  assert.equal(f.router.availableCapacity(), -1);
  assert.equal(f.calls.filter(row => row[0] === 'stop').length, 0);
});

test('a late session is adopted only after its scene becomes ready', async t => {
  const f = routerFixture(t, { readyTimeoutMs: 10000 });
  ready(f, 'a', 'late-run', { ready: false });
  const adoptions = countAdoptions(f);
  await start(f);
  assert.equal(adoptions.length, 0);
  assert.equal(f.db.listSlotOccupancy().length, 0);
  ready(f, 'a', 'late-run'); await f.rounds(2);
  assert.deepEqual(adoptions, [['a', 'late-run']]);
  assert.equal(f.db.listSlotOccupancy()[0].runId, 'late-run');
});

for (const prior of ['running', 'held', 'expired held']) {
  test(`a ready late session replaces a stale ${prior} row`, async t => {
    const f = routerFixture(t);
    f.db.takeSlot('a', { runId: 'old-run', k: 1 });
    if (prior !== 'running') f.db.recordRunEnd('a', { runId: 'old-run', reason: 'upgrade' });
    if (prior === 'expired held') f.advance(120000);
    ready(f, 'a', 'late-run');
    await start(f);
    const rows = f.db.listSlotOccupancy();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].runId, 'late-run');
    assert.equal(rows[0].state, 'running');
    assert.equal(rows[0].heldUntil, null);
    assert.equal(f.calls.filter(row => row[0] === 'stop').length, 0);
  });
}

test('an ending recorded after scene observation prevents re-adopting its held row', async t => {
  const f = routerFixture(t);
  f.db.takeSlot('a', { runId: 'already-ended', k: 1 });
  ready(f, 'a', 'already-ended');
  // Make the snapshot look rowless, then let the ending transaction win before
  // adoption. The returned ended result must not become an in-memory running row.
  const list = f.db.listSlotOccupancy, adopt = f.db.adoptSlot;
  let observed = false, ended;
  f.db.listSlotOccupancy = () => { const rows = list(); if (!observed) { observed = true; return []; } return rows; };
  f.db.adoptSlot = (group, options) => {
    f.db.recordRunEnd(group, { runId: options.runId, reason: 'upgrade' });
    ended = adopt(group, options);
    return ended;
  };
  await start(f, 1);
  assert.deepEqual(ended, { adopted: false, reason: 'ended' });
  const rows = list();
  assert.equal(rows.length, 1); assert.equal(rows[0].state, 'held');
  assert.equal(rows[0].heldUntil, Math.floor(f.now() / 1000) + 120);
});

test('one adoption error leaves delivery available and the next round repairs the row', async t => {
  const f = routerFixture(t); ready(f, 'a', 'late-run');
  const message = f.add('a');
  const adopt = f.db.adoptSlot; let attempts = 0;
  f.db.adoptSlot = (...args) => {
    if (++attempts === 1) throw Object.assign(new Error('busy'), { code: 'DB_BUSY' });
    return adopt(...args);
  };
  await start(f, 1);
  assert.equal(attempts, 1);
  assert.equal(f.row(message.id).status, 'delivered');
  assert.equal(f.db.listSlotOccupancy().length, 0);
  assert.ok(f.events.some(row => row.event === 'slot_adoption_failed' && row.session_group === 'a' && row.reason === 'DB_BUSY'));
  await f.rounds(1);
  assert.equal(attempts, 2);
  assert.equal(f.db.listSlotOccupancy()[0].runId, 'late-run');
});

test('a stale ready observation cannot restore deleted occupancy and block queued recreation', async t => {
  const f = routerFixture(t, { poolSize: 1 });
  f.put('a', { runId: 'deleted-run' });
  const old = f.add('a');
  await start(f);
  assert.equal(f.row(old.id).status, 'delivered');
  f.db.beginGroupDeletion('a', { operationId: 'delete-a', runId: 'deleted-run', actor: 'password:owner', preview: {} });
  const queued = f.add('a');
  f.db.recordRunEnd('a', { runId: 'deleted-run', reason: 'delete' });
  f.scene.delete('a'); f.current.delete('a');
  const deliver = f.deps.deliverConversation;
  f.deps.deliverConversation = async (row, live) => {
    // The terminal boundary rejects a target that vanished after observation.
    // Real delivery requeues this guarded send; keep that behavior in the seam.
    if (!f.scene.has('a')) { f.db.requeueConversation(row.id); return; }
    return deliver(row, live);
  };
  f.db.finalizeGroupDeletion('a', { operationId: 'delete-a' });
  assert.equal(f.db.listSlotOccupancy().length, 0);
  assert.equal(f.router.state.listed.has('a'), true);
  assert.equal(f.router.state.live.get('a').runId, 'deleted-run', 'Router still holds the pre-deletion observation');
  f.router.tick();
  assert.equal(f.db.listSlotOccupancy().length, 0, 'Synchronous adoption must reject the old observation before its async refresh');
  assert.equal(f.router.state.slots.has('a'), false);
  await f.router.idle(); await f.rounds(5);
  assert.equal(f.row(queued.id).status, 'delivered');
  assert.equal(f.calls.filter(row => row[0] === 'launch' && row[1].sessionGroup === 'a').length, 1);
  assert.notEqual(f.db.listSlotOccupancy()[0].runId, 'deleted-run');
});

test('an unobservable listing never adopts a stale ready scene', async t => {
  const f = routerFixture(t); ready(f, 'a', 'late-run');
  const adoptions = countAdoptions(f);
  f.deps.listGroupTmuxSessions = async () => { throw new Error('tmux unavailable'); };
  await start(f);
  assert.equal(adoptions.length, 0);
  assert.equal(f.db.listSlotOccupancy().length, 0);
});

test('Origin and the single resident never request slot adoption', async t => {
  for (const mode of ['multi', 'single']) {
    await t.test(mode, async t => {
      const f = routerFixture(t, { mode });
      ready(f, mode === 'single' ? null : 'origin', 'resident-run');
      const adoptions = countAdoptions(f);
      await f.create().initialize(); await f.rounds(2);
      assert.equal(adoptions.length, 0);
      assert.equal(f.db.listSlotOccupancy().length, 0);
    });
  }
});

test('one hundred rounds with correct running rows perform no adoption or database writes', async t => {
  const f = routerFixture(t); f.put('a', { runId: 'already-owned' });
  const adoptions = countAdoptions(f);
  await start(f);
  const before = f.sqlite.prepare('SELECT total_changes() AS n').get().n;
  await f.rounds(100);
  assert.equal(adoptions.length, 0);
  assert.equal(f.sqlite.prepare('SELECT total_changes() AS n').get().n, before);
});

test('a launch finishing after its orphan row was pruned is adopted even above capacity', async t => {
  const launch = deferred(); t.after(() => launch.resolve());
  const f = routerFixture(t, { poolSize: 1 }); f.put('origin'); f.add('a');
  let input;
  f.deps.getSessionAdapter = () => ({
    launch: async value => { input = value; await launch.promise; ready(f, value.sessionGroup, value.runId); },
    stop: async () => assert.fail('the ready late launch must not be stopped'),
  });
  await f.create().initialize();
  // The first tick observes the absent pending group; the second starts it.
  for (let round = 0; round < 2; round++) { f.router.tick(); await pump(); }
  assert.ok(input, 'the activation must reach its held launch before the race');
  f.advance(31000);
  const removed = f.db.pruneSlots({ orphans: [{ sessionGroup: 'a', runId: input.runId }], minAgeSeconds: 30 });
  assert.equal(removed.deletedOrphans.length, 1);
  f.db.takeSlot('b', { runId: 'b-run', k: 1 });
  ready(f, 'b', 'b-run');
  launch.resolve(); await f.router.idle(); await f.rounds(2);
  const rows = f.db.listSlotOccupancy();
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.sessionGroup === 'a').runId, input.runId);
  assert.equal(f.router.availableCapacity(), -1);
});

test('adopting a late run protects its row from a newer conflicting activation release', async t => {
  const launch = deferred(); t.after(() => launch.resolve());
  const f = routerFixture(t, { poolSize: 1 }); f.put('origin'); const message = f.add('a');
  let input;
  f.deps.getSessionAdapter = () => ({
    launch: async value => { input = value; await launch.promise; throw Object.assign(new Error('late session already exists'), { code: 'NAME_CONFLICT' }); },
    stop: async () => assert.fail('name conflict must not stop the adopted run'),
  });
  await f.create().initialize();
  // The first tick observes the absent pending group; the second starts it.
  for (let round = 0; round < 2; round++) { f.router.tick(); await pump(); }
  assert.ok(input, 'the activation must reach its held launch before the race');
  ready(f, 'a', 'older-late-run');
  for (let round = 0; round < 2; round++) { f.router.tick(); await pump(); }
  assert.equal(f.db.listSlotOccupancy()[0].runId, 'older-late-run');
  assert.deepEqual(f.db.releaseSlot('a', { runId: input.runId, prior: null }), { released: false });
  launch.resolve(); await f.router.idle();
  assert.equal(f.db.listSlotOccupancy()[0].runId, 'older-late-run');
  assert.equal(f.row(message.id).status, 'pending');
  assert.equal(f.row(message.id).retry_count, 0);
});

function reconciliation(f) {
  return new SupervisorRunEndings({
    db: f.db, env: { ZYLOS_DIR: process.env.ZYLOS_DIR }, now: f.now,
    readIdentity: async group => f.scene.get(group) ?? { present: false },
    readFile: async file => {
      const current = f.current.get(path.basename(path.dirname(file)));
      if (!current) throw Object.assign(new Error('no session file'), { code: 'ENOENT' });
      return JSON.stringify(current);
    },
    alert: event => f.calls.push(['reconciliation-alert', event]),
  });
}
function reconciliationContext(f) {
  return { configuration: { mode: 'multi' }, transition: null, fences: [],
    scenes: [...f.scene].map(([sessionGroup, live]) => ({ sessionGroup, ...live })) };
}

test('an unready late session timing out leaves no occupancy or ending record', async t => {
  const f = routerFixture(t, { readyTimeoutMs: 1000 });
  ready(f, 'a', 'unready-run', { ready: false });
  await start(f);
  assert.equal(f.db.listSlotOccupancy().length, 0);
  f.advance(1000); await f.rounds(3);
  assert.equal(f.scene.has('a'), false);
  assert.equal(f.calls.filter(row => row[0] === 'stop').length, 1);
  await reconciliation(f).advance(reconciliationContext(f));
  assert.equal(f.db.listSlotOccupancy().length, 0);
  assert.equal(f.db.listRunEndings(['a']).length, 0);
  assert.equal(f.db.listPendingContinuations().length, 0);
});

test('a rowless ready run ending before adoption has no record continuation or notification', async t => {
  const f = routerFixture(t);
  ready(f, 'a', 'gone-before-adoption');
  f.scene.delete('a');
  await start(f);
  await reconciliation(f).advance(reconciliationContext(f));
  await pump();
  assert.equal(f.db.listSlotOccupancy().length, 0);
  assert.equal(f.db.listRunEndings(['a']).length, 0);
  assert.equal(f.db.listPendingContinuations().length, 0);
  assert.equal(f.calls.filter(row => row[0] === 'alert' || row[0] === 'reconciliation-alert').length, 0);
});

test('a late run after held rollback clears the retained marker only once', async t => {
  const f = routerFixture(t);
  f.db.takeSlot('a', { runId: 'retained-run', k: 1 });
  f.db.recordRunEnd('a', { runId: 'retained-run', reason: 'upgrade' });
  const { prior } = f.db.takeSlot('a', { runId: 'failed-launch', k: 1 });
  assert.equal(f.db.releaseSlot('a', { runId: 'failed-launch', prior }).released, true);
  ready(f, 'a', 'late-run');
  await start(f, 3);
  assert.equal(f.db.listSlotOccupancy()[0].runId, 'late-run');
  assert.equal(f.db.listSlotOccupancy()[0].state, 'running');
  assert.equal(f.db.listRunEndings(['a'])[0].continuationPending, 0);
  assert.equal(f.events.filter(row => row.event === 'continuation_cleared' && row.session_group === 'a').length, 1);
  await f.rounds(3);
  assert.equal(f.events.filter(row => row.event === 'continuation_cleared' && row.session_group === 'a').length, 1);
  assert.equal(f.db.listPendingContinuations().length, 0);
  assert.equal(f.calls.filter(row => row[0] === 'launch').length, 0);
});

for (const blocked of ['known group identity', 'session listing', 'new group identity']) {
  test(`a pending ${blocked} read does not block another active delivery or new activation`, async t => {
    const f = routerFixture(t, { poolSize: 2 }); f.put('a');
    await start(f);
    const hold = deferred();
    const read = f.deps.readLiveIdentity;
    let blockedReads = 0;
    if (blocked === 'session listing') {
      f.deps.listGroupTmuxSessions = async () => { blockedReads++; await hold.promise; return []; };
    } else {
      if (blocked === 'known group identity') f.router.state.live.set('x', { present: false });
      else f.add('x', { priority: 3 });
      f.deps.readLiveIdentity = async group => {
        if (group === 'x') { blockedReads++; await hold.promise; }
        return read(group);
      };
    }
    const active = f.add('a'), fresh = f.add('b', { priority: 1 });
    try {
      for (let round = 0; round < 6; round++) { f.router.tick(); await pump(); }
      assert.ok(blockedReads > 0, 'the unrelated read must actually remain pending');
      assert.equal(f.row(active.id).status, 'delivered');
      assert.equal(f.row(fresh.id).status, 'delivered');
      assert.equal(f.calls.filter(row => row[0] === 'launch' && row[1].sessionGroup === 'b').length, 1);
    } finally {
      hold.resolve();
      await f.router.stop();
    }
  });
}

test('a slow group observation does not delay active delivery for even one round', async t => {
  const f = routerFixture(t); f.put('a'); await start(f);
  f.router.state.live.set('x', { present: false });
  const hold = deferred(), read = f.deps.readLiveIdentity;
  let reads = 0;
  f.deps.readLiveIdentity = async group => { if (group === 'x') { reads++; await hold.promise; } return read(group); };
  const message = f.add('a');
  try {
    f.router.tick(); await pump();
    assert.equal(reads, 1);
    assert.equal(f.row(message.id).status, 'delivered');
    for (let round = 0; round < 7; round++) { f.router.tick(); await pump(); }
    assert.equal(f.calls.filter(row => row[0] === 'conversation' && row[1] === message.id).length, 1);
  } finally {
    hold.resolve();
    await f.router.stop();
  }
});
