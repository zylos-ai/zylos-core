import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTestEnvironment } from '../../../../scripts/test-environment.js';
const environment = createTestEnvironment();
const db = await import('../c4-db.js');
const { createStatusNoticeSender, STATUS_NOTICE_TTL_SECONDS } = await import('../c4-status-notice.js');
const { createFailureReceiptDrainer } = await import('../c4-failure-receipts.js');
const { messageForFailureReceipt } = await import('../failure-receipt-template.js');
after(() => { db.close(); environment.cleanup(); });

function record(id, extra = {}) {
  return { id, direction: 'in', channel: 'telegram', endpoint_id: 'receipt-room', session_group: 'telegram:receipt',
    reason: 'launch_failed', content: 'SECRET BODY', ...extra };
}
function child(onBody, status = 0) {
  const result = new EventEmitter(); result.pid = 42;
  result.stdin = new EventEmitter();
  result.stdin.end = body => { onBody(body); queueMicrotask(() => result.emit('close', status, null)); };
  result.kill = () => { queueMicrotask(() => result.emit('close', null, 'SIGKILL')); };
  return result;
}
function queue(rows) {
  const pending = new Map(rows.map(row => [row.id, row])), settled = [];
  return { settled, pending,
    listFailureReceipts: ({ limit }) => [...pending.values()].slice(0, limit),
    settleFailureReceipt: (id, outcome) => { settled.push([id, outcome]); return pending.delete(id); },
  };
}

test('failure receipt renders only original routing metadata and fixed reason', () => {
  for (const reason of ['launch_failed', 'ready_timeout', 'pending_expired', 'orphan_expired', 'orphan_retry_exhausted']) {
    const message = messageForFailureReceipt(record(51, { reason }));
    assert.match(message, /消息 #51 没有送达会话组「telegram:receipt」/);
    assert.match(message, /Please resend it later/);
    assert.equal(message.includes('SECRET BODY'), false);
    assert.equal(message.includes('执行失败'), false);
  }
  assert.equal(messageForFailureReceipt(record(51, { reason: 'SECRET ERROR' })).includes('SECRET ERROR'), false);
  assert.throws(() => messageForFailureReceipt(record(0)), /metadata/);
  assert.throws(() => messageForFailureReceipt(record(1, { session_group: 'group\nspoof' })), /metadata/);
});

test('external receipt reuses original endpoint and status cooldown across messages', async () => {
  let clock = 1800000000;
  const calls = [];
  const send = createStatusNoticeSender({ db, now: () => clock, diagnostic: () => {}, log: () => {},
    render: () => assert.fail('failure receipt must use the metadata renderer'),
    spawn: (exe, argv) => child(body => calls.push({ argv, body })) });
  const first = record(61, { endpoint_id: 'original-chat|msg:100' });
  const second = record(62, { endpoint_id: 'original-chat|msg:101' });
  const transport = queue([first, second]);
  const drain = createFailureReceiptDrainer({ db: transport, sendStatusNotice: send });
  assert.deepEqual(await drain(), { attempted: 2, settled: 2, pending: 0 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv.slice(1), ['telegram', first.endpoint_id]);
  assert.equal(calls[0].body, messageForFailureReceipt(first));
  assert.deepEqual(transport.settled, [[61, 'sent'], [62, 'suppressed']]);
  clock += STATUS_NOTICE_TTL_SECONDS;
  const next = queue([record(63, { endpoint_id: first.endpoint_id })]);
  await createFailureReceiptDrainer({ db: next, sendStatusNotice: send })();
  assert.equal(calls.length, 2);
});

test('a fresh drainer resumes persisted pending work and settles each receipt once', async () => {
  const transport = queue([record(71)]), calls = [];
  // No drainer ran before restart: the transaction already left a pending row.
  const drainAfterRestart = createFailureReceiptDrainer({ db: transport,
    sendStatusNotice: async row => { calls.push(row.id); return { outcome: 'sent' }; } });
  assert.equal((await drainAfterRestart()).settled, 1);
  assert.equal((await drainAfterRestart()).attempted, 0);
  assert.deepEqual(calls, [71]);
});

test('failed and uncertain receipt outcomes are terminal without automatic retry', async () => {
  const transport = queue([record(81), record(82)]);
  const drain = createFailureReceiptDrainer({ db: transport,
    sendStatusNotice: async row => ({ outcome: row.id === 81 ? 'failed' : 'uncertain' }) });
  assert.deepEqual(await drain(), { attempted: 2, settled: 2, pending: 0 });
  assert.deepEqual(transport.settled, [[81, 'failed'], [82, 'uncertain']]);
  const retry = createFailureReceiptDrainer({ db: transport, sendStatusNotice: async () => assert.fail('failed receipts must not retry') });
  assert.equal((await retry()).attempted, 0);
  assert.equal(transport.pending.size, 0);
});

test('draining is bounded and overlapping calls share one transport operation', async () => {
  const transport = queue([record(91), record(92)]);
  let release, calls = 0;
  const held = new Promise(resolve => { release = resolve; });
  const drain = createFailureReceiptDrainer({ db: transport, limit: 1,
    sendStatusNotice: async () => { calls++; await held; return { outcome: 'sent' }; } });
  const first = drain(), second = drain();
  assert.equal(first, second);
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, { attempted: 1, settled: 1, pending: 0 });
  assert.equal(transport.pending.size, 1);
  assert.throws(() => createFailureReceiptDrainer({ db: transport, sendStatusNotice: () => {}, limit: 101 }), /limit/);
});

test('failed receipt targets cannot starve later receipts beyond a drain batch', async () => {
  const transport = queue([record(101), record(102), record(103)]), calls = [];
  const drain = createFailureReceiptDrainer({ db: transport, limit: 2,
    sendStatusNotice: async row => { calls.push(row.id); return { outcome: row.id < 103 ? 'failed' : 'sent' }; } });
  assert.equal((await drain()).settled, 2);
  assert.equal((await drain()).settled, 1);
  assert.deepEqual(calls, [101, 102, 103]);
  assert.equal(transport.pending.size, 0);
});
