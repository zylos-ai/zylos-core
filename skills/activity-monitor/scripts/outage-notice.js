import { sanitizeHealthQuota } from './health-quota.js';
import { classifyHealthNotice } from './health-notice-classification.js';

// Older state blobs did not persist an authoritative timestamp. The current
// evidence row is retention-protected; telemetry last_hook is never a fallback.
export function restoreOutageAnchor(state, database) {
  if (state.hook_failure?.event_id === state.evidence_id || state.health !== 'rate_limited' || state.source !== 'hook') return state;
  const row = database.prepare("SELECT payload_json FROM runtime_health_events WHERE event_id=? AND status='processed'").get(state.evidence_id);
  if (!row) return state;
  let event;
  try { event = JSON.parse(row.payload_json); } catch { return state; }
  if (event.event_id !== state.evidence_id || event.event !== 'stop_failure' || event.error !== 'rate_limit' ||
      event.source !== 'hook' || event.runtime !== 'claude' || event.runtime_generation !== state.runtime_generation ||
      event.session_id !== state.session_id || event.claude_pid !== state.hook_pid || event.process_start !== state.hook_process_start ||
      !Number.isSafeInteger(event.received_at)) return state;
  return {...state,hook_failure:{event_id:event.event_id,error:event.error,observed_at:event.received_at}};
}

// This is current-outage evidence, not a retroactive change to the Hook payload.
export function currentOutageNotice(state, identity, quota, now = Date.now()) {
  const fallback = { notice: state.notice, annotation: null };
  if (state.health !== 'rate_limited' || state.source !== 'hook' || state.recovered ||
      identity?.runtime !== 'claude' || state.runtime_generation !== identity.runtime_generation ||
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
