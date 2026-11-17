import { messageForScheduledFailureAlert } from './failure-receipt-template.js';

/** Reuse durable receipt admission and the supervisor's owner-alert policy. */
export function createScheduledFailureAlertSender({ db, notifyOwner,
  now = () => Math.floor(Date.now() / 1000) }) {
  return async record => {
    const claim = db.reserveStatusNoticeCooldown({ receiptId: record.id,
      cooldownKey: 'scheduler_failure:' + JSON.stringify([record.session_group, record.reason]),
      channel: 'dashboard', endpoint: 'origin', statusType: 'unavailable', reason: record.reason,
      ttl: 600, now: now() });
    if (claim.suppressed) return { outcome: 'suppressed' };
    // notify preserves the supervisor's existing best-effort contract: it
    // attempts owner/Origin fallback, without transport-success readback.
    await notifyOwner(messageForScheduledFailureAlert(record));
    return { outcome: 'sent' };
  };
}
