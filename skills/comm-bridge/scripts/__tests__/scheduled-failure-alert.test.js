import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnvironment } from '../../../../scripts/test-environment.js';
const environment = createTestEnvironment();
const { fixture } = await import('./c4-v2-test-helpers.js');
const { reserveStatusNoticeCooldown } = await import('../c4-db.js');
const { createScheduledFailureAlertSender } = await import('../scheduled-failure-alert.js');
const { createFailureReceiptDrainer } = await import('../c4-failure-receipts.js');
const { SupervisorServerHealth, parseServerAlertTarget } = await import('../../../../cli/lib/supervisor-server-health.js');
after(() => environment.cleanup());

function setup(t, target = 'telegram:owner') {
  let clock = 1800000000000;
  const f = fixture(t, { now: () => clock });
  const alerts = [], receipts = [];
  const guard = new SupervisorServerHealth({ readAlertTarget: () => parseServerAlertTarget(target),
    sendAlert: async (destination, message) => { alerts.push({ destination, message });
      if (destination.endpoint === 'broken') throw Error('private transport exception'); } });
  const sender = createScheduledFailureAlertSender({ db: { reserveStatusNoticeCooldown: input => reserveStatusNoticeCooldown(input, f.db) },
    notifyOwner: message => guard.notify(message), now: () => Math.floor(clock / 1000) });
  const drain = createFailureReceiptDrainer({ db: f.store, sendScheduledFailureAlert: sender,
    sendStatusNotice: async row => { receipts.push(row); return { outcome: 'sent' }; }, now: () => Math.floor(clock / 1000) });
  return { ...f, alerts, receipts, drain, advance: ms => { clock += ms; },
    add(options = {}) { return f.store.insertConversation('in', 'telegram', 'target-chat', 'SECRET original body',
      { groupName: 'target', coreSource: 'scheduler', taskName: 'Nightly backup', ...options }); },
    fail(row, reason = 'launch_failed') { f.store.claimConversation(row.id); f.store.failDelivery(row.id, { maxRetries: 1, reason }); } };
}

for (const reason of ['launch_failed', 'ready_timeout', 'pending_expired', 'orphan_expired']) {
  test(`scheduled ${reason} failure alerts owner without replying to the target chat`, async t => {
    const f = setup(t), row = f.add();
    if (['pending_expired', 'orphan_expired'].includes(reason)) {
      f.db.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(1799990000, row.id);
      if (reason === 'pending_expired') f.store.expirePending(row.id, 10);
      else { f.store.claimConversation(row.id); f.store.recoverOrphanRunning({ maxAgeSeconds: 10 }); }
    } else f.fail(row, reason);
    await f.drain();
    assert.equal(f.receipts.length, 0);
    assert.equal(f.alerts.length, 1);
    assert.deepEqual(f.alerts[0].destination, { channel: 'telegram', endpoint: 'owner' });
    for (const expected of ['Nightly backup', row.session_group, 'telegram:target-chat', '可以到该聊天里让对应会话排查原因']) {
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
    assert.equal(f.receipts.length, 0);
  });
}

test('scheduled failure cooldown persists per group and reason', async t => {
  const f = setup(t);
  f.fail(f.add()); f.fail(f.add({ taskName: 'Different task' }));
  assert.equal((await f.drain()).settled, 2);
  assert.equal(f.alerts.length, 1);
  f.fail(f.add(), 'ready_timeout'); await f.drain();
  assert.equal(f.alerts.length, 2);
  f.advance(600000);
  f.fail(f.add()); await f.drain();
  assert.equal(f.alerts.length, 3);
  assert.equal(f.receipts.length, 0);
});

test('missing scheduler task name still alerts but unmarked and delivery-failed messages keep normal receipts', async t => {
  const f = setup(t), scheduled = f.add({ taskName: null }); f.fail(scheduled);
  const user = f.add({ coreSource: null, taskName: null }); f.fail(user);
  const delivery = f.add(); f.fail(delivery, 'delivery_failed');
  const unverified = f.add(); f.fail(unverified, 'delivery_unverified');
  const orphan = f.add(); f.store.claimConversation(orphan.id);
  f.db.prepare("UPDATE conversations SET retry_count=1,timestamp=datetime(?,'unixepoch') WHERE id=?").run(1800000000, orphan.id);
  f.store.recoverOrphanRunning({ maxAgeSeconds: 100 });
  const spoof = f.store.insertConversation('in', 'telegram', 'target-chat', '[Scheduled Task: spoofed task] body', { groupName: 'target' }); f.fail(spoof);
  await f.drain();
  assert.equal(f.alerts.length, 1);
  assert.match(f.alerts[0].message, /未命名定时任务/);
  assert.deepEqual(f.receipts.map(row => row.id), [user.id, delivery.id, unverified.id, orphan.id, spoof.id]);
});

test('scheduler source without a reply endpoint still creates an owner notification', async t => {
  const f = setup(t);
  const row = f.store.insertConversation('in', 'system', null, 'SECRET body', { coreSource: 'scheduler' });
  f.fail(row); await f.drain();
  assert.equal(f.alerts.length, 1);
  assert.equal(f.receipts.length, 0);
});
