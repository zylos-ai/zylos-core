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
  const rowsBeforeReceiptFailure = f.db.prepare("SELECT count(*) AS n FROM conversations").get().n;
  exhaust(f.store, receipt);
  assert.equal(f.db.prepare("SELECT delivery_action FROM conversations WHERE id=?").get(receipt.id).delivery_action, 'failure_receipt');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM conversations").get().n, rowsBeforeReceiptFailure);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM conversations WHERE delivery_action='failure_receipt'").get().n, 1);
});
