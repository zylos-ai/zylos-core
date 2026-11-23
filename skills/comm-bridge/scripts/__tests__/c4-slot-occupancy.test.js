import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { fixture } from './c4-v2-test-helpers.js';
import { migrateDatabase } from '../sqlite-schema.js';
// Existing layouts are migrated only by the explicit upgrade path, with the
// options ordinary openers used before they became check-only.
const migrateExisting = (db, candidate) => migrateDatabase(db, candidate, { allowNew: candidate.supportsNewDatabase === true, strict: false });

import * as owner from '../c4-schema.js';
import * as historicalOwner from './helpers/c4-v2-owner.js';
import { seedV1, oldRows, snapshot } from './helpers/c4-v2-fixtures.js';

const start = 1800000000;
const take = (store, group = 'test:a', runId = 'first', k = 2) => store.takeSlot(group, { runId, k });
const rows = db => db.prepare('SELECT * FROM slot_occupancy ORDER BY session_group').all();

test('slot creation uses the transaction clock and blocks an existing running identity', t => {
  let db, samples = 0;
  const f = fixture(t, { now: () => { assert.equal(db.inTransaction, true); samples++; return start * 1000 + 999; } });
  db = f.db;
  assert.deepEqual(take(f.store), { taken: true, prior: null });
  assert.equal(samples, 1);
  assert.deepEqual(rows(db), [{ session_group: 'test:a', run_id: 'first', state: 'running', held_until: null, created_at: start }]);
  const before = rows(db);
  assert.deepEqual(take(f.store, 'test:a', 'second'), { taken: false, reason: 'own_running' });
  assert.deepEqual(rows(db), before);
  assert.deepEqual(take(f.store, 'test:b', 'second', 1), { taken: false, reason: 'full' });
  assert.deepEqual(rows(db), before);
});

test('release deletes only its own new running slot and cannot rewrite a newer or ended run', t => {
  const { db, store } = fixture(t, { now: () => start * 1000 });
  take(store);
  assert.deepEqual(store.releaseSlot('test:a', { runId: 'stale', prior: null }), { released: false });
  assert.deepEqual(store.releaseSlot('test:a', { runId: 'first', prior: null }), { released: true });
  assert.equal(rows(db).length, 0);
  take(store); store.recordRunEnd('test:a', { runId: 'first', reason: 'auth' });
  assert.deepEqual(store.releaseSlot('test:a', { runId: 'first', prior: null }), { released: false });
  const prior = take(store, 'test:a', 'new').prior;
  assert.deepEqual(store.releaseSlot('test:a', { runId: 'first', prior }), { released: false });
  assert.equal(rows(db)[0].run_id, 'new');
  assert.equal(rows(db)[0].state, 'running');
});

test('record, continuation, slot and fence changes roll back together after slot update or fence mismatch', t => {
  const { db, store } = fixture(t, { now: () => start * 1000 });
  take(store); store.setDrainFence('test:a', { reason: 'upgrade', runId: 'first' });
  const before = snapshot(db);
  assert.throws(() => store.recordRunEnd('test:a', { runId: 'first', reason: 'upgrade', clearFence: { expectedReason: 'auth', expectedRunId: 'first' } }), { code: 'FENCE_MISMATCH' });
  assert.deepEqual(snapshot(db), before);
  // A private database trigger exercises a real failure after the held update,
  // before transaction commit; product source and production databases are untouched.
  db.exec("CREATE TRIGGER refuse_fence_delete BEFORE DELETE ON drain_fences BEGIN SELECT RAISE(ABORT,'fixture refuses fence deletion'); END");
  const withTrigger = snapshot(db);
  assert.throws(() => store.recordRunEnd('test:a', { runId: 'first', reason: 'upgrade', clearFence: true }), { code: 'DB_WRITE_FAILED' });
  assert.deepEqual(snapshot(db), withTrigger);
});

test('take and prune expire reservations at 120 seconds but keep them at 119 seconds', t => {
  for (const method of ['take', 'prune']) {
    let now = start;
    const { db, store } = fixture(t, { now: () => now * 1000 });
    take(store, 'test:a', 'first', 1); store.recordRunEnd('test:a', { runId: 'first', reason: 'upgrade' });
    now += 119;
    assert.equal(store.listSlotOccupancy().length, 1);
    if (method === 'take') assert.deepEqual(take(store, 'test:b', 'second', 1), { taken: false, reason: 'full' });
    else assert.deepEqual(store.pruneSlots({ orphans: [], minAgeSeconds: 30 }), { deletedHeld: 0, deletedOrphans: [] });
    now++;
    assert.equal(store.listSlotOccupancy().length, 0, 'reader excludes exact-expiry held rows');
    if (method === 'take') assert.deepEqual(take(store, 'test:b', 'second', 1), { taken: true, prior: null });
    else assert.deepEqual(store.pruneSlots({ orphans: [], minAgeSeconds: 30 }), { deletedHeld: 1, deletedOrphans: [] });
    assert.equal(rows(db).some(row => row.session_group === 'test:a'), false);
  }
});

// Integration boundary: real store and two concurrent SQLite connections against
// one private WAL database. Run for slot transaction changes; skip unrelated UI.
// Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR. No tmux, runtime
// accounts, network or live database. Children have bounded IPC and are reaped.
test('two concurrent connections competing for the last slot yield exactly one winner', { timeout: 15000 }, async t => {
  const { filename, store } = fixture(t, {}, true);
  const children = [];
  try {
    for (const group of ['test:left', 'test:right']) {
      const child = fork(new URL('./helpers/slot-contention-worker.js', import.meta.url), [filename, group], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], signal: t.signal, killSignal: 'SIGKILL' });
      child.on('error', () => {}); // Readiness/reply promises report abort errors.
      const closed = new Promise(resolve => child.once('close', (code, signal) => resolve([code, signal])));
      const ready = once(child, 'message');
      children.push({ child, closed, ready });
    }
    await Promise.all(children.map(async entry => { const [message] = await entry.ready; assert.equal(message.ready, true); }));
    const replies = children.map(entry => once(entry.child, 'message'));
    for (const entry of children) entry.child.send({ go: true });
    const results = (await Promise.all(replies)).map(([message]) => message);
    assert.ok(results.every(message => !message.error));
    assert.equal(results.filter(message => message.result.taken).length, 1);
    assert.equal(results.filter(message => message.result.reason === 'full').length, 1);
    for (const entry of children) { const [code] = await entry.closed; assert.equal(code, 0); }
    assert.equal(store.listSlotOccupancy().length, 1);
  } finally {
    for (const entry of children) if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL');
    await Promise.allSettled(children.map(entry => entry.closed));
  }
});

test('migration adds empty occupancy with exact constraints and preserves historical rows', t => {
  const db = new Database(':memory:'); t.after(() => db.close()); seedV1(db, { extensions: true });
  const before = oldRows(db); migrateExisting(db, historicalOwner);
  assert.equal(db.pragma('user_version', { simple: true }), 2); assert.deepEqual(oldRows(db), before);
  assert.equal(rows(db).length, 0);
  const insert = db.prepare('INSERT INTO slot_occupancy(session_group,run_id,state,held_until,created_at) VALUES(?,?,?,?,?)');
  for (const values of [['origin','r','running',null,1], ['*','r','running',null,1], ['','r','running',null,1], ['a','','running',null,1], ['a','r','unknown',null,1], ['a','r','running',2,1], ['a','r','held',null,1]]) assert.throws(() => insert.run(...values), { code: 'SQLITE_CONSTRAINT_CHECK' });
});
