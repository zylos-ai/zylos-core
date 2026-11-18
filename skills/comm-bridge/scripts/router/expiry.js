/** Failure is already committed; internal receipts are inserted by the store. */
export function createPendingExpiryHandler({ sendFailureAlert }) {
  return async function handleExpired(row) {
    sendFailureAlert(row, 'pending_expired');
  };
}
