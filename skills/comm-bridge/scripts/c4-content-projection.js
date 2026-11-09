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

// A channel wraps the person's words in a <current-message> block, after its own routing header and context
// tags, and starts them with "<sender> said: ". Older channels put "<sender> said: " before the opening tag on
// the same line. The block must open a line (optionally after that prefix): a tag quoted mid-sentence is text.
const CURRENT_MESSAGE = /(?:^|\n)(?:[^\n<]{1,200} said: )?<current-message>\n?([\s\S]*?)\n?<\/current-message>(?=\s|$)/;
const SENDER = /^[^\n:]{1,80} said: /;
// A first line made only of bracketed routing tags (with an optional "(org: …)") is a channel header.
const CHANNEL_HEADER = /^(?:\[[^\]\n]{1,80}\]\s*)+(?:\([^)\n]{0,80}\)\s*)?$/;
// Older channels put the header and "<sender> said: " on one line, followed by the words.
const HEADER_SENDER = /^(?:\[[^\]\n]{1,80}\]\s*)+(?:\([^)\n]{0,80}\)\s*)?[^\n:[\]]{1,80} said: /;

/**
 * What the person said in an inbound message, for a one-line preview, never the model-facing projection:
 * the <current-message> body without its sender prefix; the words after an old one-line "header sender said:";
 * a C4 envelope's fallback text; invalid content's own fallback text. Null when there is nothing a person
 * wrote (channel wrapping only, invalid content without fallback text), so a reader shows channel and time.
 * Whitespace is collapsed; longer text is cut to `limit` code points ending in "…".
 */
export function previewMessageText(content, { limit = 80 } = {}) {
  if (typeof content !== 'string') return null;
  const parsed = parseC4Content(content);
  let text;
  if (parsed.kind === 'envelope') text = parsed.envelope.fallbackText;
  else if (parsed.kind !== 'text') text = parsed.fallbackText;
  else {
    const block = CURRENT_MESSAGE.exec(parsed.text);
    if (block) text = block[1].replace(SENDER, '');
    else if (HEADER_SENDER.test(parsed.text)) text = parsed.text.replace(HEADER_SENDER, '');
    else if (CHANNEL_HEADER.test(parsed.text.split('\n', 1)[0].trim())) return null;
    else text = parsed.text;
  }
  if (typeof text !== 'string') return null;
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
