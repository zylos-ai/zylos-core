import { parseC4Content } from '../../chat-schema.js';
import { asDate } from './conversation-time.js';

/** Limits of one message: one quote, 20 annotations, 4000 characters per excerpt or comment, 65536 UTF-8 bytes. */
export const MAX_ANNOTATIONS = 20;
export const MAX_CHARS = 4000;
export const MAX_CONTENT_BYTES = 65536;
const PREVIEW_CHARS = 160;
// The Dashboard server writes this first line into the stored content when a message is sent with `quote`.
const QUOTE_MARKER = /^\[quote c4_id=([1-9][0-9]{0,18})\](?:\r?\n|$)/;
const ATTACHMENT_LINE = /^\[attachment:(?:image|file) .+ name="(?:\\.|[^"\\])*" [^\]]+\]\r?$/;

export const chars = value => Array.from(String(value ?? '')).length;
export const contentBytes = value => new TextEncoder().encode(String(value ?? '')).byteLength;
const firstChars = (value, count) => Array.from(String(value ?? '')).slice(0, count).join('');

/** The quoted message id of a stored first line, and the content after it. */
export function splitQuoteMarker(content) {
  const text = String(content ?? '');
  const match = QUOTE_MARKER.exec(text);
  return match ? { quoteId: match[1], body: text.slice(match[0].length) } : { quoteId: null, body: text };
}

/** A history row as the page shows it: the quote marker line is replaced by the row's quote block. */
export function displayRow(row) {
  const quote = row?.quote;
  if (!quote || typeof row.content !== 'string') return row;
  const { quoteId, body } = splitQuoteMarker(row.content);
  return quoteId !== null && quoteId === String(quote.id) ? { ...row, content: body } : row;
}

/**
 * A message's readable text: without the quote marker and attachment annotation lines, with each attachment's name
 * after it; a structured message reads as its fallback text, an internal row as its relayed text.
 */
export function readableText(row) {
  if (row?.channel === 'internal') return String(typeof row.internal?.content === 'string' ? row.internal.content : row.content ?? '').trim();
  const parsed = parseC4Content(String(row?.content ?? ''));
  const source = parsed.kind === 'text' ? splitQuoteMarker(parsed.text).body
    : parsed.kind === 'envelope' ? parsed.envelope.fallbackText ?? '' : parsed.fallbackText ?? '';
  let text = String(source).split('\n').filter(line => !ATTACHMENT_LINE.test(line)).join('\n').trim();
  for (const attachment of Array.isArray(row?.attachments) ? row.attachments.slice(0, 20) : []) {
    if (attachment?.name) text += `\n（附件：${attachment.name}）`;
  }
  return text.trim();
}

/** The opening of a readable text on one line, for the quote bar. */
export function previewLine(text, count = PREVIEW_CHARS) {
  return firstChars(String(text ?? '').replace(/\s*\n\s*/g, ' ').trim(), count);
}

function zoned(date, timeZone) {
  try {
    return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(part => [part.type, part.value]));
  } catch {
    return zoned(date, 'UTC');
  }
}

/** `HH:mm` today, otherwise `MM-DD HH:mm`, in the instance time zone (quote bar and quote block). */
export function shortStamp(value, timeZone, now = new Date()) {
  const date = asDate(value);
  if (!date) return '';
  const at = zoned(date, timeZone), today = zoned(now, timeZone);
  const sameDay = at.year === today.year && at.month === today.month && at.day === today.day;
  return sameDay ? `${at.hour}:${at.minute}` : `${at.month}-${at.day} ${at.hour}:${at.minute}`;
}

/** `MM-DD HH:mm`, with the year in front when it is not this year, in the instance time zone (annotation lines). */
export function annotationStamp(value, timeZone, now = new Date()) {
  const date = asDate(value);
  if (!date) return '';
  const at = zoned(date, timeZone), current = zoned(now, timeZone);
  return `${at.year === current.year ? '' : at.year + '-'}${at.month}-${at.day} ${at.hour}:${at.minute}`;
}

// Lines after the first start with 3 spaces, so no excerpt or comment line can start an attachment annotation.
const indent = value => String(value).split('\n').map((line, index) => index === 0 ? line : line.trim() ? '   ' + line : '').join('\n');

// The English pack's wording, used when the workbench pack has not loaded: the user's excerpts and comments must
// still go out in full rather than vanish with an untranslated template.
const FALLBACK = {
  'chat.annotation.sendIntro': 'Please review the marked text below ({count} total) and respond to each comment.',
  'chat.annotation.sendHeading': '[Annotations: {count}] The original messages are in this conversation. Use c4_id to identify each message.',
  'chat.annotation.sendMe': 'Me',
  'chat.page.ai': 'AI',
  'chat.annotation.sendOriginal': 'Original: “{excerpt}”',
  'chat.annotation.sendOriginalTruncated': 'Original (first {limit} of {length} characters, full text available by c4_id): “{excerpt}”',
  'chat.annotation.sendComment': 'Comment: {comment}'
};

/**
 * The `content` the browser sends: the user's own words (trimmed) first, then the numbered annotations.
 * An annotation is `{ messageId, direction, timestamp, excerpt, length, comment }`; `excerpt` holds at most
 * MAX_CHARS characters and `length` the selected text's full length.
 */
export function composeContent({ text = '', annotations = [], timeZone = null, now = new Date(), t: translate } = {}) {
  const t = (key, params = {}) => {
    const value = translate(key, params);
    if (value !== key) return value;
    let fallback = FALLBACK[key];
    for (const [name, param] of Object.entries(params)) fallback = fallback.replaceAll(`{${name}}`, param ?? '');
    return fallback;
  };
  const count = annotations.length;
  // Without annotations the user's text is sent as typed, as before; the server compares a retry's content exactly.
  if (!count) return String(text ?? '');
  const own = String(text ?? '').trim();
  const lines = [own || t('chat.annotation.sendIntro', { count }), '', t('chat.annotation.sendHeading', { count })];
  annotations.forEach((item, index) => {
    const author = t(item.direction === 'in' ? 'chat.annotation.sendMe' : 'chat.page.ai');
    lines.push(`${index + 1}. ${author} · ${annotationStamp(item.timestamp, timeZone, now)} · c4_id=${item.messageId}`);
    const length = Math.max(chars(item.excerpt), Number(item.length) || 0), cut = length > MAX_CHARS;
    const original = cut ? t('chat.annotation.sendOriginalTruncated', { limit: MAX_CHARS, length }) : t('chat.annotation.sendOriginal');
    // Insert user text literally after translation so replacement patterns such as $& stay intact.
    lines.push(`   ${original.replace('{excerpt}', () => indent(firstChars(item.excerpt, MAX_CHARS)))}`);
    if (item.comment) lines.push(`   ${t('chat.annotation.sendComment').replace('{comment}', () => indent(item.comment))}`);
  });
  return lines.join('\n');
}

/** What the server stores: the quote's first line, then the browser's content (attachment annotations come after). */
export function storedContent(content, quoteId) {
  return (quoteId ? `[quote c4_id=${quoteId}]\n` : '') + String(content ?? '');
}
