import { Sanitizer } from '../sanitizer.js';

export function c4Meta(item) {
  return item ? { componentName: item.componentName, sessionGroupName: item.sessionGroupName,
    lastActivityAt: item.lastActivityAt ?? null } : null;
}

// The page shows what the person said (`message`); null when the channel wrapping carries no current message,
// so the page names the channel and time instead of protocol text. Older stores without `message` keep `text`.
// A message that is not a person's own words carries where it came from: `source.kind` 'scheduled_task' (its text
// is the task's name when the scheduler still has it) or 'channel' (another source's header; the page names the
// channel). The task id is not sent. The stored message itself is read per group, on request (`safeRaw`).
export function safePreview(item, sanitizer = new Sanitizer(''), taskNames = new Map()) {
  if (!item?.preview) return null;
  const { message, messageSource, ...preview } = item.preview;
  const safe = value => value == null ? null : sanitizer.safeSummary(redactQuerySecrets(value));
  let text = message === undefined ? preview.text : message, source = null;
  if (messageSource?.kind === 'scheduled_task') {
    source = { kind: 'scheduled_task' };
    text = taskNames.get(messageSource.taskId) ?? text;
  } else if (messageSource?.kind === 'header') source = { kind: 'channel' };
  return { ...preview, text: safe(text), ...(source ? { source } : {}) };
}

/**
 * A group's stored message start (C4 `messageRaw`, up to 2000 characters) for the technical view: credentials and
 * link credentials redacted over the whole text, line breaks kept, nothing cut. Null without one.
 */
export function safeRaw(messageRaw, sanitizer = new Sanitizer('')) {
  return typeof messageRaw === 'string' ? sanitizer.redactCredentials(redactQuerySecrets(messageRaw)) : null;
}

/** Ids of the scheduler tasks that sent the groups' latest messages. */
export function previewTaskIds(items) {
  return items.map(item => item?.preview?.messageSource).filter(source => source?.kind === 'scheduled_task').map(source => source.taskId);
}

// People paste links that carry credentials in the query string (?token=…, &api_key=…, &accessToken=…). The
// preview keeps the link readable and drops only those values. Only a URL query parameter counts (after "?", "&"
// or an HTML-escaped "&amp;"). Its name is split into words at "_", "-", "." and a lower-to-upper case change;
// one of those words must be a credential word, so monkey= or hotkey= stay. The value ends at whitespace, "&",
// "#" or any non-ASCII character, so the words after a link stay. Another parameter's value is searched too, so a
// link nested in it (?redirect=https://y/?token=…) loses its credential as well.
const QUERY_PARAM = /(\?|&amp;|&)([A-Za-z0-9_.-]+)=([!"$%'-~]+)/g;
const SECRET_WORDS = new Set(['token', 'key', 'apikey', 'secret', 'password', 'passwd', 'signature', 'sig', 'auth']);
const secretName = name => name.split(/[_.-]|(?<=[a-z0-9])(?=[A-Z])/).some(word => SECRET_WORDS.has(word.toLowerCase()));
export function redactQuerySecrets(text) {
  return text.replace(QUERY_PARAM, (whole, start, name, value) => `${start}${name}=${secretName(name) ? '[REDACTED]' : redactQuerySecrets(value)}`);
}

export function mergeGroups({ status, c4, q, names = new Map(), taskNames = new Map(), statusError }, sanitizer = new Sanitizer('')) {
  const safeLive = value => value?.error ? { ...value, error: { ...value.error, message: sanitizer.safeSummary(value.error.message) } } : value;
  if (status?.view === 'single') return { rows: [{ sessionGroup: null, title: '唯一会话',
    presence: status.origin.presence, live: safeLive(status.origin), c4: null, preview: null, name: null, origin: true }], hasOlder: null };
  const live = new Map();
  if (status) {
    live.set('origin', safeLive(status.origin));
    for (const row of status.groups) live.set(row.sessionGroup, safeLive(row));
  }
  const listKnown = status != null && status.groupListError == null;
  const items = new Map((c4.ok ? c4.data.groups : []).map(row => [row.sessionGroup, row]));
  const keys = new Set(['origin', ...live.keys(), ...items.keys(), ...(q.ok ? q.data.groups.map(row => row.sessionGroup) : [])]);
  const rows = [...keys].map(key => {
    const current = live.get(key), item = items.get(key);
    return { sessionGroup: key, presence: current ? current.presence : listKnown ? 'not_running' : 'unknown',
      reason: current || listKnown ? null : statusError ?? 'group_list_failed', live: current ?? null,
      c4: c4Meta(item), preview: safePreview(item, sanitizer, taskNames), name: names.get(key) ?? null, origin: key === 'origin' };
  });
  return { rows, hasOlder: c4.ok ? c4.data.hasOlder : null };
}
