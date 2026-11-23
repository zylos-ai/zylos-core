import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { fixture } from './c4-v2-test-helpers.js';
import { createStore } from '../c4-v2-store.js';
import { migrateDatabase } from '../sqlite-schema.js';
// Existing layouts are migrated only by the explicit upgrade path, with the
// options ordinary openers used before they became check-only.
const migrateExisting = (db, candidate) => migrateDatabase(db, candidate, { allowNew: candidate.supportsNewDatabase === true, strict: false });

import * as historicalOwner from './helpers/c4-v2-owner.js';
import { seedV1, oldRows, snapshot } from './helpers/c4-v2-fixtures.js';

const clock = 1800000000;

// Integration boundary: real store and private in-memory SQLite, injected clock.
// Run for ending records, pending markers or their schema; skip unrelated runtime
// activation. The official runner isolates HOME/ZYLOS_DIR/PM2_HOME and short
// TMPDIR. Fixtures close their own DB; no runtime/tmux/PM2/network is contacted.
for (const reason of ['ttl', 'evict', 'release', 'upgrade', 'auth', 'model_config', 'mode_switch', 'manual_restart', 'unexpected']) {
  test(`run ending ${reason} records its pending marker without adding a control`, t => {
    let clockCalls = 0, db;
    const result = fixture(t, { now: () => { assert.equal(db.inTransaction, true); clockCalls++; return clock * 1000 + 999; } });
    db = result.db;
    const { store } = result;
    const before = db.prepare('SELECT count(*) AS n FROM conversations').get().n;
    const controlsBefore = db.prepare('SELECT count(*) AS n FROM control_queue').get().n;
    const ending = store.recordRunEnd('test:group', { runId: 'run1', reason });
    const needed = ['upgrade', 'auth', 'model_config', 'manual_restart', 'unexpected'].includes(reason);
    assert.deepEqual(ending, { recorded: true });
    assert.equal(clockCalls, 1, 'the ending timestamp is sampled inside its transaction');
    assert.deepEqual(store.listRunEndings(['test:group']), [{ sessionGroup: 'test:group', runId: 'run1', reason, endedAt: clock, continuationPending: Number(needed) }]);
    assert.deepEqual(store.listPendingContinuations(), needed ? [{ sessionGroup: 'test:group', endedAt: clock }] : []);
    assert.equal(db.prepare('SELECT count(*) AS n FROM control_queue').get().n, controlsBefore);
    assert.equal(db.prepare('SELECT count(*) AS n FROM conversations').get().n, before);
    assert.equal(store.getGlobalUnsummarizedRange().count, 0);
  });
}

test('fence mismatch and record write failure roll back the transaction', t => {
  const { db, store } = fixture(t, { now: () => clock * 1000 });
  store.setDrainFence('origin', { reason: 'manual_restart', runId: 'old' });
  const before = snapshot(db);
  assert.throws(() => store.recordRunEnd('origin', { runId: 'new', reason: 'upgrade', clearFence: { expectedReason: 'manual_restart', expectedRunId: 'new' } }), { code: 'FENCE_MISMATCH' });
  assert.deepEqual(snapshot(db), before);
  assert.throws(() => store.recordRunEnd('origin', { runId: 'old', reason: 'upgrade', clearFence: true }), { code: 'FENCE_MISMATCH' });
  assert.deepEqual(snapshot(db), before);
  assert.throws(() => store.recordRunEnd('absent', { runId: 'old', reason: 'upgrade', clearFence: { expectedReason: 'manual_restart', expectedRunId: 'old' } }), { code: 'FENCE_MISMATCH' });
  assert.deepEqual(snapshot(db), before);
  const failing = createStore(new Proxy(db, { get(target, key) {
    if (key === 'prepare') return sql => {
      if (sql.startsWith('INSERT INTO run_endings')) throw new Error('injected record write failure');
      return target.prepare(sql);
    };
    return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
  } }), { now: () => clock * 1000, readConfig: () => ({ state: 'ok', config: { session_mode: 'multi' } }) });
  assert.throws(() => failing.recordRunEnd('a', { runId: 'old', reason: 'unexpected' }), { code: 'DB_WRITE_FAILED' });
  assert.deepEqual(snapshot(db), before);
});

test('pending marker query excludes Origin and cleared rows and orders ending time then group', t => {
  let now = clock;
  const { db, store } = fixture(t, { now: () => now * 1000 });
  for (const group of ['z', 'b', 'a', 'clear', 'origin']) {
    store.recordRunEnd(group, { runId: group, reason: 'unexpected' });
    if (group === 'z') now++;
  }
  store.clearContinuation('clear', { runId: 'replacement' });
  const before = snapshot(db);
  assert.deepEqual(store.listPendingContinuations(), [{ sessionGroup: 'z', endedAt: clock }, { sessionGroup: 'a', endedAt: now }, { sessionGroup: 'b', endedAt: now }]);
  assert.deepEqual(Object.keys(store.listPendingContinuations()[0]), ['sessionGroup', 'endedAt']);
  assert.deepEqual(snapshot(db), before);
});

test('ready identity clears only an older pending marker using one update', t => {
  const trace = [];
  const { db, store } = fixture(t, { now: () => clock * 1000 }, false, { verbose: sql => trace.push(sql) });
  store.recordRunEnd('a', { runId: 'old', reason: 'unexpected' });
  const before = snapshot(db);
  assert.deepEqual(store.clearContinuation('a', { runId: 'old' }), { cleared: false });
  assert.deepEqual(snapshot(db), before);
  trace.length = 0;
  assert.deepEqual(store.clearContinuation('a', { runId: 'new' }), { cleared: true });
  assert.equal(trace.filter(sql => /^UPDATE run_endings/.test(sql)).length, 1);
  assert.equal(trace.filter(sql => /^SELECT.*FROM run_endings/.test(sql)).length, 0);
  assert.deepEqual(store.listRunEndings(['a']), [{ sessionGroup: 'a', runId: 'old', reason: 'unexpected', endedAt: clock, continuationPending: 0 }]);
  assert.deepEqual(store.clearContinuation('a', { runId: 'newer' }), { cleared: false });
  assert.deepEqual(store.clearContinuation('absent', { runId: 'new' }), { cleared: false });
  const cleared = snapshot(db);
  assert.deepEqual(store.recordRunEnd('a', { runId: 'old', reason: 'unexpected' }), { recorded: false });
  assert.deepEqual(snapshot(db), cleared, 'an idempotent ending cannot recreate a cleared marker');
  assert.equal(db.prepare('SELECT count(*) AS n FROM control_queue').get().n, 0);
});

test('run-ending migration preserves v1 rows and creates empty ending and occupancy tables', t => {
  const db = new Database(':memory:'); t.after(() => db.close()); seedV1(db, { extensions: true });
  const before = oldRows(db); migrateExisting(db, historicalOwner);
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  assert.deepEqual(oldRows(db), before);
  assert.deepEqual(db.prepare('SELECT * FROM run_endings').all(), []);
  assert.deepEqual(db.prepare('SELECT * FROM slot_occupancy').all(), []);
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name='run_endings'").get().sql.replace(/\s+/g, ' ');
  assert.equal(ddl, "CREATE TABLE run_endings ( session_group TEXT PRIMARY KEY NOT NULL CHECK (session_group <> '' AND session_group <> '*'), run_id TEXT NOT NULL CHECK (run_id <> ''), reason TEXT NOT NULL CHECK (reason IN ('ttl','evict','upgrade','auth','model_config','mode_switch','manual_restart','unexpected')), ended_at INTEGER NOT NULL, continuation_pending INTEGER NOT NULL DEFAULT 0 CHECK (continuation_pending IN (0,1)) )");
});
