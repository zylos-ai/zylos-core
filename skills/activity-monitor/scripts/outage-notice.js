import { sanitizeHealthQuota } from './health-quota.js';
import { classifyHealthNotice } from './health-notice-classification.js';

// This is current-outage evidence, not a retroactive change to the Hook payload.
export function currentOutageNotice(state, identity, quota, now = Date.now()) {
  const fallback = { notice: state.notice, annotation: null };
  if (state.health !== 'rate_limited' || state.source !== 'hook' || state.recovered ||
      identity?.runtime !== 'claude' ||
      state.session_id !== identity.session_id || state.hook_pid !== identity.claude_pid ||
      state.hook_process_start !== identity.process_start ||
      state.hook_failure?.event_id !== state.evidence_id || state.hook_failure.error !== 'rate_limit') return fallback;
  const observed = state.hook_failure.observed_at;
  if (!Number.isSafeInteger(observed) || observed > now) return fallback;
  let annotation = state.outage_quota?.evidence_id === state.evidence_id ? state.outage_quota : null;
  const fresh = sanitizeHealthQuota(quota, { identity, nowMs: now });
  if (fresh && fresh.observed_at >= observed && (!annotation || fresh.observed_at > annotation.snapshot.observed_at)) {
    annotation = { evidence_id: state.evidence_id, snapshot: fresh };
  }
  if (!annotation) return fallback;
  const snapshot = sanitizeHealthQuota(annotation.snapshot, { identity, nowMs: annotation.snapshot.observed_at });
  if (!snapshot || snapshot.observed_at < observed || snapshot.observed_at > now) return fallback;
  const notice = classifyHealthNotice({ ...identity, received_at: snapshot.observed_at,
    error: 'rate_limit', quota: snapshot }, now);
  // A non-full or expired snapshot cannot supply a reset. Preserve the original
  // text classification instead of inferring recovery or a different failure.
  return { annotation, notice: notice.reason === 'rate_limit_unclassified' ? state.notice : notice };
}
