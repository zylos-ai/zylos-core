import { sanitizeHealthQuota } from './health-quota.js';

const KINDS = new Set(['model_quota','credits_required','credits_exhausted','quota','allocation','temporary','warning','excluded']);
export function sanitizeNoticeMatch(value) {
  return value && Number.isInteger(value.sourceId) && value.sourceId >= 0 && value.sourceId <= 33 && KINDS.has(value.kind)
    ? { sourceId: value.sourceId, kind: value.kind } : null;
}

// Text can refine a structured quota failure, never create one from user prose.
export function classifyHealthNotice(event, now = Date.now()) {
  const match = sanitizeNoticeMatch(event.notice_match);
  const quotaError = ['rate_limit', 'billing_error'].includes(event.error);
  const factualCodes = { authentication_failed:'auth_failed', rate_limit:'rate_limited', model_not_found:'model_unavailable', billing_error:'billing_error', overloaded:'service_error', server_error:'service_error' };
  const fallback = { noticeCode: factualCodes[event.error] || 'unavailable', resetAt: null, sourceId: match?.sourceId ?? null, eligible: true, reason:event.error === 'rate_limit' ? 'rate_limit_unclassified' : event.error };
  if (!quotaError) return fallback;
  // A snapshot is frozen at collection. Later status updates cannot change the
  // meaning of an older failure; resets must still be future at consumption.
  const snapshot = sanitizeHealthQuota(event.quota, { identity: event, nowMs: event.received_at });
  const full = ['five_hour','seven_day'].filter(name => {
    const window = snapshot?.rate_limits[name];
    return window?.used_percentage === 100 && (window.resets_at === undefined || window.resets_at * 1000 > now);
  });
  if (full.length) {
    const resets = full.map(name => snapshot.rate_limits[name].resets_at);
    const resetAt = resets.every(Number.isSafeInteger) ? Math.max(...resets) * 1000 : null;
    return { ...fallback, eligible: true, noticeCode: resetAt ? 'quota_exhausted_reset' : 'quota_exhausted', resetAt,
      reason: full.includes('seven_day') ? 'rate_limit_seven_day' : 'rate_limit_five_hour' };
  }
  if (match && ['warning','temporary','excluded'].includes(match.kind)) return fallback;
  const codes = { model_quota:'model_quota_exhausted', credits_required:'usage_credits_required', credits_exhausted:'usage_credits_exhausted', quota:'quota_exhausted', allocation:'quota_allocation_unavailable' };
  if (match && codes[match.kind]) return { ...fallback, eligible:true, noticeCode:codes[match.kind], reason:'rate_limit_unclassified' };
  // Unknown billing errors do not establish exhausted subscription credits.
  return fallback;
}
