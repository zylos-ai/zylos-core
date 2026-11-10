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
// The routing line a channel appends, raw or as stored after sanitizing: it and everything after it is not
// what the person said.
const REPLY_ROUTE = /\s*---- (?:\[reply-via sanitized\]|reply via):[\s\S]*$/;
// A message too long for the queue is stored as a pointer to a file; its preview would only show tags and paths.
const OVERFLOW_POINTER = '[C4] Full message';
// Core's scheduler opens each dispatched task with "[Scheduled Task: <task id> #<run>]" on its own line (older
// runs: "[Scheduled Task: <task id>] <words>" on one line) and appends its completion instruction.
const SCHEDULED_TASK = /^\[Scheduled Task: ([A-Za-z0-9_-]{1,80})(?: #\d+)?\][ \t]*/;
const SCHEDULER_DONE = /\s*---- After completing this task, run:[\s\S]*$/;
// Any other source's own header: bracketed tags at the very start of the message, optionally "(…)" after them.
const LEADING_TAGS = /^(?:\[[^\]\n]{1,80}\]\s*)+(?:\([^)\n]{0,80}\)\s*)?/;
// Core's own channels that store what a person typed as is (Dashboard chat, web console): a message there that
// starts with "[" is the person's words, not another source's header.
const DIRECT_CHANNELS = new Set(['dashboard', 'web-console']);
// Identifiers a reader cannot use: UUIDs, "task-…" ids with a digit, and runs of 16 or more hex digits.
// Any letter case; spelled out so the label below can stay case-sensitive.
const ID = String.raw`(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[Tt][Aa][Ss][Kk]-(?=[A-Za-z0-9-]*[0-9])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*|[0-9a-fA-F]{16,})`;
const LONG_ID = new RegExp(String.raw`\b${ID}\b`, 'g');
// An id's own label goes with it ("id: …", "Task ID: …", "id=…"; a capitalised word before "id" belongs to the label,
// a lower-case one is text), and so does a "(…)" holding only the id and one word ("(by …)", "(from …)").
const LABELLED_ID = new RegExp(String.raw`\b(?:[A-Z][A-Za-z]* )?(?:ID|Id|id)\s*[:=]\s*${ID}\b`, 'g');
const ID_GROUP = new RegExp(String.raw`\s*\((?:[A-Za-z]+ )?${ID}\)`, 'g');

const firstLine = text => text.split('\n').map(line => line.trim()).find(Boolean) ?? '';
// Removing an id leaves no empty "()", no comma before ")" or after "(", no repeated "·", and no "·" or "," at either end.
const withoutIds = text => text.replace(LABELLED_ID, '').replace(ID_GROUP, '').replace(LONG_ID, ' ')
  .replace(/\s*,\s*(?=\))/g, '').replace(/\(\s*,\s*/g, '(').replace(/\s*\(\s*\)/g, '')
  .replace(/·(?:\s*·)+/g, '·').replace(/^[\s·,]+|[\s·,]+$/g, '');

/**
 * What an inbound message says, for a one-line preview, never the model-facing projection.
 * `text`: the <current-message> body without its sender prefix; the words after an old one-line
 * "header sender said:"; a C4 envelope's fallback text; invalid content's own fallback text. A message from core's
 * scheduler gives the first line of its prompt; one that starts with another source's bracketed header gives its
 * first line without those tags. Neither keeps long identifiers (nor an id's label, nor a "(by …)" left empty).
 * On `channel` 'dashboard' or 'web-console', core's own channels that store a person's words as typed, a leading
 * "[…]" is the person's text and stays. The appended reply route is dropped. `text` is null
 * when there is nothing to read (wrapping only, invalid content without fallback text, an overflow pointer to a
 * stored file), so a reader shows channel and time. Whitespace is collapsed; longer text is cut to `limit` code
 * points ending in "…".
 * `source` says where text that is not a person's own words came from: `{kind: 'scheduled_task', taskId}` or
 * `{kind: 'header'}` (a header core does not know; a reader names the channel). It is absent otherwise.
 */
export function previewMessage(content, { limit = 80, channel } = {}) {
  if (typeof content !== 'string') return { text: null };
  const parsed = parseC4Content(content);
  let text, source;
  if (parsed.kind === 'envelope') text = parsed.envelope.fallbackText;
  else if (parsed.kind !== 'text') text = parsed.fallbackText;
  else {
    if (parsed.text.includes(OVERFLOW_POINTER)) return { text: null };
    // The block comes first: what the person wrote may itself quote a reply route, which then stays.
    const block = CURRENT_MESSAGE.exec(parsed.text);
    const task = block ? null : SCHEDULED_TASK.exec(parsed.text);
    if (block) text = block[1].replace(SENDER, '');
    else if (task) {
      source = { kind: 'scheduled_task', taskId: task[1] };
      text = withoutIds(firstLine(parsed.text.slice(task[0].length).replace(SCHEDULER_DONE, '').replace(REPLY_ROUTE, '')));
    } else {
      const body = parsed.text.replace(REPLY_ROUTE, '');
      if (HEADER_SENDER.test(body)) text = body.replace(HEADER_SENDER, '');
      else if (CHANNEL_HEADER.test(body.split('\n', 1)[0].trim())) return { text: null };
      else if (!DIRECT_CHANNELS.has(channel) && LEADING_TAGS.test(body)) {
        source = { kind: 'header' };
        text = withoutIds(firstLine(body.replace(LEADING_TAGS, '')));
      } else text = body;
    }
  }
  const result = source ? { text: cutPreview(text, limit), source } : { text: cutPreview(text, limit) };
  return result.text === null ? { text: null } : result;
}

/**
 * The start of a stored message for a technical view: up to `limit` code points, line breaks kept. A cut never
 * ends inside a run of printable ASCII characters, where a credential or link would be (that run is dropped, so a
 * credential is never half kept); other text, such as Chinese, is kept up to the limit. It ends in "…". Null when
 * there is no text.
 */
export function messageStart(text, { limit = 2000 } = {}) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const chars = [...text];
  if (chars.length <= limit) return text;
  let cut = chars.slice(0, limit).join('');
  if (/[!-~]/.test(chars[limit])) cut = cut.replace(/[!-~]+$/, '');
  return cut.trimEnd() + '…';
}

/** The text of {@link previewMessage}. */
export function previewMessageText(content, options) {
  return previewMessage(content, options).text;
}

function cutPreview(text, limit) {
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
