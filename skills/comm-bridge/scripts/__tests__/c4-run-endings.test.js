import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { fixture } from './c4-v2-test-helpers.js';
import { createStore } from '../c4-v2-store.js';
import { guardDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { seedV1, oldRows, snapshot } from './helpers/c4-v2-fixtures.js';

const instruction = 'Your previous session in this group ended before its work was confirmed finished (context rotation, crash, upgrade, configuration change, or authentication recovery). Read the handoff file in full, check the actual state of each unfinished item, and continue the work. If nothing is unfinished, do nothing and stay idle.';
const clock = 1800000000;
const control = (db, id) => db.prepare('SELECT * FROM control_queue WHERE id=?').get(id);

for (const reason of ['ttl', 'evict', 'upgrade', 'auth', 'model_config', 'mode_switch', 'manual_restart', 'unexpected']) {
  test(`run ending ${reason} records the matching continuation policy`, t => {
    let clockCalls = 0, db;
    const result = fixture(t, { now: () => { assert.equal(db.inTransaction, true); clockCalls++; return clock * 1000 + 999; } });
    db = result.db;
    const { store } = result;
    const before = db.prepare('SELECT count(*) AS n FROM conversations').get().n;
    const ending = store.recordRunEnd('test:group', { runId: 'run1', reason });
    const needed = ['upgrade', 'auth', 'model_config', 'manual_restart', 'unexpected'].includes(reason);
    assert.equal(ending.recorded, true);
    assert.equal(clockCalls, 1, 'record and instruction use the same transaction clock sample');
    assert.deepEqual(store.listRunEndings(), [{ sessionGroup: 'test:group', runId: 'run1', reason, endedAt: clock, continuationControlId: ending.continuationControlId }]);
    if (needed) {
      assert.notEqual(ending.continuationControlId, null);
      const row = control(db, ending.continuationControlId);
      assert.equal(row.raw_content, instruction); assert.equal(row.content, instruction);
      assert.equal(row.session_group, 'test:group'); assert.equal(row.target_binding, null);
      assert.equal(row.priority, 2); assert.equal(row.require_idle, 0); assert.equal(row.bypass_state, 0);
      assert.equal(row.ack_deadline_at, null); assert.equal(row.available_at, null);
      assert.equal(row.created_at, clock); assert.equal(row.updated_at, clock);
      assert.deepEqual(store.listPendingContinuations(), [{ sessionGroup: 'test:group', controlId: row.id, createdAt: clock, endedAt: clock }]);
    } else {
      assert.equal(ending.continuationControlId, null);
      assert.equal(db.prepare('SELECT count(*) AS n FROM control_queue').get().n, 0);
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM conversations').get().n, before);
    assert.equal(store.getGlobalUnsummarizedRange().count, 0, 'continuation does not enter conversation memory input');
  });
}

test('manual restart of Origin records the ending without creating a continuation', t => {
  const { db, store } = fixture(t, { now: () => clock * 1000 });
  const ending = store.recordRunEnd('origin', { runId: 'manual-origin', reason: 'manual_restart' });
  assert.equal(ending.recorded, true);
  assert.equal(ending.continuationControlId, null);
  assert.equal(store.listRunEndings()[0].reason, 'manual_restart');
  assert.equal(db.prepare('SELECT count(*) AS n FROM control_queue').get().n, 0);
});

test('repeated endings preserve records and controls while still clearing a matching fence', t => {
  let now = clock;
  const { db, store } = fixture(t, { now: () => now * 1000 });
  const original = store.recordRunEnd('origin', { runId: 'run1', reason: 'upgrade' });
  const before = snapshot(db);
  now++;
  assert.deepEqual(store.recordRunEnd('origin', { runId: 'run1', reason: 'upgrade' }), { ...original, recorded: false });
  assert.deepEqual(snapshot(db), before);
  store.setDrainFence('origin', { reason: 'manual_restart', runId: 'run1' });
  assert.deepEqual(store.recordRunEnd('origin', { runId: 'run1', reason: 'manual_restart', clearFence: { expectedReason: 'manual_restart', expectedRunId: 'run1' } }), { ...original, recorded: false });
  assert.equal(store.getDrainFence('origin'), null);
  assert.equal(store.listRunEndings()[0].endedAt, clock);
  assert.equal(store.listRunEndings()[0].reason, 'upgrade');
  assert.deepEqual(store.listPendingContinuations(), [], 'Origin continuation is handled by its existing need reader');
});

test('new endings supersede pending duplicate instructions but retain delivered controls', t => {
  const { db, store } = fixture(t, { now: () => clock * 1000 });
  const one = store.recordRunEnd('a', { runId: 'one', reason: 'unexpected' });
  const two = store.recordRunEnd('a', { runId: 'two', reason: 'auth' });
  assert.equal(control(db, one.continuationControlId).status, 'superseded');
  assert.equal(control(db, two.continuationControlId).status, 'pending');
  db.prepare("UPDATE control_queue SET status='done' WHERE id=?").run(two.continuationControlId);
  const three = store.recordRunEnd('a', { runId: 'three', reason: 'model_config' });
  assert.equal(control(db, two.continuationControlId).status, 'done');
  assert.equal(control(db, three.continuationControlId).status, 'pending');
  assert.equal(store.listRunEndings()[0].continuationControlId, three.continuationControlId);
});

test('non-continuing endings retain only a still-pending instruction and update queue time', t => {
  let now = clock;
  const { db, store } = fixture(t, { now: () => now * 1000 });
  const first = store.recordRunEnd('a', { runId: 'first', reason: 'unexpected' });
  now += 20;
  assert.deepEqual(store.recordRunEnd('a', { runId: 'second', reason: 'ttl' }), { recorded: true, continuationControlId: first.continuationControlId });
  assert.deepEqual(store.listPendingContinuations(), [{ sessionGroup: 'a', controlId: first.continuationControlId, createdAt: clock, endedAt: now }]);
  db.prepare("UPDATE control_queue SET status='done' WHERE id=?").run(first.continuationControlId);
  now++;
  assert.deepEqual(store.recordRunEnd('a', { runId: 'third', reason: 'evict' }), { recorded: true, continuationControlId: null });
  assert.deepEqual(store.listPendingContinuations(), []);
});

test('fence mismatch and a failure after enqueue roll back record, control and fence together', t => {
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
      if (sql.startsWith('INSERT INTO run_endings')) throw new Error('injected record write failure after control enqueue');
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
  assert.deepEqual(store.recordRunEnd('a', { runId: 'old', reason: 'ttl', clearFence: true }), { recorded: true, continuationControlId: null });
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

test('mode transition completion records are permitted while new continuations are suppressed', t => {
  const { db, store } = fixture(t, { now: () => clock * 1000 });
  const existing = store.recordRunEnd('a', { runId: 'first', reason: 'unexpected' });
  db.exec("INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,created_at,updated_at) VALUES('transition','multi','single','gating',1,1)");
  store.setDrainFence('a', { reason: 'upgrade', runId: 'second' });
  const recorded = store.recordRunEnd('a', { runId: 'second', reason: 'upgrade', clearFence: true });
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.continuationControlId, existing.continuationControlId);
  assert.equal(db.prepare('SELECT count(*) AS n FROM control_queue').get().n, 1);
  assert.equal(store.getDrainFence('a'), null);
  assert.deepEqual(store.recordRunEnd('b', { runId: 'b1', reason: 'auth' }), { recorded: true, continuationControlId: null });
  assert.equal(store.listRunEndings().length, 2);
});

test('pending continuation query filters terminal and deleted controls and sorts by control creation', t => {
  let now = clock;
  const { db, store } = fixture(t, { now: () => now * 1000 });
  const entries = [];
  for (const group of ['z', 'a', 'b', 'done', 'timeout', 'superseded', 'deleted', 'origin']) {
    entries.push([group, store.recordRunEnd(group, { runId: group, reason: 'unexpected' }).continuationControlId]);
    if (group === 'z') now--;
  }
  for (const [group, id] of entries) {
    if (['done', 'timeout', 'superseded'].includes(group)) db.prepare('UPDATE control_queue SET status=? WHERE id=?').run(group, id);
    if (group === 'deleted') db.prepare('DELETE FROM control_queue WHERE id=?').run(id);
  }
  const before = snapshot(db);
  assert.deepEqual(store.listPendingContinuations().map(row => row.sessionGroup), ['a', 'b', 'z']);
  assert.deepEqual(Object.keys(store.listPendingContinuations()[0]), ['sessionGroup', 'controlId', 'createdAt', 'endedAt']);
  assert.deepEqual(store.listRunEndings().map(row => row.sessionGroup), ['a', 'b', 'deleted', 'done', 'origin', 'superseded', 'timeout', 'z']);
  assert.deepEqual(snapshot(db), before);
});

test('activation expiration preserves only its current continuation within the update statement', t => {
  const trace = [];
  const { db, store } = fixture(t, { now: () => clock * 1000 }, false, { verbose: sql => trace.push(sql) });
  const a = store.recordRunEnd('a', { runId: 'a1', reason: 'unexpected' });
  const b = store.recordRunEnd('b', { runId: 'b1', reason: 'unexpected' });
  const other = store.insertControl('old operation', { sessionGroup: 'a', appendAckSuffix: false });
  trace.length = 0;
  const expired = store.expirePendingControls({ sessionGroup: 'a', keepContinuation: true });
  assert.deepEqual(expired.map(row => row.id), [other.id]);
  assert.equal(trace.filter(sql => /^SELECT\b/.test(sql)).length, 0, 'no read-before-write of continuation identity');
  assert.match(trace.find(sql => /^UPDATE/.test(sql)), /NOT EXISTS\(SELECT 1 FROM run_endings/);
  assert.equal(control(db, a.continuationControlId).status, 'pending');
  assert.equal(control(db, b.continuationControlId).status, 'pending');
  store.expirePendingControls({ sessionGroup: 'absent', keepContinuation: true });
  store.expirePendingControls({ allSessionGroups: true });
  assert.equal(control(db, a.continuationControlId).status, 'timeout');
  assert.equal(control(db, b.continuationControlId).status, 'timeout');
  assert.deepEqual(store.listPendingContinuations(), []);
});

test('run-ending readers propagate failures and normalize busy errors', () => {
  for (const method of ['listRunEndings', 'listPendingContinuations']) for (const code of ['SQLITE_BUSY', 'SQLITE_IOERR_READ']) {
    const failure = Object.assign(new Error('injected read failure'), { code });
    const store = createStore({ prepare() { return { all() { throw failure; } }; } });
    assert.throws(() => store[method](), error => code === 'SQLITE_BUSY' ? error.code === 'DB_BUSY' && error.cause === failure : error === failure);
  }
});

test('run-ending migration preserves v1 rows and creates only the approved empty table', t => {
  const db = new Database(':memory:'); t.after(() => db.close()); seedV1(db, { extensions: true });
  const before = oldRows(db); guardDatabase(db, owner);
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  assert.deepEqual(oldRows(db), before);
  assert.deepEqual(db.prepare('SELECT * FROM run_endings').all(), []);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='slot_occupancy'").get(), undefined);
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name='run_endings'").get().sql.replace(/\s+/g, ' ');
  assert.equal(ddl, "CREATE TABLE run_endings ( session_group TEXT PRIMARY KEY NOT NULL CHECK (session_group <> '' AND session_group <> '*'), run_id TEXT NOT NULL CHECK (run_id <> ''), reason TEXT NOT NULL CHECK (reason IN ('ttl','evict','upgrade','auth','model_config','mode_switch','manual_restart','unexpected')), ended_at INTEGER NOT NULL, continuation_control_id INTEGER )");
});

test('schema two missing the run-ending table is rejected without recreating it or changing rows', t => {
  const { db, store } = fixture(t);
  store.recordRunEnd('a', { runId: 'a1', reason: 'unexpected' });
  db.exec('DROP TABLE run_endings');
  const before = snapshot(db);
  assert.throws(() => guardDatabase(db, owner), /^Error: c4: unsupported schema 2, missing run_endings\.session_group/);
  assert.deepEqual(snapshot(db), before);
});

test('public database facade exposes run-ending primitives', async () => {
  const facade = await import('../c4-db.js');
  for (const name of ['recordRunEnd', 'listRunEndings', 'listPendingContinuations']) assert.equal(typeof facade[name], 'function');
});
