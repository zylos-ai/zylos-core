import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fixture } from './c4-v2-test-helpers.js';
import { createTestEnvironment } from '../../../../scripts/test-environment.js';
const environment = createTestEnvironment();
const cooldownDb = await import('../c4-db.js');
const { createStatusNoticeSender } = await import('../c4-status-notice.js');
const { createFailureReceiptDrainer } = await import('../c4-failure-receipts.js');
const { createPendingExpiryHandler } = await import('../router/expiry.js');
after(() => { cooldownDb.close(); environment.cleanup(); });

function transport(f, sent) {
  const sendStatusNotice = createStatusNoticeSender({ db: cooldownDb, diagnostic: () => {}, log: () => {},
    spawn: (exe, argv) => {
      const child = new EventEmitter(); child.pid = 99; child.stdin = new EventEmitter();
      child.stdin.end = body => { sent.push({ argv, body }); queueMicrotask(() => child.emit('close', 0)); };
      child.kill = () => child.emit('close', null, 'SIGKILL'); return child;
    } });
  return createPendingExpiryHandler({ drainFailureReceipts: createFailureReceiptDrainer({ db: f.store, sendStatusNotice }) });
}

test('expiry drains only committed receipts and never resends the terminal row', async t => {
  const f = fixture(t), sent = [];
  const row = f.store.insertConversation('in', 'telegram', 'expiry-original', 'private expired body');
  const handleExpired = transport(f, sent);
  await handleExpired(row);
  assert.equal(sent.length, 0);
  f.db.prepare("UPDATE conversations SET timestamp=datetime('now','-1 hour') WHERE id=?").run(row.id);
  assert.equal(f.store.expirePending(row.id, 1800), true);
  await handleExpired(row); await handleExpired(row);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].argv.slice(1), ['telegram', 'expiry-original']);
  assert.match(sent[0].body, new RegExp(`消息 #${row.id} 没有送达`));
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
