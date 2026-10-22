import { createHash } from 'node:crypto';
import { sanitizeHealthQuota } from './health-quota.js';
import { classifyHealthNotice, sanitizeNoticeMatch } from './health-notice-classification.js';

export const HOOK_ERRORS = new Set(['rate_limit', 'authentication_failed', 'billing_error', 'overloaded', 'server_error', 'model_not_found']);
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
export const HEALTH_EVENT_MAX_AGE_MS = 300000;
export const QUOTA_MAX_AGE_MS = 60000;

export function sanitizeHealthEvent(raw, fallbackId) {
  if (!raw || raw.schema_version !== 1 || raw.source !== 'hook' || raw.runtime !== 'claude' || !uuid(raw.event_id) || !id(raw.session_id) || (raw.prompt_id !== null && !id(raw.prompt_id)) || !['session_start','prompt_submit','stop_failure','stop'].includes(raw.event) || !Number.isSafeInteger(raw.received_at) || !Number.isSafeInteger(raw.claude_pid) || raw.claude_pid <= 0 || (raw.event === 'stop_failure' && !id(raw.error))) {
    return { event_id: `invalid:${createHash('sha256').update(String(fallbackId)).digest('hex')}`, source: 'invalid', received_at: 0 };
  }
  const event = Object.fromEntries(['schema_version','event_id','source','runtime','session_id','prompt_id','event','received_at','claude_pid'].map(key => [key,raw[key]]));
  event.error = raw.event === 'stop_failure' ? (HOOK_ERRORS.has(raw.error) ? raw.error : 'unknown') : null;
  if (event.event === 'stop_failure') {
    const match = sanitizeNoticeMatch(raw.notice_match);
    if (match) event.notice_match = match;
    const quota = sanitizeHealthQuota(raw.quota, { identity:event, nowMs:event.received_at });
    if (quota) event.quota = quota;
  }
  return event;
}

export function quotaClassification(snapshot, event, now, maxAgeMs = QUOTA_MAX_AGE_MS) {
  if (!snapshot || snapshot.claude_pid !== event.claude_pid || snapshot.session_id !== event.session_id || !Number.isSafeInteger(snapshot.observed_at) || now-snapshot.observed_at < 0 || now-snapshot.observed_at > maxAgeMs) return 'rate_limit_unclassified';
  const full = window => window && typeof window.used_percentage === 'number' && Number.isFinite(window.used_percentage) && window.used_percentage >= 0 && window.used_percentage <= 100 && window.used_percentage === 100;
  if (full(snapshot.rate_limits?.seven_day)) return 'rate_limit_seven_day';
  if (full(snapshot.rate_limits?.five_hour)) return 'rate_limit_five_hour';
  return 'rate_limit_unclassified';
}

export function initialHealthEvidence(health = 'ok', reason = '') {
  return { version: 1, revision: 0, health, reason: safeHealthReason(health,reason), session_id: null, source: 'legacy', episode: 0, evidence_id: null, hook_prompt: null, recovered: null };
}

export function safeHealthReason(health, reason) {
  const allowed = new Set(['rate_limit_unclassified','rate_limit_five_hour','rate_limit_seven_day','authentication_failed','billing_error','overloaded','server_error','model_not_found','hook_evidence_unordered','health_storage_unavailable']);
  if (allowed.has(reason)) return reason;
  if (health === 'ok') return '';
  if (health === 'rate_limited') return 'rate_limit_unclassified';
  if (health === 'auth_failed') return 'authentication_failed';
  return 'runtime_unavailable';
}

export function reduceHealthEvidence(state, event, { identity, now, quota = null, maxAgeMs = HEALTH_EVENT_MAX_AGE_MS } = {}) {
  const ignored = reason => ({ state, status: 'ignored', reason });
  if (event.source === 'invalid') return ignored('invalid_event');
  if (!identity || !identity.session_id || !Number.isSafeInteger(identity.claude_pid) || identity.claude_pid<=0 || identity.runtime !== 'claude') return ignored('missing_runtime_proof');
  if (event.session_id !== identity.session_id || event.claude_pid !== identity.claude_pid) return ignored('foreign_runtime_or_session');
  if (now-event.received_at < 0 || now-event.received_at > maxAgeMs) return ignored('stale_event');
  let next = state;
  if (state.hook_pid !== identity.claude_pid || state.session_id !== identity.session_id) {
    next = { ...state, session_id: identity.session_id, hook_pid:identity.claude_pid, hook_prompt: null, recovered: null, source: 'legacy' };
  }
  // Terminal hooks are synchronous. The durable terminal marker rejects
  // replays; recovery's timestamp additionally excludes already-written events
  // that were still waiting in the stream when recovery completed.
  if (next.recovered && event.received_at <= (next.recovered.observed_at ?? next.last_processed?.received_at ?? 0)) return ignored('pre_recovery_event');
  if (event.event === 'stop') {
    // Stop proves a completed response, not ordering against an existing outage.
    // It establishes authority while already OK, but never clears a failure.
    if (next.health !== 'ok' || !event.prompt_id) return {state:next,status:'processed',reason:'unproven_success_order'};
    return {state:{...next,source:'hook',evidence_id:event.event_id,hook_ok:true,hook_prompt:null,hook_pid:event.claude_pid},status:'processed',reason:'hook_ok'};
  }
  if (event.event !== 'stop_failure') return { state: next, status: 'processed', reason: 'identity_observed' };
  if (!event.prompt_id) return { state: next, status: 'processed', reason: 'missing_prompt', verify: true };
  next = {...next,recovered:null};
  const notice = classifyHealthNotice(event, now);
  const classification = notice.eligible ? notice.reason : event.error;
  const health = event.error === 'rate_limit' ? 'rate_limited' : event.error === 'authentication_failed' ? 'auth_failed' : null;
  if (!health) return { state: next, status: 'processed', notice, reason: classification === 'unknown' ? 'unmapped_error' : classification };
  return { state: { ...next, health, reason: classification, notice, source: 'hook', hook_ok:false, hook_pid:event.claude_pid, hook_prompt: event.prompt_id, evidence_id: event.event_id,
    hook_failure:{event_id:event.event_id,error:event.error,observed_at:event.received_at},
    episode: next.health === 'ok' ? next.episode+1 : next.episode }, status: 'processed', notice, reason: 'hook_failure' };
}
