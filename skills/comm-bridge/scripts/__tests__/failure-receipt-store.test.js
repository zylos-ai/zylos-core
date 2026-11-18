import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './c4-v2-test-helpers.js';

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
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM conversations WHERE delivery_action='failure_receipt'").get().n, 1);
});

test('receipt write failure rolls back final failure and retry count', t => {
  const f = fixture(t), row = internal(f);
  f.db.exec("CREATE TRIGGER receipt_refusal BEFORE INSERT ON conversations WHEN NEW.delivery_action='failure_receipt' BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END");
  f.store.claimConversation(row.id);
  assert.throws(() => f.store.failDelivery(row.id, { maxRetries: 1 }), /receipt unavailable/);
  const original = f.db.prepare('SELECT status,retry_count FROM conversations WHERE id=?').get(row.id);
  assert.deepEqual(original, { status: 'running', retry_count: 0 });
});

for (const mode of ['pending_expired', 'orphan_expired']) {
  test(`${mode} creates one internal receipt and failed receipt never recurses`, t => {
    const now = Date.now(), f = fixture(t, { now: () => now }), row = internal(f);
    if (mode !== 'pending_expired') f.store.claimConversation(row.id);
    f.db.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(Math.floor(now / 1000) - 1000, row.id);
    if (mode === 'pending_expired') assert.equal(f.store.expirePending(row.id, 10), true);
    else f.store.recoverOrphanRunning({ maxAgeSeconds: 100 });
    const receipt = f.db.prepare("SELECT * FROM conversations WHERE delivery_action='failure_receipt'").get();
    assert.ok(receipt);
    f.db.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(Math.floor(now / 1000) - 1000, receipt.id);
    if (mode === 'pending_expired') f.store.expirePending(receipt.id, 10);
    else { f.store.claimConversation(receipt.id); f.store.recoverOrphanRunning({ maxAgeSeconds: 100 }); }
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM conversations WHERE delivery_action='failure_receipt'").get().n, 1);
  });
}
