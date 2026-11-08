/** Authoritative C4 row states; operation actions never override a row. */
export function messageState(row) {
  if (!row) return 'pending_reconciliation';
  if (row.direction === 'out') return row.status === 'delivered' ? 'stored' : 'pending_reconciliation';
  if (['pending', 'running', 'delivered', 'switch_absorbed'].includes(row.status)) return row.status;
  if (row.status === 'failed') return ['auth_rejected', 'suppressed'].includes(row.delivery_action) ? row.delivery_action : 'failed';
  return 'pending_reconciliation';
}
export function receiptState(receipt) {
  if (!receipt || receipt.stored === null) return 'pending_reconciliation';
  if (receipt.stored === false) return receipt.preserveInput || receipt.error || receipt.deliveryState ? 'not_stored' : null;
  return ['pending', 'running', 'delivered', 'stored', 'auth_rejected', 'suppressed', 'failed', 'switch_absorbed'].includes(receipt.deliveryState)
    ? receipt.deliveryState : 'stored_pending_reconciliation';
}
