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

// A channel wraps the person's words in a line-anchored <current-message> block, after its own routing
// header and context tags, and starts them with "<sender> said: ".
const CURRENT_MESSAGE = /(?:^|\n)<current-message>\n([\s\S]*?)\n<\/current-message>(?=\s|$)/;
const SENDER = /^[^\n:]{1,80} said: /;
// A first line made only of bracketed routing tags (with an optional "(org: …)") is a channel header.
const CHANNEL_HEADER = /^(?:\[[^\]\n]{1,80}\]\s*)+(?:\([^)\n]{0,80}\)\s*)?$/;

/**
 * What the person said in an inbound message, for a one-line preview: the <current-message> body without
 * its sender prefix, or the projected text of a message that carries no channel wrapping. Null when the
 * content is channel wrapping without a current message, so a reader shows the channel and time instead.
 * Whitespace is collapsed; longer text is cut to `limit` code points ending in "…".
 */
export function previewMessageText(content, { c4Id, limit = 80 } = {}) {
  if (typeof content !== 'string') return null;
  const block = CURRENT_MESSAGE.exec(content);
  let text;
  if (block) text = block[1].replace(SENDER, '');
  else {
    text = projectC4Content(content, { c4Id });
    if (CHANNEL_HEADER.test(text.split('\n', 1)[0].trim())) return null;
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const chars = [...text];
  if (chars.length <= limit) return text;
  let cut = chars.slice(0, limit - 1).join('');
  // Inside a Latin word, end at the last space instead, unless that drops most of the line.
  const space = cut.lastIndexOf(' ');
  if (/\w/.test(chars[limit - 1]) && /\w$/.test(cut) && space >= cut.length - 20) cut = cut.slice(0, space);
  return cut.trimEnd() + '…';
}
