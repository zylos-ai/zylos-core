import { fixture as storeFixture } from './c4-v2-test-helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardDatabase } from '../sqlite-schema.js';
// Existing layouts are migrated only by the explicit upgrade path, with the
// options ordinary openers used before they became check-only.

function fixture(t) {
  const { db, store } = storeFixture(t);
  const seed = (id, group = 'foo', status = 'delivered', direction = 'in') => db.prepare('INSERT INTO conversations(id,direction,channel,content,status,session_group) VALUES(?,?,?,?,?,?)').run(id, direction, group, `message ${id}`, status, group);
  const cps = () => db.prepare('SELECT * FROM checkpoints ORDER BY id').all();
  return { db, store, seed, cps };
}

test('a Dashboard reply address clears the pending startup reply for its conversation', t => {
  const { db, store } = fixture(t);
  const insert = db.prepare(`INSERT INTO conversations
    (id, timestamp, direction, channel, endpoint_id, content, status, session_group)
    VALUES (?, '2026-01-01 12:00:00', ?, 'dashboard', ?, ?, 'delivered', 'dash:dialog')`);
  const since = '2026-01-01T11:45:00Z';
  insert.run(1, 'in', 'dialog', 'Question');
  assert.equal(store.hasPendingStartupReply('dash:dialog', { since }), true);
  insert.run(2, 'out', 'dialog|msg:1', 'Answer');
  assert.equal(store.hasPendingStartupReply('dash:dialog', { since }), false);
});

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
test('unsummarized cursor pages traverse one group without gaps or duplicates', t => {
  const { store, seed } = fixture(t);
  seed(1); store.createCheckpoint('foo', 1, 'coverage');
  for (let i = 1; i <= 120; i++) { seed(i * 2); seed(i * 2 + 1, 'bar'); }
  seed(242, 'foo', 'pending'); seed(243);
  let afterConversationId = 0, seen = 0;
  for (const expectedCount of [50, 50, 20]) {
    const page = store.queries.unsummarized({ group: 'foo', afterConversationId, limit: 50 });
    assert.equal(page.rows.length, expectedCount); assert.equal(page.safeEnd, 241);
    for (const row of page.rows) { seen++; assert.equal(row.id, seen * 2); assert.equal(row.session_group, 'foo'); }
    assert.equal(page.upTo, seen < 120 ? seen * 2 : 241);
    afterConversationId = page.upTo;
  }
  assert.equal(seen, 120);
  assert.equal(store.queries.unsummarized({ group: 'foo', afterConversationId, limit: 50 }).rows.length, 0);
});

test('dream export samples coverage through each delivered frontier and leaves other groups independent', t => {
  const { db, store, seed } = fixture(t);
  seed(1);
  store.createCheckpoint('foo', 1, 'covered');
  seed(2);
  seed(3, 'foo', 'failed');
  seed(4, 'foo', 'pending');
  seed(5, 'foo', 'delivered', 'out');
  seed(6, 'bar');
  seed(7, 'empty');
  store.createCheckpoint('empty', 7, 'covered');
  db.exec('INSERT INTO group_heads(session_group, head_id) SELECT session_group, MAX(id) FROM conversations GROUP BY session_group');
  const exportIds = () => store.getDreamConversations().map(({ group, rows }) => [group, rows.map(({ id }) => id)]);
  assert.deepEqual(exportIds(), [['bar', [6]], ['foo', [2]]]);
  db.prepare("UPDATE conversations SET status='delivered' WHERE id=4").run();
  assert.deepEqual(exportIds(), [['bar', [6]], ['foo', [2, 4, 5]]]);
});
