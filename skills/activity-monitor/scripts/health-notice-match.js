export const HEALTH_NOTICE_TEXT_MAX_BYTES = 16 * 1024;

export function matchHealthNoticeText(payload, rules) {
  if (!Array.isArray(rules) || !payload || typeof payload !== 'object') return null;
  // Prefer the error field over assistant prose; an unknown error must not be
  // replaced by an unrelated example quoted in an otherwise successful reply.
  const text = typeof payload.error_details === 'string' && payload.error_details.trim()
    ? payload.error_details : payload.last_assistant_message;
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > HEALTH_NOTICE_TEXT_MAX_BYTES) return null;
  const normalized = text.replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/^api error: (?:\d{3} )?/, '');
  for (const {sourceId, kind, pattern} of rules) {
    if (pattern.test(normalized)) return {sourceId,kind};
  }
  return null;
}
