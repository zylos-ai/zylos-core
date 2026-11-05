import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixture as databaseFixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { SupervisorRunEndings } from '../supervisor-run-endings.js';
import { SupervisorLifecycle, evictionDemand } from '../supervisor-lifecycle.js';

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
  assert.equal(f.store.listRunEndings().length, 0);
  assert.equal(f.store.takeSlot('test:group', { runId: 'next', k: 4 }).taken, true);
});

test('reconciliation records before pruning so a crashed run retains its occupancy', async t => {
  const f = await fixture(t); f.take(); await f.write(); f.now += 31000;
  await f.service.advance(f.context);
  assert.equal(f.store.listRunEndings()[0].reason, 'unexpected');
  assert.equal(f.rows()[0].state, 'held');
  assert.equal(f.rows()[0].heldUntil, Math.floor(f.now / 1000) + 120);
});

test('held occupancy remains at 119 seconds and is physically pruned at 120 seconds', async t => {
  const f = await fixture(t); f.take(); f.store.recordRunEnd('test:group', { runId: 'old', reason: 'upgrade' });
  f.now += 119000; await f.service.advance(f.context); assert.equal(f.rows().length, 1);
  f.now += 1000; await f.service.advance(f.context);
  assert.equal(f.db.prepare('SELECT count(*) n FROM slot_occupancy').get().n, 0);
});

test('unreadable ending records do not strand an old running occupancy', async t => {
  const f = await fixture(t); f.take(); await f.write();
  f.service.db = { ...f.store, listRunEndings() { throw new Error('record read failed'); } };
  f.now += 29999; await f.service.advance(f.context); assert.equal(f.rows().length, 1);
  f.now++; await f.service.advance(f.context); assert.equal(f.rows().length, 0);
  assert.ok(f.errors.length > 0); assert.equal(f.store.listRunEndings().length, 0);
  assert.equal(f.store.takeSlot('test:group', { runId: 'inbound', k: 4 }).taken, true);
});

test('a failed ending write loses retention while later reconciliation can still recover', async t => {
  const f = await fixture(t); f.take(); await f.write(); f.now += 31000;
  f.service.db = { ...f.store, recordRunEnd() { throw new Error('record write failed'); } };
  await f.service.advance(f.context); assert.equal(f.rows().length, 0);
  f.service.db = f.store; await f.service.advance(f.context);
  assert.equal(f.store.listRunEndings()[0].reason, 'unexpected'); assert.equal(f.rows().length, 0);
  assert.equal(f.store.listPendingContinuations().length, 1);
});

for (const situation of ['waiting for delivery', 'restart after stop', 'retry after a failed record']) {
  test(`reclaim occupancy survives pruning while ${situation}`, async t => {
    const f = await fixture(t); f.take(); await f.write(); f.now += 31000;
    f.store.setDrainFence('test:group', { reason: 'upgrade', runId: 'old' });
    const lifecycle = new SupervisorLifecycle({ db: f.store }, { now: () => f.now });
    if (situation === 'restart after stop') f.service = new SupervisorRunEndings({
      db: f.store, env: { ZYLOS_DIR: f.root }, readIdentity: () => ({ present: false }), now: () => f.now });
    if (situation === 'retry after a failed record') {
      const fail = { ...f.store, recordRunEnd() { throw new Error('once'); } };
      lifecycle.d.db = fail;
      await assert.rejects(lifecycle.completeRun(f.store.getDrainFence('test:group'), { configuration: { mode: 'multi' }, fences: f.store.listDrainFences() }), /once/);
      lifecycle.d.db = f.store;
    }
    await f.service.advance(f.context); assert.equal(f.rows()[0].state, 'running');
    await lifecycle.completeRun(f.store.getDrainFence('test:group'), { configuration: { mode: 'multi' }, fences: f.store.listDrainFences() });
    assert.equal(f.rows()[0].state, 'held'); assert.equal(f.store.getDrainFence('test:group'), null);
  });
}

test('a new run taking over between orphan selection and deletion is retained', async t => {
  const f = await fixture(t); f.take(); f.now += 31000;
  let candidates;
  f.service.db = { ...f.store, pruneSlots(options) {
    candidates = options.orphans;
    f.store.recordRunEnd('test:group', { runId: 'old', reason: 'upgrade' });
    assert.equal(f.store.takeSlot('test:group', { runId: 'new', k: 4 }).taken, true);
    return f.store.pruneSlots(options);
  } };
  await f.service.advance(f.context);
  assert.deepEqual(candidates, [{ sessionGroup: 'test:group', runId: 'old' }]);
  assert.equal(f.rows()[0].runId, 'new'); assert.equal(f.rows()[0].state, 'running');
});

test('cleanup remains active when reconciliation is gated by a transition', async t => {
  const f = await fixture(t); f.take(); f.now += 31000;
  f.service.db = { ...f.store, getModeTransition: () => ({ phase: 'gating' }) };
  await f.service.advance(f.context); assert.equal(f.rows().length, 0);
});

test('unknown scene observations and global fences protect running occupancy', async t => {
  const f = await fixture(t); f.take(); f.now += 31000;
  f.observable = false; await f.service.advance(f.context); assert.equal(f.rows().length, 1);
  f.observable = true; f.live.set('test:group', { present: true });
  await f.service.advance(f.context); assert.equal(f.rows().length, 1);
  f.live.clear(); f.service.db = { ...f.store, listDrainFences: () => [{ sessionGroup: '*' }] };
  await f.service.advance(f.context); assert.equal(f.rows().length, 1);
});

test('a fresh identity read timeout preserves occupancy past the readiness deadline', async t => {
  const f = await fixture(t); f.take(); f.now += 31000;
  let reads = 0;
  f.service.readIdentity = () => {
    reads++;
    throw Object.assign(new Error('tmux identity read timed out'), { code: 'TMUX_TIMEOUT' });
  };
  await f.service.advance(f.context);
  assert.equal(reads, 1);
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].runId, 'old');
  assert.equal(f.rows()[0].state, 'running');
});

test('a slot read failure prevents pruning and single mode never reads occupancy', async t => {
  const f = await fixture(t); let prunes = 0, reads = 0;
  f.service.db = { ...f.store, listSlotOccupancy() { reads++; throw new Error('slots unavailable'); }, pruneSlots() { prunes++; } };
  await f.service.advance(f.context); assert.equal(reads, 1); assert.equal(prunes, 0);
  f.context.configuration.mode = 'single'; await f.service.advance(f.context);
  assert.equal(reads, 1); assert.equal(prunes, 0);
});

test('eviction counts held occupancy and negative free while discounting only freeing reclaims', () => {
  const slots = ['a', 'b', 'held', 'starting'].map(sessionGroup => ({ sessionGroup }));
  const pending = [{ sessionGroup: 'new' }, { sessionGroup: 'held' }, { sessionGroup: 'new' }];
  assert.deepEqual(evictionDemand(slots, pending, [{ sessionGroup: 'a', reason: 'upgrade' }, { sessionGroup: 'b', reason: 'auth' }], 3), { waiting: 1, free: -1, inflight: 0, need: 2 });
  assert.deepEqual(evictionDemand(slots, pending, [{ sessionGroup: 'a', reason: 'ttl' }, { sessionGroup: 'b', reason: 'evict' }], 3), { waiting: 1, free: -1, inflight: 2, need: 0 });
  assert.equal(evictionDemand(slots, [], [], 3).need, 0);
});

for (const recovery of ['record recovers', 'record remains unavailable', 'session file never existed']) {
  test(`after failed reclaim falls back to clearing its fence, ${recovery}`, async t => {
    const f = await fixture(t); f.take(); f.now += 31000;
    if (recovery !== 'session file never existed') await f.write();
    f.store.setDrainFence('test:group', { reason: 'upgrade', runId: 'old' });
    const failing = { ...f.store, recordRunEnd() { throw new Error('persistent write error'); } };
    const lifecycle = new SupervisorLifecycle({ db: failing }, { now: () => f.now });
    for (let round = 0; round < 3; round++) {
      lifecycle.beginRound();
      const context = { configuration: { mode: 'multi' }, fences: f.store.listDrainFences() };
      const completion = lifecycle.completeRun(f.store.getDrainFence('test:group'), context);
      if (round < 2) await assert.rejects(completion, /persistent write error/);
      else await completion;
    }
    assert.equal(f.store.getDrainFence('test:group'), null);
    assert.equal(f.rows()[0].state, 'running');
    if (recovery === 'record remains unavailable') f.service.db = failing;
    await f.service.advance(f.context);
    if (recovery === 'record recovers') {
      assert.equal(f.rows()[0].state, 'held'); assert.equal(f.store.listRunEndings()[0].reason, 'unexpected');
    } else {
      assert.equal(f.rows().length, 0);
      assert.equal(f.store.takeSlot('test:group', { runId: 'inbound', k: 4 }).taken, true);
    }
  });
}


test('unreadable fences protect a reclaiming running row during cleanup', async t => {
  const f=await fixture(t); f.take(); await f.write(); f.now+=31000;
  f.store.setDrainFence('test:group',{reason:'upgrade',runId:'old'});
  f.service.db={...f.store,listDrainFences(){throw new Error('fences unavailable');}};
  await f.service.advance(f.context);
  assert.equal(f.rows().length,1); assert.equal(f.rows()[0].state,'running');
  assert.equal(f.store.listRunEndings().length,0);
  assert.ok(f.errors.some(error=>error.message==='fences unavailable'));
});

test('a run seen by the round snapshot keeps occupancy until a later round records its ending', async t => {
  const f=await fixture(t); f.take(); await f.write(); f.now+=31000;
  f.context.scenes=[{sessionGroup:'test:group',runId:'old',present:true}];
  await f.service.advance(f.context);
  assert.equal(f.rows().length,1); assert.equal(f.rows()[0].state,'running');
  assert.equal(f.store.listRunEndings().length,0);
  f.context.scenes=[]; await f.service.advance(f.context);
  assert.equal(f.rows()[0].state,'held');
  assert.equal(f.store.listRunEndings()[0].reason,'unexpected');
});
