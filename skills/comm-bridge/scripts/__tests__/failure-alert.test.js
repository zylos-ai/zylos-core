import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnvironment } from '../../../../scripts/test-environment.js';
const environment = createTestEnvironment();
const { fixture } = await import('./c4-v2-test-helpers.js');
const { reserveStatusNoticeCooldown } = await import('../c4-db.js');
const { createFailureAlertSender } = await import('../failure-alert.js');
const { createFailureReceiptDrainer } = await import('../c4-failure-receipts.js');
const { SupervisorServerHealth, parseServerAlertTarget } = await import('../../../../cli/lib/supervisor-server-health.js');
const { messageForFailureAlert } = await import('../failure-receipt-template.js');
after(() => environment.cleanup());

function setup(t, target = 'telegram:owner') {
  let clock = 1800000000000;
  const f = fixture(t, { now: () => clock });
  const alerts = [];
  const guard = new SupervisorServerHealth({ readAlertTarget: () => parseServerAlertTarget(target),
    sendAlert: async (destination, message) => { alerts.push({ destination, message });
      if (destination.endpoint === 'broken') throw Error('private transport exception'); } });
  const sender = createFailureAlertSender({ db: { reserveStatusNoticeCooldown: input => reserveStatusNoticeCooldown(input, f.db) },
    notifyOwner: message => guard.notify(message), now: () => Math.floor(clock / 1000) });
  const drain = createFailureReceiptDrainer({ db: f.store, sendFailureAlert: sender,
    now: () => Math.floor(clock / 1000) });
  return { ...f, alerts, drain, guard, advance: ms => { clock += ms; },
    add(options = {}) { return f.store.insertConversation('in', 'telegram', 'target-chat', 'SECRET original body',
      { groupName: 'target', coreSource: 'scheduler', taskName: 'Nightly backup', ...options }); },
    fail(row, reason = 'launch_failed') { f.store.claimConversation(row.id); f.store.failDelivery(row.id, { maxRetries: 1, reason }); } };
}

test('scheduled failure cooldown persists per group and reason', async t => {
  const f = setup(t);
  f.fail(f.add()); f.fail(f.add({ taskName: 'Different task' }));
  assert.equal((await f.drain()).settled, 2);
  assert.equal(f.alerts.length, 1);
  f.fail(f.add(), 'ready_timeout'); await f.drain();
  assert.equal(f.alerts.length, 2);
  f.advance(599000);
  f.fail(f.add()); await f.drain();
  assert.equal(f.alerts.length, 2);
  f.advance(1000);
  f.fail(f.add()); await f.drain();
  assert.equal(f.alerts.length, 3);
  assert.equal(f.alerts.some(alert => alert.destination.endpoint === 'target-chat'), false);
});

test('scheduler source without a reply endpoint still creates an owner notification', async t => {
  const f = setup(t);
  const row = f.store.insertConversation('in', 'system', null, 'SECRET body', { coreSource: 'scheduler' });
  f.fail(row); await f.drain();
  assert.equal(f.alerts.length, 1);
  assert.equal(f.alerts.some(alert => alert.destination.endpoint === 'target-chat'), false);
});

test('failure alert has complete fixed scheduler and user text without message or exception content', () => {
  const record = { id: 51, core_source: 'scheduler', task_name: null, reason: 'launch_failed',
    session_group: 'telegram:target', channel: 'telegram', endpoint_id: 'target-chat',
    content: 'SECRET original body', error: 'SECRET exception' };
  assert.equal(messageForFailureAlert(record),
    '[Zylos] 定时任务「未命名定时任务 / unnamed scheduled task」消息 #51 未送达：会话启动失败。\n' +
    '目标会话组：telegram:target\n来源聊天：telegram:target-chat\n' +
    '需要我排查原因吗？需要的话请直接回复这条消息。\n\n' +
    '[Zylos] Scheduled task "未命名定时任务 / unnamed scheduled task", message #51 was not delivered: session startup failed.\n' +
    'Target session group: telegram:target\nSource chat: telegram:target-chat\n' +
    'Would you like me to investigate? If so, please reply directly to this message.');
  assert.equal(messageForFailureAlert({ ...record, core_source: null }),
    '[Zylos] 用户消息 #51 未送达：会话启动失败。\n' +
    '目标会话组：telegram:target\n来源聊天：telegram:target-chat\n' +
    '需要我排查原因吗？需要的话请直接回复这条消息。\n\n' +
    '[Zylos] User message #51 was not delivered: session startup failed.\n' +
    'Target session group: telegram:target\nSource chat: telegram:target-chat\n' +
    'Would you like me to investigate? If so, please reply directly to this message.');
});

test('unverified delivery retains uncertainty and unknown reasons never render exception text', () => {
  const record = { id: 51, channel: 'telegram', endpoint_id: 'target-chat', session_group: 'telegram:target', reason: 'delivery_unverified' };
  assert.match(messageForFailureAlert(record), /未能确认送达/);
  assert.match(messageForFailureAlert(record), /could not be confirmed delivered/);
  assert.equal(messageForFailureAlert({ ...record, reason: 'SECRET exception' }).includes('SECRET exception'), false);
});

test('failed owner and Origin sends remain queued until a successful bounded retry', async t => {
  const f = setup(t), row = f.add({ coreSource: null }); f.fail(row);
  const targets = [];
  f.guard.sendAlert = async target => { targets.push(target); return false; };
  assert.deepEqual(await f.drain(), { attempted: 1, settled: 0, pending: 1 });
  assert.deepEqual(targets, [{ channel: 'telegram', endpoint: 'owner' }, { channel: 'dashboard', endpoint: 'origin' }]);
  assert.equal(f.db.prepare('SELECT state FROM failure_receipts WHERE conversation_id=?').get(row.id).state, 'queued');
  assert.equal((await f.drain()).attempted, 0);
  f.advance(31000);
  f.guard.sendAlert = async target => { targets.push(target); return true; };
  assert.deepEqual(await f.drain(), { attempted: 1, settled: 1, pending: 0 });
  assert.equal(targets.length, 3);
  assert.equal(f.db.prepare('SELECT state FROM failure_receipts WHERE conversation_id=?').get(row.id).state, 'sent');
});

// Real store and drainer with an injected clock and local owner sender. Run
// when receipt eligibility, backoff or expiry changes; skip unrelated UI changes.
// The official runner owns private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; the
// fixture owns its in-memory DB. No runtime, socket, transport or service runs.
test('internal failure receipts never enter the owner alert retry or expiry drain', async t => {
  const f = setup(t);
  f.store.insertConversation('in', 'chat', 'A', 'seed', { groupName: 'a' });
  f.store.insertConversation('in', 'chat', 'B', 'seed', { groupName: 'b' });
  const row = f.store.insertInternalMessage('chat:a', 'chat:b', 'private original body').inRow;
  f.fail(row);
  const snapshot = () => f.db.prepare('SELECT * FROM failure_receipts WHERE conversation_id=?').get(row.id);
  const before = snapshot();
  assert.equal(before.state, 'queued');
  assert.ok(before.receipt_conversation_id);
  const receipt = () => f.db.prepare('SELECT * FROM conversations WHERE id=?').get(before.receipt_conversation_id);
  const receiptBefore = receipt();
  for (const elapsed of [31000, 569000]) {
    f.advance(elapsed);
    assert.deepEqual(await f.drain(), { attempted: 0, settled: 0, pending: 0 });
    assert.equal(f.alerts.length, 0);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(receipt(), receiptBefore);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM failure_receipts').get().n, 1);
  }
});
