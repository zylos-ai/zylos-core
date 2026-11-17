/** External admitted receipts remain retryable until success is confirmed.
 * Cooldown suppresses other messages; durable admission lets this same receipt
 * resume after a crash. Internal receipt creation remains atomic in the store.
 */
export function createFailureReceiptDrainer({ db, sendStatusNotice, limit = 20 }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid receipt drain limit');
  let running = null;
  async function drain() {
    const result = { attempted: 0, settled: 0, pending: 0 };
    for (const row of db.listFailureReceipts({ limit })) {
      result.attempted++;
      const receipt = await sendStatusNotice(row, { noticeKind: 'failure_receipt', health: 'unavailable',
        reason: row.reason, runtime: 'unknown' });
      const outcome = ['sent', 'suppressed', 'uncertain', 'failed'].includes(receipt.outcome) ? receipt.outcome : 'failed';
      db.settleFailureReceipt(row.id, outcome);
      if (outcome === 'sent' || outcome === 'suppressed') result.settled++;
      else result.pending++;
    }
    return result;
  }
  return function drainFailureReceipts() {
    if (!running) {
      running = drain().finally(() => { running = null; });
    }
    return running;
  };
}
