import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { fixture } from './c4-v2-test-helpers.js';
import { createStore } from '../c4-v2-store.js';

function internal(f) {
  f.store.insertConversation('in', 'chat', 'A', 'seed', { groupName: 'a' });
  f.store.insertConversation('in', 'chat', 'B', 'seed', { groupName: 'b' });
  return f.store.insertInternalMessage('chat:a', 'chat:b', 'private original text').inRow;
}
function exhaust(store, row) {
  assert.equal(store.claimConversation(row.id), true);
  assert.equal(store.failDelivery(row.id, { maxRetries: 2 }).status, 'pending');
  assert.equal(store.claimConversation(row.id), true);
  assert.equal(store.failDelivery(row.id, { maxRetries: 2 }).status, 'failed');
}

test('internal final failure atomically queues exactly one receipt to the recorded sender', t => {
  const f = fixture(t), row = internal(f);
  exhaust(f.store, row);
  assert.equal(f.store.failDelivery(row.id).changed, false);
  const receipt = f.db.prepare("SELECT * FROM conversations WHERE delivery_action='failure_receipt'").get();
  assert.equal(receipt.session_group, 'chat:a');
  assert.equal(receipt.endpoint_id, 'chat:b');
  assert.equal(receipt.direction, 'in');
  assert.ok(receipt.content.includes(String(row.id)));
  assert.ok(receipt.content.includes('chat:b'));
  assert.match(receipt.content, /系统回执，无需回复/);
  assert.equal(receipt.content.includes('private original text'), false);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM conversations WHERE delivery_action='failure_receipt'").get().n, 1);
  assert.equal(f.db.prepare("SELECT head_id FROM group_heads WHERE session_group='chat:a'").get().head_id, receipt.id);
  exhaust(f.store, receipt);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM failure_receipts').get().n, 1);
  assert.equal(f.store.listFailureReceipts().length, 0);
});

test('receipt write failure rolls back final failure and retry count', t => {
  const f = fixture(t), row = internal(f);
  f.db.exec("CREATE TRIGGER receipt_refusal BEFORE INSERT ON failure_receipts BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END");
  f.store.claimConversation(row.id);
  assert.throws(() => f.store.failDelivery(row.id, { maxRetries: 1 }), /receipt unavailable/);
  const original = f.db.prepare('SELECT status,retry_count FROM conversations WHERE id=?').get(row.id);
  assert.deepEqual(original, { status: 'running', retry_count: 0 });
});

for (const mode of ['pending_expired', 'orphan_expired', 'orphan_retry_exhausted']) {
  test(`${mode} creates one internal receipt and failed receipt never recurses`, t => {
    const now = Date.now(), f = fixture(t, { now: () => now }), row = internal(f);
    if (mode !== 'pending_expired') f.store.claimConversation(row.id);
    if (mode === 'orphan_retry_exhausted') f.db.prepare('UPDATE conversations SET retry_count=1 WHERE id=?').run(row.id);
    else f.db.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(Math.floor(now / 1000) - 1000, row.id);
    if (mode === 'pending_expired') assert.equal(f.store.expirePending(row.id, 10), true);
    else f.store.recoverOrphanRunning({ maxAgeSeconds: 100 });
    const receipt = f.db.prepare("SELECT * FROM conversations WHERE delivery_action='failure_receipt'").get();
    assert.ok(receipt);
    f.db.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(Math.floor(now / 1000) - 1000, receipt.id);
    if (mode === 'pending_expired') f.store.expirePending(receipt.id, 10);
    else { f.store.claimConversation(receipt.id); f.store.recoverOrphanRunning({ maxAgeSeconds: 100 }); }
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM failure_receipts').get().n, 1);
  });
}

test('external owner alert survives database close before send and settles once', t => {
  const f = fixture(t, {}, true);
  const row = f.store.insertConversation('in', 'telegram', 'original-chat', 'private body');
  exhaust(f.store, row);
  f.db.close();
  const reopened = new Database(f.filename);
  t.after(() => reopened.close());
  const store = createStore(reopened);
  const pending = store.listFailureReceipts();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, row.id);
  assert.equal(pending[0].endpoint_id, 'original-chat');
  assert.equal(pending[0].reason, 'delivery_failed');
  assert.equal(Object.hasOwn(pending[0], 'content'), false);
  assert.equal(store.settleFailureReceipt(row.id, 'sent'), true);
  assert.equal(store.settleFailureReceipt(row.id, 'uncertain'), false);
  assert.equal(store.listFailureReceipts().length, 0);
});

test('old failed rows are not backfilled and new noninternal failures queue owner alerts without endpoints', t => {
  const f = fixture(t);
  f.store.insertConversation('in', 'telegram', 'chat', 'old', { status: 'failed' });
  const system = f.store.insertConversation('in', 'system', null, 'task');
  exhaust(f.store, system);
  assert.equal(f.store.listFailureReceipts().length, 1);
  assert.equal(f.store.listFailureReceipts()[0].id, system.id);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM failure_receipts').get().n, 1);
});

for (const state of ['pending', 'queued']) test(`external ${state} alert preserves backoff through restart`, t => {
  let clock = 1800000000000;
  const f = fixture(t, { now: () => clock }, true);
  const row = f.store.insertConversation('in', 'telegram', 'retry-chat', 'private body');
  exhaust(f.store, row);
  if (state === 'queued') f.db.prepare("UPDATE failure_receipts SET state='queued' WHERE conversation_id=?").run(row.id);
  f.store.settleFailureReceipt(row.id, 'uncertain');
  assert.equal(f.store.listFailureReceipts().length, 0);
  const before = f.db.prepare('SELECT * FROM failure_receipts WHERE conversation_id=?').get(row.id);
  f.db.close();
  const reopened = new Database(f.filename);
  t.after(() => reopened.close());
  const restarted = createStore(reopened, { now: () => clock });
  assert.equal(restarted.listFailureReceipts().length, 0);
  assert.deepEqual(reopened.prepare('SELECT * FROM failure_receipts WHERE conversation_id=?').get(row.id), before);
  clock += 31000;
  assert.equal(restarted.listFailureReceipts()[0].id, row.id);
  assert.equal(restarted.settleFailureReceipt(row.id, 'sent'), true);
  assert.equal(restarted.listFailureReceipts().length, 0);
});

test('external retry backoff leaves untouched work immediately eligible', t => {
  let clock = 1800000000000;
  const f = fixture(t, { now: () => clock });
  const first = f.store.insertConversation('in', 'telegram', 'first-chat', 'first');
  const second = f.store.insertConversation('in', 'telegram', 'second-chat', 'second');
  exhaust(f.store, first); exhaust(f.store, second);
  f.store.settleFailureReceipt(first.id, 'failed');
  assert.deepEqual(f.store.listFailureReceipts().map(row => row.id), [second.id]);
  clock += 31000;
  assert.deepEqual(f.store.listFailureReceipts().map(row => row.id), [second.id, first.id]);
});

for (const outcome of ['failed', 'uncertain']) test(`permanently ${outcome} owner alert stops after its persisted lifetime`, t => {
  let clock = 1800000000000;
  const f = fixture(t, { now: () => clock }, true);
  const row = f.store.insertConversation('in', 'telegram', 'dead-chat', 'private body');
  exhaust(f.store, row);
  f.store.settleFailureReceipt(row.id, outcome);
  // Even a future attempt timestamp cannot hide expired work from terminal settlement.
  clock += 600000;
  assert.equal(f.store.listFailureReceipts()[0].id, row.id);
  assert.equal(f.store.settleFailureReceipt(row.id, 'expired'), true);
  assert.equal(f.store.settleFailureReceipt(row.id, 'expired'), false);
  assert.equal(f.store.listFailureReceipts().length, 0);
  assert.equal(f.db.prepare('SELECT state FROM failure_receipts WHERE conversation_id=?').get(row.id).state, 'failed');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM failure_receipts').get().n, 1);
});
