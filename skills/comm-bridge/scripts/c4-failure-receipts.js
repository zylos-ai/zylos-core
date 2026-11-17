import { FAILURE_RECEIPT_LIFETIME_SECONDS } from './failure-receipt-policy.js';

/** Durable admission survives crashes; elapsed lifetime and backoff bound sends.
 * Internal receipt creation remains atomic in the store and is never drained.
 */
export function createFailureReceiptDrainer({ db, sendStatusNotice, limit = 20,
  now = () => Math.floor(Date.now() / 1000), diagnostic = () => {} }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid receipt drain limit');
  let running = null;
  const emit = (event, row, outcome) => {
    try { diagnostic(event, { conversation_id: row.id, session_group: row.session_group,
      channel: row.channel, cause: row.reason, outcome,
      age_seconds: Math.max(0, now() - row.created_at),
      lifetime_seconds: FAILURE_RECEIPT_LIFETIME_SECONDS }); } catch {}
  };
  const expire = row => {
    if (!db.settleFailureReceipt(row.id, 'expired')) return false;
    emit('failure_receipt_exhausted', row, 'failed');
    return true;
  };
  async function drain() {
    const result = { attempted: 0, settled: 0, pending: 0 };
    for (const row of db.listFailureReceipts({ limit })) {
      if (now() - row.created_at >= FAILURE_RECEIPT_LIFETIME_SECONDS) {
        if (expire(row)) result.settled++;
        continue;
      }
      result.attempted++;
      let receipt;
      try {
        receipt = await sendStatusNotice(row, { noticeKind: 'failure_receipt', health: 'unavailable',
          reason: row.reason, runtime: 'unknown' });
      } catch { receipt = { outcome: 'failed' }; }
      const outcome = ['sent', 'suppressed', 'uncertain', 'failed'].includes(receipt?.outcome) ? receipt.outcome : 'failed';
      if (outcome === 'sent' || outcome === 'suppressed') {
        if (db.settleFailureReceipt(row.id, outcome)) result.settled++;
      } else {
        emit('failure_receipt_send_failed', row, outcome);
        if (now() - row.created_at >= FAILURE_RECEIPT_LIFETIME_SECONDS) {
          if (expire(row)) result.settled++;
        } else { db.settleFailureReceipt(row.id, outcome); result.pending++; }
      }
    }
    return result;
  }
  return function drainFailureReceipts() {
    if (!running) running = drain().finally(() => { running = null; });
    return running;
  };
}
