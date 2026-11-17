/** Drain the durable external receipt queue through the existing status sender.
 * Each completed attempt is terminal, including a failure before spawn. This
 * queue does not retry failed receipts or generate a receipt for a receipt.
 * Channel transports do not offer a shared idempotency key.
 * Cooldown remains the shared status sender's six-tuple, including its 600s TTL.
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
      if (db.settleFailureReceipt(row.id, outcome)) result.settled++;
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
