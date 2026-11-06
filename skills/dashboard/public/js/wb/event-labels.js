export function timeValue(value) {
  if (typeof value === 'number') return value < 100000000000 ? value * 1000 : value;
  if (typeof value !== 'string') return NaN;
  return Date.parse(/Z$|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(' ', 'T') + 'Z');
}

// Event types with a plain-language label. Anything else falls back to its
// recorded category, then to a generic label; the raw code stays technical-only.
export const labelledEvents = new Set([
  'session_start', 'session_end', 'user_prompt_submit', 'pre_tool_use', 'post_tool_use', 'post_tool_failure',
  'permission_request', 'stop', 'idle', 'turn_complete', 'assistant_message', 'subagent_start', 'subagent_stop',
  'reclaim_done', 'crash_detected', 'rotate_done', 'manual_restart_done', 'restart_done', 'wait_health',
  'activate_new', 'start_always', 'activate_failed', 'activate_timeout',
]);
const categories = new Set(['session', 'turn', 'tool', 'permission', 'subagent', 'diagnostic', 'runtime_health']);

export function eventLabel(event, level = 'plain', t = key => key) {
  const type = event?.event_type;
  if (level === 'technical') return type ?? '';
  if (labelledEvents.has(type)) return t('wb.event.' + type);
  const category = String(type ?? '').startsWith('runtime_health:') ? 'runtime_health' : event?.category;
  return t(categories.has(category) ? 'wb.event.category.' + category : 'wb.event.other');
}

export const endReasons = new Set(['running', 'crash', 'rotate', 'manual_restart', 'reclaim', 'ttl', 'evict',
  'upgrade', 'auth', 'mode_switch', 'model_config', 'unexpected', 'unknown']);

export function endReasonLabel(reason, level = 'plain', t = key => key) {
  if (reason == null) return null;
  if (level === 'technical') return reason;
  return t('wb.endReason.' + (endReasons.has(reason) ? reason : 'ended'));
}

export function displayTime(value, level = 'plain', locale) {
  if (value == null) return null;
  if (level === 'technical') return String(value);
  const time = timeValue(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString(locale) : String(value);
}
