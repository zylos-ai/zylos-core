/** The store commits expiry and its receipt together. Use the same bounded
 * durable drain as startup/activation failures instead of a separate sender. */
export function createPendingExpiryHandler({ drainFailureReceipts }) {
  return async function handleExpired() {
    return drainFailureReceipts();
  };
}
