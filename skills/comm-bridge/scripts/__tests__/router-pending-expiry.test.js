import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnvironment } from '../../../../scripts/test-environment.js';
const environment = createTestEnvironment();
const { fixture } = await import('./c4-v2-test-helpers.js');
const cooldownDb = await import('../c4-db.js');
const { createFailureAlertSender } = await import('../failure-alert.js');
const { SupervisorServerHealth } = await import('../../../../cli/lib/supervisor-server-health.js');
const { createFailureReceiptDrainer } = await import('../c4-failure-receipts.js');
const { createPendingExpiryHandler } = await import('../router/expiry.js');
after(() => { cooldownDb.close(); environment.cleanup(); });

function transport(f, sent) {
  const owner = new SupervisorServerHealth({ readAlertTarget: () => ({ channel: 'telegram', endpoint: 'owner' }),
    sendAlert: async (target, body) => { sent.push({ target, body }); return true; } });
  const sendFailureAlert = createFailureAlertSender({
    db: { reserveStatusNoticeCooldown: params => cooldownDb.reserveStatusNoticeCooldown(params, f.db) },
    notifyOwner: message => owner.notify(message) });
  return createPendingExpiryHandler({ drainFailureReceipts: createFailureReceiptDrainer({ db: f.store, sendFailureAlert }) });
}

test('expiry alerts only the owner after commit and never resends the terminal row', async t => {
  const f = fixture(t), sent = [];
  const row = f.store.insertConversation('in', 'telegram', 'expiry-original', 'private expired body');
  const handleExpired = transport(f, sent);
  await handleExpired(row);
  assert.equal(sent.length, 0);
  f.db.prepare("UPDATE conversations SET timestamp=datetime('now','-1 hour') WHERE id=?").run(row.id);
  assert.equal(f.store.expirePending(row.id, 1800), true);
  await handleExpired(row); await handleExpired(row);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].target, { channel: 'telegram', endpoint: 'owner' });
  assert.match(sent[0].body, /telegram:expiry-original/);
  assert.ok(sent[0].body.includes(`#${row.id}`));
  assert.match(sent[0].body, /排队等待超时/);
  assert.equal(sent[0].body.includes('private expired body'), false);
  assert.equal(f.db.prepare('SELECT status FROM conversations WHERE id=?').get(row.id).status, 'failed');
});

test('internal expiry queues to the original sender without an external send', async t => {
  const f = fixture(t), sent = [];
  f.store.insertConversation('in', 'chat', 'sender', 'seed', { groupName: 'sender' });
  const row = f.store.insertInternalMessage('chat:sender', 'chat:target', 'private').inRow;
  f.db.prepare("UPDATE conversations SET timestamp=datetime('now','-1 hour') WHERE id=?").run(row.id);
  assert.equal(f.store.expirePending(row.id, 1800), true);
  await transport(f, sent)(row);
  assert.equal(sent.length, 0);
  const receipt = f.db.prepare("SELECT * FROM conversations WHERE delivery_action='failure_receipt'").get();
  assert.equal(receipt.session_group, 'chat:sender');
  assert.equal(receipt.endpoint_id, 'chat:target');
  assert.equal(receipt.content.includes('private'), false);
});
