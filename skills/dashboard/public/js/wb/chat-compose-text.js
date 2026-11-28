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

// The fixed wording of both packs (wb.en.json, wb.zh.json chat.annotation.send*): a message is read back in whichever
// language it was sent, not the one the page shows now.
const SENT_INTROS = [count => `请看下面我标注的 ${count} 处内容，有批注的请逐条回应。`,
  count => `Please review the marked text below (${count} total) and respond to each comment.`];
const SENT_HEADINGS = [/^【标注 ([1-9][0-9]*) 条】原消息都在本对话里，c4_id 是消息编号。$/,
  /^\[Annotations: ([1-9][0-9]*)\] The original messages are in this conversation\. Use c4_id to identify each message\.$/];
const SENT_ITEM = /^([1-9][0-9]*)\. (AI|我|Me) · (.*) · c4_id=([1-9][0-9]{0,18})$/;
const SENT_ORIGINALS = [[/^原文(?:（前 [0-9]+ 字，全文 [0-9]+ 字，可按 c4_id 查）)?：「/, '」'],
  [/^Original(?: \(first [0-9]+ of [0-9]+ characters, full text available by c4_id\))?: “/, '”']];
const SENT_COMMENTS = ['批注：', 'Comment: '];

function sentItem(header, body) {
  if (!body.length) return null;
  for (const [pattern, close] of SENT_ORIGINALS) {
    const open = pattern.exec(body[0]);
    if (!open) continue;
    let end = body.length, comment = '';
    for (let i = 1; i < body.length; i++) {
      const prefix = SENT_COMMENTS.find(value => body[i].startsWith(value));
      if (prefix && body[i - 1].endsWith(close)) {
        end = i;
        comment = [body[i].slice(prefix.length), ...body.slice(i + 1)].join('\n').trimEnd();
        break;
      }
    }
    const quoted = [body[0].slice(open[0].length), ...body.slice(1, end)].join('\n').trimEnd();
    if (!quoted.endsWith(close)) return null;
    const excerpt = quoted.slice(0, -close.length);
    if (!excerpt) return null;
    return { author: header[2], stamp: header[3], messageId: header[4], excerpt, comment };
  }
  return null;
}

function sentItems(lines, count) {
  const items = [];
  let index = 0;
  while (index < lines.length) {
    const header = SENT_ITEM.exec(lines[index]);
    if (!header || Number(header[1]) !== items.length + 1) return null;
    // Everything an item holds is indented by three spaces (or blank), so the next unindented line starts the next item.
    const body = [];
    for (index++; index < lines.length; index++) {
      const line = lines[index];
      if (line === '') body.push('');
      else if (line.startsWith('   ')) body.push(line.slice(3));
      else break;
    }
    const item = sentItem(header, body);
    if (!item) return null;
    items.push(item);
  }
  return items.length === count ? items : null;
}

/**
 * A message composed by `composeContent` (or the App's identical composer), read back for display: `text` is the
 * owner's own words (null for the default request sentence), `items` hold `{ author, stamp, messageId, excerpt,
 * comment }`. Null unless the text is exactly that format; the caller then shows the text as it is.
 */
export function parseSentAnnotations(content) {
  const lines = String(content ?? '').split('\n');
  for (let h = 2; h < lines.length; h++) {
    if (lines[h - 1] !== '') continue;
    const heading = SENT_HEADINGS.map(pattern => pattern.exec(lines[h])).find(Boolean);
    if (!heading) continue;
    const items = sentItems(lines.slice(h + 1), Number(heading[1]));
    if (!items) continue;
    const own = lines.slice(0, h - 1).join('\n');
    if (!own.trim()) return null;
    return { text: SENT_INTROS.some(intro => intro(items.length) === own) ? null : own, items };
  }
  return null;
}

/** What the server stores: the quote's first line, then the browser's content (attachment annotations come after). */
export function storedContent(content, quoteId) {
  return (quoteId ? `[quote c4_id=${quoteId}]\n` : '') + String(content ?? '');
}
