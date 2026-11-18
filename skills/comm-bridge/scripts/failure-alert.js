import { messageForFailureAlert } from './failure-receipt-template.js';

/** One best-effort owner alert after failure commits, using the existing cooldown. */
export function createFailureAlertSender({ db, notifyOwner,
  now = () => Math.floor(Date.now() / 1000) }) {
  return async record => {
    if (record.channel === 'internal' || record.delivery_action === 'failure_receipt') return;
    const claim = db.reserveStatusNoticeCooldown({
      cooldownKey: 'delivery_failure:' + JSON.stringify([record.session_group, record.reason]),
      channel: 'dashboard', endpoint: 'origin', statusType: 'unavailable', reason: record.reason,
      ttl: 600, now: now() });
    if (!claim.suppressed) await notifyOwner(messageForFailureAlert(record));
  };
}
