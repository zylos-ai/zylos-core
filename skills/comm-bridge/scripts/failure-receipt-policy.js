// Persisted timestamps bound retry work across dispatcher restarts.
export const FAILURE_RECEIPT_RETRY_SECONDS = 30;
export const FAILURE_RECEIPT_LIFETIME_SECONDS = 600;

// Scheduler transport failures outside startup/readiness/queue expiry retain
// the ordinary receipt behavior. Historical rows have no scheduler provenance.
export function isScheduledFailureAlert(record) {
  return record.core_source === 'scheduler' &&
    ['launch_failed', 'ready_timeout', 'pending_expired', 'orphan_expired'].includes(record.reason);
}
