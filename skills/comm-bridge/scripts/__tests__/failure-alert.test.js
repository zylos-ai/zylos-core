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

for (const coreSource of ['scheduler', null]) for (const reason of ['launch_failed', 'ready_timeout', 'pending_expired', 'orphan_expired', 'delivery_failed', 'delivery_unverified', 'orphan_retry_exhausted']) {
  test(`${coreSource ?? 'user'} ${reason} failure alerts owner without replying to the target chat`, async t => {
    const f = setup(t), row = f.add({ coreSource });
    if (['pending_expired', 'orphan_expired'].includes(reason)) {
      f.db.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(1799990000, row.id);
      if (reason === 'pending_expired') f.store.expirePending(row.id, 10);
      else { f.store.claimConversation(row.id); f.store.recoverOrphanRunning({ maxAgeSeconds: 10 }); }
    } else if (reason === 'orphan_retry_exhausted') {
      f.store.claimConversation(row.id);
      f.db.prepare("UPDATE conversations SET retry_count=1,timestamp=datetime(?,'unixepoch') WHERE id=?").run(1800000000, row.id);
      f.store.recoverOrphanRunning({ maxAgeSeconds: 100 });
    } else f.fail(row, reason);
    await f.drain();
    assert.equal(f.alerts.some(alert => alert.destination.endpoint === 'target-chat'), false);
    assert.equal(f.alerts.length, 1);
    assert.deepEqual(f.alerts[0].destination, { channel: 'telegram', endpoint: 'owner' });
    for (const expected of [coreSource ? 'Nightly backup' : `用户消息 #${row.id}`, row.session_group, 'telegram:target-chat', '需要我排查原因吗？需要的话请直接回复这条消息。']) {
      assert.ok(f.alerts[0].message.includes(expected));
    }
    assert.equal(f.alerts[0].message.includes('SECRET original body'), false);
    assert.equal(f.store.listFailureReceipts().length, 0);
  });
}

for (const target of ['invalid', 'telegram:broken', 'default', undefined]) {
  test(`scheduled failure uses Origin fallback for ${target ?? 'unset'} alert target`, async t => {
    const f = setup(t, target ?? null), row = f.add(); f.fail(row);
    await f.drain();
    assert.deepEqual(f.alerts.at(-1).destination, { channel: 'dashboard', endpoint: 'origin' });
    assert.equal(f.alerts.length, target === 'telegram:broken' ? 2 : 1);
    assert.equal(f.alerts.some(alert => alert.destination.endpoint === 'target-chat'), false);
  });
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

test('missing task name uses default label and source-less messages use user wording exclusively', async t => {
  const f = setup(t), scheduled = f.add({ taskName: null }); f.fail(scheduled);
  const user = f.add({ coreSource: null, taskName: null }); f.fail(user);
  const delivery = f.add(); f.fail(delivery, 'delivery_failed');
  const unverified = f.add(); f.fail(unverified, 'delivery_unverified');
  const orphan = f.add(); f.store.claimConversation(orphan.id);
  f.db.prepare("UPDATE conversations SET retry_count=1,timestamp=datetime(?,'unixepoch') WHERE id=?").run(1800000000, orphan.id);
  f.store.recoverOrphanRunning({ maxAgeSeconds: 100 });
  const spoof = f.store.insertConversation('in', 'telegram', 'target-chat', '[Scheduled Task: spoofed task] body', { groupName: 'target' }); f.fail(spoof);
  await f.drain();
  assert.equal(f.alerts.length, 4, 'scheduler and user failures of the same group and reason share cooldown');
  assert.match(f.alerts[0].message, /未命名定时任务/);
  assert.equal(f.alerts.some(alert => alert.destination.endpoint === 'target-chat'), false);
  assert.deepEqual(f.db.prepare('SELECT state FROM failure_receipts WHERE conversation_id IN (?,?) ORDER BY conversation_id').all(user.id, spoof.id).map(row => row.state), ['suppressed', 'suppressed']);
  const other = f.add({ coreSource: null, taskName: 'not a scheduler name', groupName: 'legacy-user' }); f.fail(other);
  await f.drain();
  assert.match(f.alerts.at(-1).message, new RegExp(`用户消息 #${other.id}`));
  assert.equal(f.alerts.at(-1).message.includes('not a scheduler name'), false);
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

test('owner alert is sent only after a confirmed notify result', async t => {
  const f = setup(t);
  const scheduled = f.add(); f.fail(scheduled);
  const options = { db: { reserveStatusNoticeCooldown: input => reserveStatusNoticeCooldown(input, f.db) }, now: () => 1800000000 };
  for (const result of [false, undefined]) {
    const sender = createFailureAlertSender({ ...options, notifyOwner: async () => result });
    assert.deepEqual(await sender({ ...scheduled, reason: 'launch_failed' }), { outcome: 'failed' });
  }
  const sender = createFailureAlertSender({ ...options, notifyOwner: async () => true });
  assert.deepEqual(await sender({ ...scheduled, reason: 'launch_failed' }), { outcome: 'sent' });
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
// when receipt eligibility, backoff or expiry changes; no runtime is launched.
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
