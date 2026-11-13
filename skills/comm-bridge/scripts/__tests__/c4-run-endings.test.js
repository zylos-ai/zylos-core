import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { fixture } from './c4-v2-test-helpers.js';
import { createStore } from '../c4-v2-store.js';
import { guardDatabase, migrateDatabase } from '../sqlite-schema.js';
// Existing layouts are migrated only by the explicit upgrade path, with the
// options ordinary openers used before they became check-only.
const migrateExisting = (db, candidate) => migrateDatabase(db, candidate, { allowNew: candidate.supportsNewDatabase === true, strict: false });

import * as owner from '../c4-schema.js';
import * as historicalOwner from './helpers/c4-v2-owner.js';
import { seedV1, oldRows, snapshot } from './helpers/c4-v2-fixtures.js';

const clock = 1800000000;
const control = (db, id) => db.prepare('SELECT * FROM control_queue WHERE id=?').get(id);

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

test('Origin ending reasons have the same marker policy except manual restart', t => {
  const { db, store } = fixture(t, { now: () => clock * 1000 });
  for (const reason of ['ttl', 'evict', 'release', 'upgrade', 'auth', 'model_config', 'mode_switch', 'manual_restart', 'unexpected']) {
    assert.deepEqual(store.recordRunEnd('origin', { runId: reason, reason }), { recorded: true });
    const needed = ['upgrade', 'auth', 'model_config', 'unexpected'].includes(reason);
    assert.equal(store.listRunEndings(['origin'])[0].continuationPending, Number(needed));
    assert.deepEqual(store.listPendingContinuations(), [], 'Origin is not a normal continuation candidate');
    assert.equal(db.prepare('SELECT count(*) AS n FROM control_queue').get().n, 0);
  }
});

test('repeated endings preserve records and markers while clearing a matching fence', t => {
  let now = clock;
  const { db, store } = fixture(t, { now: () => now * 1000 });
  store.recordRunEnd('origin', { runId: 'run1', reason: 'upgrade' });
  const before = snapshot(db);
  now++;
  assert.deepEqual(store.recordRunEnd('origin', { runId: 'run1', reason: 'ttl' }), { recorded: false });
  assert.deepEqual(snapshot(db), before);
  store.setDrainFence('origin', { reason: 'manual_restart', runId: 'run1' });
  assert.deepEqual(store.recordRunEnd('origin', { runId: 'run1', reason: 'manual_restart', clearFence: { expectedReason: 'manual_restart', expectedRunId: 'run1' } }), { recorded: false });
  assert.equal(store.getDrainFence('origin'), null);
  assert.deepEqual(store.listRunEndings(['origin']), [{ sessionGroup: 'origin', runId: 'run1', reason: 'upgrade', endedAt: clock, continuationPending: 1 }]);
});

test('a new ending replaces the only pending marker without changing existing controls', t => {
  const { db, store } = fixture(t, { now: () => clock * 1000 });
  const old = store.insertControl('existing operation', { sessionGroup: 'a', appendAckSuffix: false });
  for (const [runId, reason] of [['one', 'unexpected'], ['two', 'auth'], ['three', 'model_config']]) {
    assert.deepEqual(store.recordRunEnd('a', { runId, reason }), { recorded: true });
    assert.deepEqual(store.listRunEndings(['a']), [{ sessionGroup: 'a', runId, reason, endedAt: clock, continuationPending: 1 }]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM control_queue').get().n, 1);
    assert.equal(control(db, old.id).status, 'pending');
  }
});

for (const reason of ['ttl', 'evict', 'release', 'mode_switch']) {
  test(`a new ${reason} ending does not inherit an older pending marker`, t => {
    let now = clock;
    const { db, store } = fixture(t, { now: () => now * 1000 });
    store.recordRunEnd('a', { runId: 'first', reason: 'unexpected' });
    assert.equal(store.listRunEndings(['a'])[0].continuationPending, 1);
    now += 20;
    assert.deepEqual(store.recordRunEnd('a', { runId: 'second', reason }), { recorded: true });
    assert.deepEqual(store.listPendingContinuations(), []);
    assert.deepEqual(store.listRunEndings(['a']), [{ sessionGroup: 'a', runId: 'second', reason, endedAt: now, continuationPending: 0 }]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM control_queue').get().n, 0);
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

test('normal and conditional clearing use their existing fence semantics', t => {
  const { store } = fixture(t);
  store.setDrainFence('a', { reason: 'ttl', runId: 'old' });
  assert.deepEqual(store.recordRunEnd('a', { runId: 'old', reason: 'ttl', clearFence: true }), { recorded: true });
  assert.equal(store.getDrainFence('a'), null);
  store.setDrainFence('b', { reason: 'auth', runId: 'old' });
  assert.throws(() => store.recordRunEnd('b', { runId: 'old', reason: 'auth', clearFence: { expectedReason: 'upgrade', expectedRunId: 'old' } }), { code: 'FENCE_MISMATCH' });
  assert.equal(store.getDrainFence('b').reason, 'auth');
  store.recordRunEnd('b', { runId: 'old', reason: 'auth', clearFence: { expectedReason: 'auth', expectedRunId: 'old' } });
  assert.equal(store.getDrainFence('b'), null);
});

test('invalid identities, reasons, options and single mode are rejected without writes', t => {
  const { db, store } = fixture(t);
  const before = snapshot(db);
  for (const [group, options] of [[null, { runId: 'r', reason: 'ttl' }], ['*', { runId: 'r', reason: 'ttl' }], ['a', { runId: '', reason: 'ttl' }], ['a', { runId: 'r', reason: 'unknown' }], ['a', { runId: 'r', reason: 'ttl', endedAt: 1 }], ['a', { runId: 'r', reason: 'ttl', clearFence: {} }], ['a', null]]) {
    assert.throws(() => store.recordRunEnd(group, options));
    assert.deepEqual(snapshot(db), before);
  }
  const single = createStore(db, { readConfig: () => ({ state: 'ok', config: { session_mode: 'single' } }) });
  assert.throws(() => single.recordRunEnd('a', { runId: 'r', reason: 'ttl' }), { code: 'INVALID_ARGS' });
  assert.deepEqual(snapshot(db), before);
});

test('mode transition endings write zero markers and still clear their fences', t => {
  const { db, store } = fixture(t, { now: () => clock * 1000 });
  store.recordRunEnd('a', { runId: 'first', reason: 'unexpected' });
  db.exec("INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,created_at,updated_at) VALUES('transition','multi','single','gating',1,1)");
  store.setDrainFence('a', { reason: 'upgrade', runId: 'second' });
  assert.deepEqual(store.recordRunEnd('a', { runId: 'second', reason: 'upgrade', clearFence: true }), { recorded: true });
  assert.equal(store.getDrainFence('a'), null);
  assert.deepEqual(store.recordRunEnd('b', { runId: 'b1', reason: 'auth' }), { recorded: true });
  assert.deepEqual(store.listRunEndings(['a', 'b']).map(row => row.continuationPending), [0, 0]);
  for (const reason of ['ttl', 'evict', 'release', 'upgrade', 'auth', 'model_config', 'mode_switch', 'manual_restart', 'unexpected']) {
    store.recordRunEnd('all-reasons', { runId: reason, reason });
    assert.equal(store.listRunEndings(['all-reasons'])[0].continuationPending, 0);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM control_queue').get().n, 0);
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

test('control expiration leaves pending markers unchanged and has no continuation exemption', t => {
  const { db, store } = fixture(t, { now: () => clock * 1000 });
  store.recordRunEnd('a', { runId: 'a1', reason: 'unexpected' });
  store.recordRunEnd('b', { runId: 'b1', reason: 'unexpected' });
  const a = store.insertControl('old operation', { sessionGroup: 'a', appendAckSuffix: false });
  const b = store.insertControl('other operation', { sessionGroup: 'b', appendAckSuffix: false });
  assert.deepEqual(store.expirePendingControls({ sessionGroup: 'a' }).map(row => row.id), [a.id]);
  assert.equal(control(db, a.id).status, 'timeout');
  assert.equal(control(db, b.id).status, 'pending');
  store.expirePendingControls({ allSessionGroups: true });
  assert.equal(control(db, b.id).status, 'timeout');
  assert.deepEqual(store.listPendingContinuations().map(row => row.sessionGroup), ['a', 'b']);
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

test('marker clearing rejects invalid identities and single mode without writes', t => {
  const { db, store } = fixture(t);
  store.recordRunEnd('a', { runId: 'old', reason: 'unexpected' });
  const before = snapshot(db);
  for (const group of [null, '', '*']) assert.throws(() => store.clearContinuation(group, { runId: 'new' }), { code: 'SESSION_GROUP_INVALID' });
  for (const options of [null, {}, { runId: '' }, { runId: ' ' }, { runId: 'new', extra: true }]) assert.throws(() => store.clearContinuation('a', options), { code: 'INVALID_ARGS' });
  const single = createStore(db, { readConfig: () => ({ state: 'ok', config: { session_mode: 'single' } }) });
  assert.throws(() => single.clearContinuation('a', { runId: 'new' }), { code: 'INVALID_ARGS' });
  assert.deepEqual(snapshot(db), before);
});

test('cutover clearing removes all markers including Origin without changing records or controls', t => {
  const { db, store } = fixture(t, { now: () => clock * 1000 });
  for (const group of ['a', 'b', 'origin']) store.recordRunEnd(group, { runId: group, reason: 'unexpected' });
  store.recordRunEnd('idle', { runId: 'idle', reason: 'ttl' });
  const controls = db.prepare('SELECT * FROM control_queue').all();
  assert.deepEqual(store.clearAllContinuations(), { cleared: 3 });
  assert.deepEqual(store.clearAllContinuations(), { cleared: 0 });
  assert.deepEqual(store.listPendingContinuations(), []);
  assert.deepEqual(store.listRunEndings(['a', 'b', 'origin', 'idle']).map(row => row.continuationPending), [0, 0, 0, 0]);
  assert.deepEqual(db.prepare('SELECT * FROM control_queue').all(), controls);
});

test('run-ending reads use one scoped query and exclude unrelated historical groups', t => {
  const trace = [];
  const { db, store } = fixture(t, { now: () => clock * 1000 }, false, { verbose: sql => trace.push(sql) });
  for (const group of ['a', 'b', 'history', 'origin']) store.recordRunEnd(group, { runId: `run-${group}`, reason: 'ttl' });
  const before = snapshot(db); trace.length = 0;
  const result = store.listRunEndings(['b', 'absent', 'a', 'b']);
  assert.deepEqual(result.map(row => row.sessionGroup), ['a', 'b']);
  assert.equal(trace.length, 1);
  assert.match(trace[0], /^SELECT .* FROM run_endings WHERE session_group IN \(/);
  assert.deepEqual(Object.keys(result[0]), ['sessionGroup', 'runId', 'reason', 'endedAt', 'continuationPending']);
  assert.deepEqual(store.listRunEndings(['origin']).map(row => row.runId), ['run-origin']);
  assert.deepEqual(store.listRunEndings(['absent']), []);
  assert.deepEqual(snapshot(db), before);
});

test('run-ending reads reject empty scopes and invalid groups before reading the database', () => {
  let reads = 0;
  const store = createStore(() => { reads++; throw new Error('must not open'); });
  for (const scope of [undefined, null, [], 'a', {}, ['a', null], [''], ['*'], [1], Array(1)]) assert.throws(() => store.listRunEndings(scope));
  assert.equal(reads, 0);
});

test('run-ending readers propagate failures and normalize busy errors', () => {
  for (const method of ['listRunEndings', 'listPendingContinuations']) for (const code of ['SQLITE_BUSY', 'SQLITE_IOERR_READ']) {
    const failure = Object.assign(new Error('injected read failure'), { code });
    const store = createStore({ prepare() { return { all() { throw failure; } }; } });
    assert.throws(() => store[method](...(method === 'listRunEndings' ? [['a']] : [])), error => code === 'SQLITE_BUSY' ? error.code === 'DB_BUSY' && error.cause === failure : error === failure);
  }
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

test('current schema missing the run-ending table is rejected without recreating it or changing rows', t => {
  const { db, store } = fixture(t);
  store.recordRunEnd('a', { runId: 'a1', reason: 'unexpected' });
  db.exec('DROP TABLE run_endings');
  const before = snapshot(db);
  assert.throws(() => guardDatabase(db, owner), /^Error: c4: unsupported schema 4, missing run_endings\.session_group/);
  assert.deepEqual(snapshot(db), before);
});

test('public database facade exposes run-ending primitives', async () => {
  const facade = await import('../c4-db.js');
  for (const name of ['recordRunEnd', 'listRunEndings', 'listPendingContinuations', 'clearContinuation', 'clearAllContinuations']) assert.equal(typeof facade[name], 'function');
});

test('current schema with the retired continuation column is rejected without mutation', t => {
  const { db, store } = fixture(t);
  store.recordRunEnd('a', { runId: 'a1', reason: 'unexpected' });
  db.exec('ALTER TABLE run_endings RENAME COLUMN continuation_pending TO continuation_control_id');
  const before = snapshot(db);
  assert.throws(() => guardDatabase(db, owner), /^Error: c4: unsupported schema 4, missing run_endings\.continuation_pending/);
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.pragma('user_version', { simple: true }), owner.SUPPORTED_SCHEMA_VERSION);
});

test('new run-ending marker defaults to zero and rejects non-boolean storage values', t => {
  const { db } = fixture(t);
  db.prepare("INSERT INTO run_endings(session_group,run_id,reason,ended_at) VALUES('default','run','ttl',1)").run();
  assert.equal(db.prepare("SELECT continuation_pending FROM run_endings WHERE session_group='default'").get().continuation_pending, 0);
  for (const marker of [null, -1, 2]) assert.throws(() => db.prepare("UPDATE run_endings SET continuation_pending=? WHERE session_group='default'").run(marker), /constraint/i);
  assert.equal(db.prepare("SELECT continuation_pending FROM run_endings WHERE session_group='default'").get().continuation_pending, 0);
});
