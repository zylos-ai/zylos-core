import { parseC4Content } from './c4-content-schema.js';

function c4Reference(c4Id) {
  const value = typeof c4Id === 'number' && Number.isSafeInteger(c4Id) ? String(c4Id) : c4Id;
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)
    && (value.length < 19 || value <= '9223372036854775807') ? value : 'unavailable';
}

/**
 * Model-facing text only. Pass the authoritative row ID as c4Id when available.
 * Apply caller budgets to the returned text, never to the serialized content.
 * Does not read storage, load components, or mutate the original content.
 */
export function projectC4Content(content, { c4Id } = {}) {
  const parsed = parseC4Content(content);
  if (parsed.kind === 'text') return parsed.text;
  const reference = `c4_id=${c4Reference(c4Id)}`;
  if (parsed.kind !== 'envelope') return `${parsed.fallbackText === undefined ? '' : parsed.fallbackText + '\n'}[C4 content invalid; ${reference}]`;
  const { fallbackText, messageId, interruptId } = parsed.envelope;
  const interrupt = interruptId === undefined ? '' : ` interruptId=${interruptId}`;
  return `${fallbackText}\n[C4 messageId=${messageId}${interrupt}; ${reference}]`;
}
