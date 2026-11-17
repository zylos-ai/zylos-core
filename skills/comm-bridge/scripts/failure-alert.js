import { messageForFailureAlert } from './failure-receipt-template.js';

/** Reuse durable receipt admission and the supervisor's owner-alert policy. */
export function createFailureAlertSender({ db, notifyOwner,
  now = () => Math.floor(Date.now() / 1000) }) {
  return async record => {
    const claim = db.reserveStatusNoticeCooldown({ receiptId: record.id,
      cooldownKey: 'delivery_failure:' + JSON.stringify([record.session_group, record.reason]),
      channel: 'dashboard', endpoint: 'origin', statusType: 'unavailable', reason: record.reason,
      ttl: 600, now: now() });
    if (claim.suppressed) return { outcome: 'suppressed' };
    // The shared supervisor returns true only when a target/Origin channel send
    // resolves without false. Both failed destinations or no boolean confirmation
    // leave the alert eligible for the durable queue's bounded retry policy.
    const confirmed = await notifyOwner(messageForFailureAlert(record));
    return { outcome: confirmed === true ? 'sent' : 'failed' };
  };
}
