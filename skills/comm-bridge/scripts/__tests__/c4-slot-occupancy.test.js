import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
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

test('held takeover keeps one row even above capacity and release restores the exact prior row', t => {
  let now = start;
  const { db, store } = fixture(t, { now: () => now * 1000 });
  take(store); take(store, 'test:b');
  now += 10; store.recordRunEnd('test:a', { runId: 'first', reason: 'upgrade' });
  const prior = { sessionGroup: 'test:a', runId: 'first', state: 'held', heldUntil: now + 120, createdAt: start };
  now += 5;
  const result = take(store, 'test:a', 'replacement', 1);
  assert.deepEqual(result, { taken: true, prior });
  assert.equal(rows(db).length, 2);
  assert.equal(rows(db)[0].created_at, now);
  assert.deepEqual(store.releaseSlot('test:a', { runId: 'replacement', prior: result.prior }), { released: true });
  assert.deepEqual(store.listSlotOccupancy()[0], prior);
  assert.deepEqual(store.releaseSlot('test:a', { runId: 'replacement', prior: result.prior }), { released: false });
  assert.equal(rows(db).length, 2);
});

test('adoption inserts above capacity using the transaction clock and preserves existing rows', t => {
  let db, now = start, clockCalls = 0;
  const trace = [];
  const f = fixture(t, { now: () => {
    assert.equal(db.inTransaction, true); clockCalls++; return now * 1000 + 999;
  } }, false, { verbose: sql => trace.push(sql) });
  db = f.db;
  take(f.store, 'test:full', 'first', 1);
  const before = rows(db)[0];
  now += 10; trace.length = 0; clockCalls = 0;
  assert.deepEqual(f.store.adoptSlot('test:late', { runId: 'late' }), { adopted: true });
  assert.equal(clockCalls, 1);
  assert.ok(trace.includes('BEGIN IMMEDIATE'));
  assert.deepEqual(rows(db), [before, { session_group: 'test:late', run_id: 'late', state: 'running', held_until: null, created_at: now }]);
  assert.deepEqual(take(f.store, 'test:waiting', 'waiting', 1), { taken: false, reason: 'full' });
});

test('adopting an existing running identity does not refresh its creation time or write occupancy', t => {
  let now = start;
  const trace = [];
  const { db, store } = fixture(t, { now: () => now * 1000 }, false, { verbose: sql => trace.push(sql) });
  take(store); const before = rows(db);
  now += 100; trace.length = 0;
  assert.deepEqual(store.adoptSlot('test:a', { runId: 'first' }), { adopted: false, reason: 'already' });
  assert.deepEqual(rows(db), before);
  assert.equal(trace.filter(sql => /^(INSERT|UPDATE|DELETE)\b/.test(sql)).length, 0);
});

for (const state of ['running', 'held', 'expired held']) {
  test(`adoption replaces a different ${state} identity without changing the row count`, t => {
    let now = start;
    const { db, store } = fixture(t, { now: () => now * 1000 });
    take(store);
    if (state !== 'running') store.recordRunEnd('test:a', { runId: 'first', reason: 'upgrade' });
    now += state === 'expired held' ? 121 : 10;
    if (state === 'expired held') assert.equal(store.listSlotOccupancy().length, 0);
    assert.deepEqual(store.adoptSlot('test:a', { runId: 'late' }), { adopted: true });
    assert.deepEqual(rows(db), [{ session_group: 'test:a', run_id: 'late', state: 'running', held_until: null, created_at: now }]);
    assert.equal(store.listRunEndings(['test:a']).length, state === 'running' ? 0 : 1);
  });
}

for (const reason of ['upgrade', 'ttl']) {
  test(`adoption rejects a recorded ${reason} ending without restoring its running occupancy`, t => {
    let now = start;
    const { db, store } = fixture(t, { now: () => now * 1000 });
    take(store); store.recordRunEnd('test:a', { runId: 'first', reason });
    const before = snapshot(db); now += 10;
    assert.deepEqual(store.adoptSlot('test:a', { runId: 'first' }), { adopted: false, reason: 'ended' });
    assert.deepEqual(snapshot(db), before);
    // Even a stale running row cannot override the authoritative ending record.
    if (reason === 'upgrade') {
      db.prepare("UPDATE slot_occupancy SET state='running',held_until=NULL WHERE session_group=?").run('test:a');
      const stale = snapshot(db);
      assert.deepEqual(store.adoptSlot('test:a', { runId: 'first' }), { adopted: false, reason: 'ended' });
      assert.deepEqual(snapshot(db), stale);
    }
  });
}

test('adoption rejects invalid identities, caller timestamps and single mode without changes', t => {
  const { db, store } = fixture(t, { now: () => start * 1000 });
  take(store); const before = snapshot(db);
  for (const group of [null, '', '*', 'origin']) assert.throws(() => store.adoptSlot(group, { runId: 'late' }));
  for (const options of [undefined, null, [], {}, { runId: '' }, { runId: ' ' }, { runId: 'late', now: 1 }, { runId: 'late', createdAt: 1 }, { runId: 'late', k: 2 }]) {
    assert.throws(() => store.adoptSlot('test:a', options));
    assert.deepEqual(snapshot(db), before);
  }
  const single = createStore(db, { readConfig: () => ({ state: 'ok', config: { session_mode: 'single' } }) });
  assert.throws(() => single.adoptSlot('test:a', { runId: 'late' }), { code: 'INVALID_ARGS' });
  assert.deepEqual(snapshot(db), before);
});

test('adoption cannot restore deleted run identities across repeated group recreation', t => {
  const { db, store } = fixture(t);
  store.insertConversation('out', 'test', 'endpoint', 'completed before deletion', { groupName: 'a' });
  for (const [runId, operationId] of [['first-run', 'first-delete'], ['second-run', 'second-delete']]) {
    assert.equal(store.adoptSlot('test:a', { runId }).adopted, true);
    const targetKey = JSON.stringify(['group', 'test:a']);
    store.beginGroupDeletion('test:a', { ...store.getDeletionPreviewBoundary(targetKey), runId, operationId, actor: 'password:owner', preview: {} });
    const fenced = rows(db);
    assert.deepEqual(store.adoptSlot('test:a', { runId }), { adopted: false, reason: 'fenced' });
    assert.deepEqual(store.adoptSlot('test:a', { runId: 'unobserved-replacement' }), { adopted: false, reason: 'fenced' });
    assert.deepEqual(rows(db), fenced);
    store.recordRunEnd('test:a', { runId, reason: 'delete' });
    store.finalizeGroupDeletion('test:a', { operationId });
    assert.equal(store.listRunEndings(['test:a']).length, 0, 'Deletion removes the ordinary ending record');
    assert.deepEqual(store.adoptSlot('test:a', { runId }), { adopted: false, reason: 'ended' });
    assert.equal(rows(db).length, 0);
  }
  assert.deepEqual(store.adoptSlot('test:a', { runId: 'first-run' }), { adopted: false, reason: 'ended' });
  assert.deepEqual(store.adoptSlot('test:a', { runId: 'third-run' }), { adopted: true });
  assert.deepEqual(store.adoptSlot('test:b', { runId: 'first-run' }), { adopted: true }, 'Run exclusion is scoped to its deleted group');
  assert.equal(rows(db).length, 2);
});

test('release with a prior reservation cannot rewrite a run that has already ended', t => {
  let now = start;
  const { store } = fixture(t, { now: () => now * 1000 });
  take(store, 'test:a', 'first');
  store.recordRunEnd('test:a', { runId: 'first', reason: 'upgrade' });
  now += 10;
  const { prior } = take(store, 'test:a', 'replacement');
  assert.equal(prior.state, 'held');
  now += 10;
  store.recordRunEnd('test:a', { runId: 'replacement', reason: 'unexpected' });
  const after = store.listSlotOccupancy();
  assert.equal(after.length, 1);
  assert.equal(after[0].heldUntil, now + 120);
  now++;
  assert.deepEqual(store.releaseSlot('test:a', { runId: 'replacement', prior }), { released: false });
  assert.deepEqual(store.listSlotOccupancy(), after);
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

for (const reason of ['ttl', 'evict', 'release', 'upgrade', 'auth', 'model_config', 'mode_switch', 'manual_restart', 'unexpected']) {
  test(`ending ${reason} changes only its matching slot in the record transaction`, t => {
    let now = start;
    const { db, store } = fixture(t, { now: () => now * 1000 });
    take(store); now += 7;
    store.recordRunEnd('test:a', { runId: 'first', reason });
    if (['ttl', 'evict', 'release'].includes(reason)) assert.equal(rows(db).length, 0);
    else assert.deepEqual(rows(db), [{ session_group: 'test:a', run_id: 'first', state: 'held', held_until: now + 120, created_at: start }]);
    const before = snapshot(db); now++;
    store.recordRunEnd('test:a', { runId: 'first', reason });
    assert.deepEqual(snapshot(db), before, 'same run must not refresh the reservation');
    if (!rows(db).length) take(store, 'test:a', 'new');
    else take(store, 'test:a', 'new');
    const newer = rows(db);
    store.recordRunEnd('test:a', { runId: 'different-old', reason });
    assert.deepEqual(rows(db), newer, 'ending for an old run cannot alter the replacement slot');
  });
}

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

test('pruning checks current run, running state and creation age inside its transaction', t => {
  let now = start;
  const { db, store } = fixture(t, { now: () => now * 1000 });
  take(store, 'test:old', 'old', 4); take(store, 'test:young', 'young', 4); take(store, 'test:held', 'held', 4);
  store.recordRunEnd('test:held', { runId: 'held', reason: 'auth' });
  const orphan = (sessionGroup, runId) => ({ sessionGroup, runId });
  now += 29;
  assert.deepEqual(store.pruneSlots({ orphans: [orphan('test:old', 'old')], minAgeSeconds: 30 }), { deletedHeld: 0, deletedOrphans: [] });
  now++;
  store.releaseSlot('test:young', { runId: 'young', prior: null }); take(store, 'test:young', 'young-new', 4);
  assert.deepEqual(store.pruneSlots({ orphans: [orphan('test:old', 'old'), orphan('test:young', 'young'), orphan('test:held', 'held'), orphan('test:old', 'old'), orphan('test:absent', 'absent')], minAgeSeconds: 30 }), { deletedHeld: 0, deletedOrphans: [orphan('test:old', 'old')] });
  const heldPrior = take(store, 'test:held', 'replacement', 4).prior;
  assert.equal(heldPrior.state, 'held');
  assert.deepEqual(store.pruneSlots({ orphans: [orphan('test:held', 'held')], minAgeSeconds: 0 }), { deletedHeld: 0, deletedOrphans: [] });
  assert.deepEqual(store.listSlotOccupancy().map(row => row.runId), ['replacement', 'young-new']);
});

test('slot options reject caller timestamps and invalid identities without changing any rows', t => {
  const { db, store } = fixture(t, { now: () => start * 1000 });
  take(store); store.recordRunEnd('test:a', { runId: 'first', reason: 'unexpected' });
  const before = snapshot(db);
  for (const group of [null, '', '*', 'origin']) assert.throws(() => take(store, group));
  for (const options of [null, {}, { runId: '', k: 2 }, { runId: 'r', k: 0 }, { runId: 'r', k: 1.5 }, { runId: 'r', k: 2, createdAt: 1 }]) assert.throws(() => store.takeSlot('test:b', options));
  for (const options of [{ runId: 'r' }, { runId: 'r', prior: null, now: 1 }, { runId: 'r', prior: { sessionGroup: 'test:a', runId: 'first', state: 'running', heldUntil: null, createdAt: start } }]) assert.throws(() => store.releaseSlot('test:a', options));
  assert.throws(() => store.pruneSlots({ orphans: [], minAgeSeconds: 30, now: 1 }));
  assert.deepEqual(snapshot(db), before);
  const single = createStore(db, { readConfig: () => ({ state: 'ok', config: { session_mode: 'single' } }) });
  assert.throws(() => take(single), { code: 'INVALID_ARGS' });
  assert.throws(() => single.releaseSlot('test:a', { runId: 'first', prior: null }), { code: 'INVALID_ARGS' });
  assert.throws(() => single.pruneSlots({ orphans: [], minAgeSeconds: 30 }), { code: 'INVALID_ARGS' });
  assert.deepEqual(snapshot(db), before);
});

test('slot reader returns exact public fields and propagates read failures instead of empty occupancy', t => {
  const { store } = fixture(t, { now: () => start * 1000 }); take(store);
  assert.deepEqual(store.listSlotOccupancy(), [{ sessionGroup: 'test:a', runId: 'first', state: 'running', heldUntil: null, createdAt: start }]);
  for (const code of ['SQLITE_BUSY', 'SQLITE_IOERR_READ']) {
    const failure = Object.assign(new Error('slot read failed'), { code });
    const broken = createStore({ prepare() { return { all() { throw failure; } }; } });
    assert.throws(() => broken.listSlotOccupancy(), error => code === 'SQLITE_BUSY' ? error.code === 'DB_BUSY' && error.cause === failure : error === failure);
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

test('schema two missing occupancy is rejected without changing schema or existing rows', t => {
  const db = new Database(':memory:'); t.after(() => db.close()); seedV1(db);
  migrateExisting(db, historicalOwner);
  const store = createStore(db, { readConfig: () => ({ state: 'ok', config: { session_mode: 'multi' } }) });
  store.recordRunEnd('test:a', { runId: 'r', reason: 'unexpected' });
  db.exec('DROP TABLE slot_occupancy'); const before = snapshot(db);
  assert.throws(() => guardDatabase(db, historicalOwner), /^Error: c4: unsupported schema 2, missing slot_occupancy\.session_group/);
  assert.deepEqual(snapshot(db), before);
});

test('public database facade exposes slot primitives', async () => {
  const facade = await import('../c4-db.js');
  for (const name of ['takeSlot', 'releaseSlot', 'adoptSlot', 'listSlotOccupancy', 'pruneSlots']) assert.equal(typeof facade[name], 'function');
});
