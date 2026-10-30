import { fixture as storeFixture, modifiedStore } from './c4-v2-test-helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { guardDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';
function fixture(t) {
  const { db, store } = storeFixture(t);
  const seed = (id, group = 'foo', status = 'delivered', direction = 'in') => db.prepare('INSERT INTO conversations(id,direction,channel,content,status,session_group) VALUES(?,?,?,?,?,?)').run(id, direction, group, `message ${id}`, status, group);
  const cps = () => db.prepare('SELECT * FROM checkpoints ORDER BY id').all();
  return { db, store, seed, cps };
}
test('checkpoint rejects gap, regression, per-group head overflow and invalid summaries without writes', t => {
  const { store, seed, cps } = fixture(t);
  seed(9); seed(10, 'foo', 'pending'); seed(20); seed(100, 'bar');
  const before = cps();
  for (const [end, summary, options, code] of [[20, 'x', {}, 'CHECKPOINT_GAP'], [1e12, 'x', {}, 'CHECKPOINT_GAP'], [9, '', {}, 'SUMMARY_INVALID'], [9, 'x', { noContent: true }, 'SUMMARY_INVALID']]) {
    assert.throws(() => store.createCheckpoint('foo', end, summary, options), { code }); assert.deepEqual(cps(), before);
  }
  const cp = store.createCheckpoint('foo', 9, 'valid'); assert.equal(cp.end_conversation_id, 9);
  assert.throws(() => store.createCheckpoint('foo', 8, 'regression'), { code: 'CHECKPOINT_REGRESSION' });
  seed(101, 'only');
  assert.throws(() => store.createCheckpoint('only', 1e12, 'above head'), { code: 'CHECKPOINT_BEYOND_HEAD' });
  assert.throws(() => store.createCheckpoint('bar', 101, 'cross-group head'), { code: 'CHECKPOINT_BEYOND_HEAD' });
  assert.equal(cps().length, before.length + 1);
});
test('initial NULL checkpoint is zero, and baseline uses latest id while coverage uses maximum end', t => {
  const { db, store, seed } = fixture(t);
  db.prepare("INSERT INTO checkpoints(summary,start_conversation_id,end_conversation_id,session_group,no_content) VALUES('initial',NULL,NULL,'*',0)").run();
  seed(1); seed(2); seed(3);
  assert.equal(store.legacyBaselineEnd(), 0); assert.equal(store.getGlobalCoverageEnd(), 0); assert.equal(store.getCoverageEnd('foo'), 0);
  store.createCheckpoint('*', 3, 'three');
  assert.equal(store.legacyBaselineEnd(), 3); assert.equal(store.getCoverageEnd('foo'), 3);
  assert.throws(() => store.createCheckpoint('*', 2, 'two'), { code: 'CHECKPOINT_REGRESSION' });
  // Historical/manual state distinguishes latest-id baseline from MAX(end).
  db.prepare("INSERT INTO checkpoints(summary,end_conversation_id,session_group,no_content) VALUES('later-null',NULL,'*',0)").run();
  assert.equal(store.legacyBaselineEnd(), 0); assert.equal(store.getGlobalCoverageEnd(), 3);
});
test('content checkpoint isolation and no-content rows do not hide content', t => {
  const { store, seed } = fixture(t); seed(1); seed(2); seed(3); seed(4);
  store.createCheckpoint('*', 1, 'global');
  assert.equal(store.getLatestContentCheckpoint('foo'), null);
  const cp = store.createCheckpoint('foo', 2, 'group'); store.createCheckpoint('foo', 3, null, { noContent: true });
  assert.equal(store.getLatestContentCheckpoint('foo').id, cp.id);
  assert.deepEqual(store.getContentCheckpointsSince('foo', 1).map(x => x.id), [cp.id]);
  assert.equal(store.getLatestContentCheckpoint('*').summary, 'global');
  const global = store.createCheckpoint('*', 4, 'new global');
  assert.equal(store.getLatestContentCheckpoint('foo'), null); assert.equal(store.getLatestContentCheckpoint('*').id, global.id);
});
for (const terminal of ['failed', 'switch_absorbed']) test(`${terminal} crosses frontier but does not enter unsummarized range`, t => {
  const { store, seed } = fixture(t); seed(9); store.createCheckpoint('foo', 9, 'coverage'); seed(10, 'foo', terminal); seed(11);
  assert.equal(store.getDeliveredFrontier('foo'), 11);
  assert.equal(store.getUnsummarizedRange('foo').count, 1);
  assert.deepEqual(store.getUnsummarizedConversations('foo', { upToConversationId: 11 }).map(x => x.id), [11]);
  seed(12, 'foo', 'pending'); seed(13); seed(14, 'bar');
  assert.equal(store.getDeliveredFrontier('foo'), 11); assert.equal(store.getDeliveredFrontier('bar'), 14);
  assert.equal(store.getGlobalDeliveredFrontier(), 11);
  assert.throws(() => store.getUnsummarizedConversations('foo', { upToConversationId: 13 }), { code: 'UPTO_BEYOND_FRONTIER' });
});
test('tail uses fixed coverage and includes only delivered input or output despite later Sync', t => {
  const { store, seed } = fixture(t);
  seed(1); store.createCheckpoint('foo', 1, 'old');
  seed(2); seed(3, 'foo', 'failed'); seed(4, 'foo', 'pending'); seed(5, 'foo', 'delivered', 'out'); seed(6, 'bar'); seed(7);
  const fixedCoverage = store.getCoverageEnd('foo');
  // Advance only to a safe boundary; the fixed tail must still include id 2.
  store.createCheckpoint('foo', 2, 'new');
  assert.deepEqual(store.getDeliveredSince('foo', fixedCoverage, { limit: 20 }).map(x => x.id), [2, 5, 7]);
  assert.deepEqual(store.getDeliveredSince('foo', fixedCoverage, { limit: 2 }).map(x => x.id), [5, 7]);
  assert.deepEqual(store.getGlobalDeliveredSince(fixedCoverage, { limit: 20 }).map(x => x.id), [2, 5, 6, 7]);
});
test('Origin summaries return delta plus independent coverage and maximum returned content id; raw honors fixed C', t => {
  const { store } = fixture(t);
  const a = store.insertConversation('out', 'foo', 'e', 'a'); const b = store.insertConversation('out', 'foo', 'e', 'b');
  const content = store.createCheckpoint('foo', a.id, 'content'); const noContent = store.createCheckpoint('foo', b.id, null, { noContent: true });
  const result = store.queries.originSummaries('foo');
  assert.deepEqual(result.rows.map(x => x.id), [content.id]); assert.equal(result.coverageEnd, b.id); assert.equal(result.checkpointId, content.id);
  store.advanceOriginSyncCursor('foo', { syncedId: b.id, checkpointId: noContent.id });
  assert.deepEqual(store.queries.originSummaries('foo').rows, []);
  const c = store.insertConversation('out', 'foo', 'e', 'c'); store.createCheckpoint('foo', c.id, 'later');
  assert.deepEqual(store.getOriginSyncConversations('foo', { afterConversationId: b.id, rawAfter: result.coverageEnd, upToConversationId: c.id, limit: 20 }).map(x => x.id), [c.id]);
});
test('Origin cursor rejection and trigger failure leave both cursor columns unchanged', t => {
  const { db, store } = fixture(t);
  const a = store.insertConversation('out', 'foo', 'e', 'a'); const cp = store.createCheckpoint('foo', a.id, 'summary');
  store.advanceOriginSyncCursor('foo', { syncedId: a.id, checkpointId: cp.id });
  const read = () => db.prepare('SELECT * FROM origin_sync_cursors').get(); const before = read();
  for (const [syncedId, checkpointId] of [[0, cp.id], [a.id + 1, cp.id], [a.id, 0], [a.id, cp.id + 1]]) {
    assert.throws(() => store.advanceOriginSyncCursor('foo', { syncedId, checkpointId }), { code: 'CURSOR_INVALID' }); assert.deepEqual(read(), before);
  }
  db.exec("CREATE TRIGGER reject_cursor BEFORE UPDATE ON origin_sync_cursors BEGIN SELECT RAISE(ABORT,'reject cursor'); END");
  assert.throws(() => store.advanceOriginSyncCursor('foo', { syncedId: a.id, checkpointId: cp.id }), { code: 'DB_WRITE_FAILED' }); assert.deepEqual(read(), before);
});
test('calibration: assertion detects a mutant that blocks on failed input', async t => {
  const mutatedCreateStore = await modifiedStore('c4-store-progress.js',
    "status NOT IN ('delivered','failed','switch_absorbed')", "status NOT IN ('delivered','switch_absorbed')");
  const { db, store, seed } = fixture(t); seed(9); store.createCheckpoint('foo', 9, 'coverage'); seed(10, 'foo', 'failed'); seed(11);
  const acceptance = candidate => assert.equal(candidate.getDeliveredFrontier('foo'), 11);
  acceptance(store);
  assert.throws(() => acceptance(mutatedCreateStore(db)), assert.AssertionError);
});
for (const [name, ends, baseline] of [
  ['FX-BL1', [null, 300, 800], 800],
  ['FX-BL2', [300, 800, null], 0],
  ['FX-BL3', [null, 800, 500], 500],
]) test(`${name} migrates historical baseline shape and preserves identical new-group reads`, async t => {
  const { seedV1 } = await import('./helpers/c4-v2-fixtures.js');
  const db = new Database(':memory:'); t.after(() => db.close()); seedV1(db);
  db.exec('DELETE FROM checkpoints');
  const checkpoint = db.prepare('INSERT INTO checkpoints(id,summary,end_conversation_id) VALUES(?,?,?)');
  ends.forEach((end, i) => checkpoint.run(i + 1, `historical ${i}`, end));
  db.prepare("INSERT INTO conversations(id,direction,channel,content,status) VALUES(1000,'out','legacy','old boundary','delivered')").run();
  guardDatabase(db, owner);
  const store = createStore(db, { validateComponent: () => true });
  const rows = ['one', 'two', 'three'].map(content => store.insertConversation('out', 'g', 'e', content));
  assert.deepEqual(rows.map(row => row.id), [1001, 1002, 1003]);
  assert.equal(store.legacyBaselineEnd(), baseline); assert.equal(store.getGlobalCoverageEnd(), 800); assert.equal(store.getCoverageEnd('g'), baseline);
  assert.equal(store.getLatestContentCheckpoint('g'), null);
  assert.deepEqual(store.getUnsummarizedConversations('g', { upToConversationId: 1003 }).map(row => row.id), [1001, 1002, 1003]);
  assert.deepEqual(store.getDeliveredSince('g', baseline, { limit: 20 }).map(row => row.id), [1001, 1002, 1003]);
  const cursor = store.getOriginSyncBacklog().groups.find(group => group.sessionGroup === 'g');
  assert.equal(cursor.cursorFrom, baseline); assert.equal(cursor.count, 3);
  const cp = store.createCheckpoint('g', 1003, 'new group summary');
  assert.equal(cp.start_conversation_id, 1001); assert.equal(store.getCoverageEnd('g'), 1003);
  assert.deepEqual(store.getContentCheckpointsSince('g', 0).map(row => row.id), [cp.id]);
  assert.equal(store.getLatestContentCheckpoint('g').summary, 'new group summary');
});
