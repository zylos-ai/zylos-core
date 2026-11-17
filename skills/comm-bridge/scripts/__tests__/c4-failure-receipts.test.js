import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnvironment } from '../../../../scripts/test-environment.js';
const environment = createTestEnvironment();
const db = await import('../c4-db.js');
const { createFailureReceiptDrainer } = await import('../c4-failure-receipts.js');
const { messageForFailureReceipt } = await import('../failure-receipt-template.js');
const { fixture } = await import('./c4-v2-test-helpers.js');
after(() => { db.close(); environment.cleanup(); });

function record(id, extra = {}) {
  return { id, direction: 'in', channel: 'telegram', endpoint_id: 'receipt-room', session_group: 'telegram:receipt',
    created_at: Math.floor(Date.now() / 1000), reason: 'launch_failed', content: 'SECRET BODY', ...extra };
}
function persistedRecord(extra = {}) {
  const row = record(1, extra), connection = db.getDb();
  const id = Number(connection.prepare(`INSERT INTO conversations(direction,channel,endpoint_id,content,status,session_group)
    VALUES('in',?,?,?,'failed',?)`).run(row.channel, row.endpoint_id, row.content, row.session_group).lastInsertRowid);
  connection.prepare(`INSERT INTO failure_receipts(conversation_id,reason,state,created_at,updated_at)
    VALUES(?,?,'pending',?,?)`).run(id, row.reason, row.created_at, row.created_at);
  return { ...row, id };
}
function queue(rows) {
  const pending = new Map(rows.map(row => [row.id, row])), settled = [];
  return { settled, pending,
    listFailureReceipts: ({ limit }) => [...pending.values()].slice(0, limit),
    settleFailureReceipt: (id, outcome) => {
      settled.push([id, outcome]);
      if (['sent', 'suppressed', 'expired'].includes(outcome)) return pending.delete(id);
      const row = pending.get(id);
      if (row) { pending.delete(id); pending.set(id, row); }
      return false;
    },
  };
}

test('internal failure receipt renders only original routing metadata and fixed reason', () => {
  for (const reason of ['launch_failed', 'ready_timeout', 'pending_expired', 'orphan_expired', 'orphan_retry_exhausted']) {
    const message = messageForFailureReceipt(record(51, { reason, channel: 'internal' }));
    assert.match(message, /消息 #51 没有送达会话组「telegram:receipt」/);
    assert.match(message, /Please resend it later/);
    assert.equal(message.includes('SECRET BODY'), false);
    assert.equal(message.includes('执行失败'), false);
  }
  assert.equal(messageForFailureReceipt(record(51, { reason: 'SECRET ERROR' })).includes('SECRET ERROR'), false);
  assert.throws(() => messageForFailureReceipt(record(0)), /metadata/);
  assert.throws(() => messageForFailureReceipt(record(1, { session_group: 'group\nspoof' })), /metadata/);
});

test('a fresh drainer resumes persisted pending work and settles each receipt once', async () => {
  const transport = queue([record(71)]), calls = [];
  // No drainer ran before restart: the transaction already left a pending row.
  const drainAfterRestart = createFailureReceiptDrainer({ db: transport,
    sendFailureAlert: async row => { calls.push(row.id); return { outcome: 'sent' }; } });
  assert.equal((await drainAfterRestart()).settled, 1);
  assert.equal((await drainAfterRestart()).attempted, 0);
  assert.deepEqual(calls, [71]);
});

test('failed and uncertain receipt attempts can settle on a later successful retry', async () => {
  const transport = queue([record(81), record(82)]);
  const drain = createFailureReceiptDrainer({ db: transport,
    sendFailureAlert: async row => ({ outcome: row.id === 81 ? 'failed' : 'uncertain' }) });
  assert.deepEqual(await drain(), { attempted: 2, settled: 0, pending: 2 });
  assert.deepEqual(transport.settled, [[81, 'failed'], [82, 'uncertain']]);
  const calls = [];
  const retry = createFailureReceiptDrainer({ db: transport,
    sendFailureAlert: async row => { calls.push(row.id); return { outcome: 'sent' }; } });
  assert.deepEqual(await retry(), { attempted: 2, settled: 2, pending: 0 });
  assert.deepEqual(calls, [81, 82]);
  assert.equal(transport.pending.size, 0);
});

test('draining is bounded and overlapping calls share one transport operation', async () => {
  const transport = queue([record(91), record(92)]);
  let release, calls = 0;
  const held = new Promise(resolve => { release = resolve; });
  const drain = createFailureReceiptDrainer({ db: transport, limit: 1,
    sendFailureAlert: async () => { calls++; await held; return { outcome: 'sent' }; } });
  const first = drain(), second = drain();
  assert.equal(first, second);
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, { attempted: 1, settled: 1, pending: 0 });
  assert.equal(transport.pending.size, 1);
  assert.throws(() => createFailureReceiptDrainer({ db: transport, sendFailureAlert: () => {}, limit: 101 }), /limit/);
});

test('failed receipt attempts rotate behind later work beyond a drain batch', async () => {
  const transport = queue([record(101), record(102), record(103)]), calls = [];
  const drain = createFailureReceiptDrainer({ db: transport, limit: 2,
    sendFailureAlert: async row => { calls.push(row.id); return { outcome: row.id < 103 ? 'failed' : 'sent' }; } });
  assert.deepEqual(await drain(), { attempted: 2, settled: 0, pending: 2 });
  assert.deepEqual(await drain(), { attempted: 2, settled: 1, pending: 1 });
  assert.deepEqual(calls, [101, 102, 103, 101]);
  assert.equal(transport.pending.size, 2);
});

test('durable cooldown admission allows the same receipt again while suppressing another message', () => {
  const first = persistedRecord({ endpoint_id: 'admission-chat' });
  const second = persistedRecord({ endpoint_id: 'admission-chat' });
  const reservation = { cooldownKey: 'failure-admission-test', channel: 'dashboard', endpoint: 'origin',
    statusType: 'unavailable', reason: 'launch_failed', ttl: 600, now: 1800000000 };
  assert.equal(db.reserveStatusNoticeCooldown({ ...reservation, receiptId: first.id }).suppressed, false);
  assert.equal(db.getDb().prepare('SELECT state FROM failure_receipts WHERE conversation_id=?').get(first.id).state, 'queued');
  assert.equal(db.reserveStatusNoticeCooldown({ ...reservation, receiptId: first.id }).suppressed, false);
  assert.equal(db.reserveStatusNoticeCooldown({ ...reservation, receiptId: second.id }).suppressed, true);
  assert.equal(db.getDb().prepare('SELECT state FROM failure_receipts WHERE conversation_id=?').get(second.id).state, 'suppressed');
});

for (const outcome of ['failed', 'uncertain', 'throw']) test(`permanent ${outcome} transport stops sending and emits a terminal diagnostic`, async t => {
  let clock = 1800000000, sends = 0;
  const f = fixture(t, { now: () => clock * 1000 });
  const store = f.store, connection = f.db, events = [];
  const row = { ...store.insertConversation('in', 'telegram', `permanent-${outcome}`, 'SECRET BODY'), created_at: clock };
  store.claimConversation(row.id);
  store.failDelivery(row.id, { maxRetries: 1, reason: 'launch_failed' });
  const drain = createFailureReceiptDrainer({ db: store, now: () => clock,
    diagnostic: (event, fields) => events.push({ event, fields }),
    sendFailureAlert: async () => { sends++; if (outcome === 'throw') throw Error('SECRET'); return { outcome }; } });
  assert.equal((await drain()).pending, 1);
  assert.equal(sends, 1);
  const updated = connection.prepare('SELECT updated_at FROM failure_receipts WHERE conversation_id=?').get(row.id).updated_at;
  // Backoff is enforced by the real store, not an in-memory queue mock.
  assert.equal(store.listFailureReceipts().some(item => item.id === row.id), false);
  for (let elapsed = 31; elapsed < 600; elapsed += 31) {
    clock = row.created_at + elapsed;
    assert.equal((await drain()).pending, 1);
  }
  assert.equal(sends, 20);
  clock = row.created_at + 600;
  assert.equal((await drain()).settled, 1);
  assert.equal(sends, 20);
  assert.equal(connection.prepare('SELECT state FROM failure_receipts WHERE conversation_id=?').get(row.id).state, 'failed');
  assert.equal((await drain()).attempted, 0);
  assert.equal(events.length, 21);
  assert.equal(events[0].event, 'failure_receipt_send_failed');
  assert.equal(events[20].event, 'failure_receipt_exhausted');
  assert.equal(events[20].fields.conversation_id, row.id);
  assert.equal(JSON.stringify(events).includes('SECRET'), false);
  assert.ok(events.every(event => Object.values(event.fields).every(value =>
    value === null || ['string', 'number', 'boolean'].includes(typeof value))));
  assert.ok(updated > 0);
});
