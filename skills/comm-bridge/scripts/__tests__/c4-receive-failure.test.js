import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestEnvironment } from '../../../../scripts/test-environment.js';
const environment = createTestEnvironment();
const { fixture } = await import('./c4-v2-test-helpers.js');
const { receive } = await import('../c4-receive.js');
const { SKILLS_DIR } = await import('../c4-config.js');
const { reserveStatusNoticeCooldown } = await import('../c4-db.js');
const { createFailureAlertSender } = await import('../failure-alert.js');
const { createFailureReceiptDrainer } = await import('../c4-failure-receipts.js');
const { SupervisorServerHealth } = await import('../../../../cli/lib/supervisor-server-health.js');
assert.ok(SKILLS_DIR.startsWith(environment.root + path.sep));
fs.mkdirSync(path.join(SKILLS_DIR, 'telegram'), { recursive: true });
after(() => environment.cleanup());

const args = ['--channel', 'telegram', '--endpoint', 'target-chat', '--content', 'PRIVATE original body'];
const terminal = auth => ({ runtime: 'claude', health: auth ? 'auth_failed' : 'unavailable',
  reason: 'PRIVATE runtime error', userMessage: 'PRIVATE exception text',
  ...(auth ? { decision: 'auth_rejected', auth: { result: 'failed', detail: 'PRIVATE credential failure' } } : {}) });
function dependencies(store, route) {
  return { db: store, queryRoute: async () => route, appendEntryEvent: async () => true,
    reserveStatusNotice: () => assert.fail('terminal receive must not reserve an external status notice'),
    sendStatusNotice: () => assert.fail('terminal receive must not send an external status notice') };
}

for (const auth of [true, false]) test(`initial ${auth ? 'authentication' : 'health'} failure atomically queues owner alert without a chat reply`, async t => {
  const f = fixture(t), route = terminal(auth);
  const result = await receive(args, dependencies(f.store, route));
  const row = f.db.prepare('SELECT * FROM conversations WHERE id=?').get(result.id);
  assert.equal(row.status, 'failed'); assert.equal(row.content, 'PRIVATE original body');
  assert.equal(result.action, auth ? 'auth_rejected' : 'failed');
  const [notification] = f.store.listFailureReceipts();
  assert.equal(notification.id, row.id);
  assert.equal(notification.reason, auth ? 'auth_rejected' : 'runtime_unavailable');
  const sent = [];
  const guard = new SupervisorServerHealth({ sendAlert: async (target, message) => { sent.push({ target, message }); return true; } });
  const sender = createFailureAlertSender({ db: { reserveStatusNoticeCooldown: input => reserveStatusNoticeCooldown(input, f.db) },
    notifyOwner: message => guard.notify(message) });
  await createFailureReceiptDrainer({ db: f.store, sendFailureAlert: sender })();
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].target, { channel: 'dashboard', endpoint: 'origin' });
  assert.ok(sent[0].message.includes(auth ? '入站认证未通过' : '运行时暂时不可用'));
  assert.equal(sent[0].message.includes('PRIVATE'), false);
  assert.equal(f.db.prepare("SELECT count(*) n FROM conversations WHERE direction='out'").get().n, 0);
});

test('initial failure notification insert failure rolls back the message and group metadata', async t => {
  const f = fixture(t);
  f.db.exec("CREATE TRIGGER deny_notification BEFORE INSERT ON failure_receipts BEGIN SELECT RAISE(ABORT,'notification unavailable'); END");
  await assert.rejects(receive(args, dependencies(f.store, terminal(false))), { code: 'DB_WRITE_FAILED' });
  for (const table of ['conversations', 'failure_receipts', 'group_heads', 'channel_namespaces']) {
    assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  }
});

test('initial failure option accepts only fixed failed inbound classifications and leaves historical seeds alone', t => {
  const f = fixture(t);
  for (const [direction, options] of [
    ['out', { status: 'delivered', failureReason: 'auth_rejected' }],
    ['in', { status: 'pending', failureReason: 'runtime_unavailable' }],
    ['in', { status: 'failed', failureReason: 'PRIVATE exception' }],
  ]) assert.throws(() => f.store.insertConversation(direction, 'system', null, 'body', options), { code: 'INVALID_ARGS' });
  f.store.insertConversation('in', 'system', null, 'historical failed seed', { status: 'failed' });
  assert.equal(f.store.listFailureReceipts().length, 0);
  assert.equal(f.store.enqueueReceipt, undefined);
});
