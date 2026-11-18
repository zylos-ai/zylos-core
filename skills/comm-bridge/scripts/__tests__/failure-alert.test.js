import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnvironment } from '../../../../scripts/test-environment.js';
const environment = createTestEnvironment();
const { fixture } = await import('./c4-v2-test-helpers.js');
const { reserveStatusNoticeCooldown } = await import('../c4-db.js');
const { createFailureAlertSender } = await import('../failure-alert.js');
const { messageForFailureAlert } = await import('../failure-receipt-template.js');
after(() => environment.cleanup());

function setup(t, notifyResult) {
  let clock = 1800000000;
  const f = fixture(t);
  const alerts = [];
  const makeSender = () => createFailureAlertSender({
    db: { reserveStatusNoticeCooldown: input => reserveStatusNoticeCooldown(input, f.db) },
    notifyOwner: async message => { alerts.push(message); return notifyResult; },
    now: () => clock,
  });
  return { ...f, alerts, makeSender, sender: makeSender(), advance: seconds => { clock += seconds; } };
}
const record = { id: 51, reason: 'launch_failed', session_group: 'telegram:target',
  channel: 'telegram', endpoint_id: 'target-chat', content: 'SECRET original body', error: 'SECRET exception' };

test('failure cooldown persists per group and reason for ten minutes', async t => {
  const f = setup(t);
  await f.sender(record);
  await f.makeSender()({ ...record, id: 52 });
  assert.equal(f.alerts.length, 1);
  await f.sender({ ...record, reason: 'ready_timeout' });
  await f.sender({ ...record, session_group: 'telegram:other' });
  assert.equal(f.alerts.length, 3);
  f.advance(599);
  await f.sender(record);
  assert.equal(f.alerts.length, 3);
  f.advance(1);
  await f.sender(record);
  assert.equal(f.alerts.length, 4);
});

test('failure alert includes routing metadata and investigation question without private body or exception', () => {
  const message = messageForFailureAlert(record);
  for (const expected of ['#51', 'telegram:target', 'telegram:target-chat', 'session startup failed',
    '需要我排查原因吗', 'Would you like me to investigate?']) assert.ok(message.includes(expected), expected);
  for (const secret of ['SECRET original body', 'SECRET exception']) assert.equal(message.includes(secret), false);
});

test('unverified delivery retains uncertainty and unknown reasons never render exception text', () => {
  assert.match(messageForFailureAlert({ ...record, reason: 'delivery_unverified' }), /未能确认送达/);
  assert.match(messageForFailureAlert({ ...record, reason: 'delivery_unverified' }), /could not be confirmed delivered/);
  assert.equal(messageForFailureAlert({ ...record, reason: 'SECRET exception' }).includes('SECRET exception'), false);
});

test('owner notification is attempted once even when its return value is false', async t => {
  const f = setup(t, false);
  await f.sender(record);
  await f.sender(record);
  assert.deepEqual(f.alerts, [messageForFailureAlert(record)]);
});

test('internal messages and failure receipts never reserve owner alert cooldowns', async t => {
  const f = setup(t);
  await f.sender({ ...record, channel: 'internal' });
  await f.sender({ ...record, delivery_action: 'failure_receipt' });
  assert.equal(f.alerts.length, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM status_notice_cooldowns').get().n, 0);
});
