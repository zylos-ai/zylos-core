import { element, fallbackName, icon } from './plain-text.js?v=106';
import { createFetchGuard } from './fetch-guard.js?v=85';
import { cronText } from './cron-text.js?v=94';
import { createForm, createPreviewer, formPayload, initialForm, intervalText, missText, previewPath, wrapSelect } from './schedule-form.js?v=106';

export { missText };

const ENABLED = new Set(['pending', 'running']);
const SECTIONS = [
  ['enabled', task => ENABLED.has(task.status)],
  ['failed', task => task.status === 'failed'],
  ['paused', task => task.status === 'paused'],
  ['completed', task => task.status === 'completed'],
];
const RESULT_CLASS = { success: 'wb-ok', timeout: 'wb-timeout', failed: 'wb-bad', started: 'wb-running' };
const RESULT_ICON = { success: 'check', timeout: 'clock', failed: 'x', started: 'loader' };
const STATE_CLASS = { pending: 'wb-on', running: 'wb-run', paused: 'wb-off', failed: 'wb-bad', completed: 'wb-done' };
const FILTERS = ['all', 'enabled', 'paused', 'failed', 'completed'];

export const statusKey = status => 'wb.schedule.status.' + (['pending', 'paused', 'running', 'completed', 'failed']
  .includes(status) ? status : 'unknown');
export const resultKey = status => 'wb.schedule.result.' + (['success', 'timeout', 'failed', 'started']
  .includes(status) ? status : 'unknown');

const platform = (component, t) => fallbackName({ sessionGroup: component, c4: { componentName: component } }, t);

/** Where a task runs: the dispatch target resolved by the server. */
export function targetLabel(target, { t = key => key, level = 'plain' } = {}) {
  if (!target || target.kind === 'origin') return level === 'technical' ? 'Origin' : t('wb.term.origin');
  if (target.kind === 'raw') return target.text;
  if (level === 'technical') return target.sessionGroup;
  return target.displayName ?? fallbackName({ sessionGroup: target.sessionGroup,
    c4: { componentName: target.componentName } }, t);
}

/** Always two parts; the reply part is the stored reply target, never merged with the first. */
export function deliveryLine(task, { t = key => key, level = 'plain', locale = 'zh' } = {}) {
  const label = targetLabel(task.target, { t, level });
  // Chinese text puts a space only between a Chinese character and Latin text.
  const where = locale === 'en' ? label
    : (/^[\x21-\x7e]/.test(label) ? ' ' : '') + label + (/[\x21-\x7e]$/.test(label) ? ' ' : '');
  if (!task.reply?.channel) return t('wb.schedule.delivery.noReply', { where });
  let reply = platform(task.reply.channel, t);
  if (level === 'technical' && task.reply.endpoint) reply += ' · ' + task.reply.endpoint;
  return t('wb.schedule.delivery.reply', { where, reply });
}

export function scheduleText(task, { t = key => key, locale = 'zh' } = {}) {
  if (task.type === 'recurring') return cronText(task.cron, locale);
  if (task.type === 'interval') return t('wb.schedule.everyText', { interval: intervalText(task.intervalSeconds) });
  return t('wb.schedule.once');
}

// A Latin full stop ends a sentence only before a space, so versions like 0.9.6 stay whole.
export const firstSentence = text => String(text ?? '').split(/(?<=[。！？])|(?<=[.!?])\s+|\n/)[0].slice(0, 120);

export function median(values) {
  const list = values.filter(value => value != null).sort((a, b) => a - b);
  if (!list.length) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}

export function formatTime(epochSeconds, tz, locale = 'zh') {
  if (epochSeconds == null) return '—';
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
    timeZone: tz ?? 'UTC', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(epochSeconds * 1000));
}

export function relativeTime(epochSeconds, nowMs, t = key => key) {
  if (epochSeconds == null) return '';
  const diff = epochSeconds - Math.floor(nowMs / 1000);
  const span = Math.abs(diff);
  const amount = span < 3600 ? `${Math.max(1, Math.round(span / 60))}m` : span < 86400
    ? `${Math.round(span / 3600)}h` : `${Math.round(span / 86400)}d`;
  return t(diff >= 0 ? 'wb.schedule.in' : 'wb.schedule.ago', { span: amount });
}

/** Countdown with minutes, as the list and detail show it: `4h39m后`, `2d3h后`. */
export function untilText(epochSeconds, nowMs, t = key => key) {
  if (epochSeconds == null) return '';
  const diff = epochSeconds - Math.floor(nowMs / 1000);
  const span = Math.abs(diff);
  const minutes = Math.max(1, Math.round(span / 60));
  const amount = minutes < 60 ? `${minutes}m` : span < 86400
    ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
    : `${Math.floor(span / 86400)}d${Math.floor(span % 86400 / 3600)}h`;
  return t(diff >= 0 ? 'wb.schedule.in' : 'wb.schedule.ago', { span: amount });
}

function zoned(epochSeconds, tz) {
  const parts = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', { timeZone: tz ?? 'UTC', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(epochSeconds * 1000))) parts[type] = value;
  return parts;
}

/** `今天 23:45`, `明天 00:00`, `昨天 08:00`, otherwise `11-09 08:00`, all in the scheduler's time zone. */
export function dayTime(epochSeconds, { tz = null, nowMs = Date.now(), t = key => key } = {}) {
  if (epochSeconds == null) return '—';
  const at = zoned(epochSeconds, tz);
  const clock = `${at.hour}:${at.minute}`;
  const key = part => `${part.year}-${part.month}-${part.day}`;
  const now = Math.floor(nowMs / 1000);
  for (const [offset, word] of [[0, 'today'], [86400, 'tomorrow'], [-86400, 'yesterday']]) {
    if (key(zoned(now + offset, tz)) === key(at)) return t('wb.schedule.day.' + word, { time: clock });
  }
  return `${at.month}-${at.day} ${clock}`;
}

/** Run time from milliseconds: `12s`, `4m16s`, `1h00m`. */
export function durationText(ms) {
  if (ms == null) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}m`;
}

/** Status filter counts over all tasks, so the segmented control shows what each choice holds. */
export function statusCounts(tasks) {
  const counts = { all: tasks.length };
  for (const [name, test] of SECTIONS) counts[name] = tasks.filter(test).length;
  return counts;
}

/**
 * Dots on the next-24-hours lane. Dots closer than `gap` percent share a column and
 * step down a row so none hide another; three rows at most.
 */
export function laneDots(tasks, startSeconds) {
  const dots = [];
  for (const task of tasks) {
    for (const at of task.nextRuns?.in24h ?? []) {
      dots.push({ task, at, left: Math.max(0, Math.min(100, (at - startSeconds) / 864)) });
    }
  }
  dots.sort((a, b) => a.at - b.at);
  const lastLeft = [-Infinity, -Infinity, -Infinity];
  for (const dot of dots) {
    let row = lastLeft.findIndex(left => dot.left - left >= 1.2);
    if (row < 0) row = lastLeft.indexOf(Math.min(...lastLeft));
    dot.row = row;
    lastLeft[row] = dot.left;
  }
  return dots;
}

/** Ticks every three clock hours in the scheduler's zone, as percentages of the next 24 hours. */
export function laneTicks(startSeconds, tz) {
  const now = zoned(startSeconds, tz);
  const intoBlock = (Number(now.hour) % 3) * 3600 + Number(now.minute) * 60 + Number(now.second);
  const ticks = [];
  for (let at = startSeconds - intoBlock + 3 * 3600; at < startSeconds + 86400; at += 3 * 3600) {
    const hour = zoned(at, tz).hour;
    ticks.push({ left: (at - startSeconds) / 864, hour, midnight: hour === '00' });
  }
  return ticks;
}

/**
 * Axis labels for the lane ticks. Labels near either end are aligned to that end so none spills past the
 * lane. "Tomorrow 00:00" is never dropped by the narrow-lane thinning; when it sits right next to "now",
 * the "now" label gives way.
 */
export function axisLabels(ticks) {
  const labels = ticks.map((tick, index) => {
    const classes = [];
    if (tick.left > 94) classes.push('wb-end');
    else if (tick.left < 6) classes.push('wb-start');
    if (!tick.midnight) {
      if (index % 2) classes.push('wb-odd');
      if (tick.left < 6) classes.push('wb-near');
      else if (tick.left < 12) classes.push('wb-near2');
    }
    return { ...tick, classes };
  });
  return { labels, hideNow: labels.some(label => label.midnight && label.left < 6) };
}

const legacyTask = task => !Object.prototype.hasOwnProperty.call(task, 'promptTruncated');
const nextRun = task => Array.isArray(task.nextRuns?.runs) ? task.nextRuns.runs[0] ?? null : null;

/** Filtered list sections: enabled by next run, then failed, paused and completed. */
export function groupTasks(tasks, { status = 'all', target = 'all', query = '', t = key => key } = {}) {
  const needle = query.trim().toLowerCase();
  const match = task => (status === 'all' || SECTIONS.find(([name]) => name === status)?.[1](task)) &&
    (target === 'all' || targetLabel(task.target, { t }) === target) &&
    (!needle || [task.name, task.prompt, task.id].some(value => String(value ?? '').toLowerCase().includes(needle)));
  return SECTIONS.map(([name, test]) => {
    const list = tasks.filter(task => test(task) && match(task));
    if (name === 'enabled') list.sort((a, b) => (nextRun(a) ?? Infinity) - (nextRun(b) ?? Infinity));
    return { name, tasks: list };
  }).filter(section => section.tasks.length);
}

const EXPLAINED = new Set(['RESCHEDULE_NOT_FUTURE', 'TASK_WRONG_STATUS', 'tz_unavailable', 'invalid_time', 'invalid_form',
  'prompt_starts_with_dashes', 'invalid_json', 'payload_too_large', 'insufficient_scope', 'read_only_proxy', 'unauthorized']);
// Form checks done by the Dashboard itself: the translated text is the whole message.
const FORM_CODES = new Set(['invalid_form', 'prompt_starts_with_dashes', 'invalid_time', 'tz_unavailable']);
const REFUSED = new Set(['invalid_json', 'payload_too_large', 'insufficient_scope', 'read_only_proxy', 'unauthorized']);

/** Turns an HTTP reply into a write outcome; a definite refusal without an envelope is still rejected. */
export function writeOutcome(status, value) {
  if (value?.result) return value;
  if (status >= 400 && status < 500 && REFUSED.has(value?.error)) return { result: 'rejected', code: value.error, message: '' };
  return { result: 'unknown', reason: value?.error ?? 'request_failed' };
}

/** Write result to show in the form; anything without a scheduler envelope is "unknown". */
export function writeMessage(outcome, t = key => key) {
  if (outcome?.result === 'done') return null;
  if (outcome?.result === 'rejected') {
    const hint = EXPLAINED.has(outcome.code) ? t('wb.schedule.error.' + outcome.code) : null;
    if (hint && FORM_CODES.has(outcome.code)) return hint;
    return [hint, outcome.message].filter(Boolean).join(' · ') || outcome.code;
  }
  return t('wb.schedule.unknownResult');
}

function button(document, text, onClick, className) {
  const node = element(document, 'button', text, className);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

/** Icon-only button; the label stays in the text for screen readers and is shown as a tooltip. */
function iconButton(document, name, label, onClick, className = '') {
  const node = button(document, undefined, onClick, ('wb-icon-btn ' + className).trim());
  node.title = label;
  node.append(icon(document, name), element(document, 'span', label, 'wb-vh'));
  return node;
}

function sectionHead(document, iconName, text, extra) {
  const head = element(document, 'h3');
  head.append(icon(document, iconName, 'xs'), element(document, 'span', text));
  if (extra) head.append(extra);
  return head;
}

function keyValue(document, label, value) {
  const row = element(document, 'div', undefined, 'wb-kv');
  const cell = element(document, 'div', undefined, 'wb-kv-v');
  if (value && typeof value === 'object') cell.append(value);
  else cell.textContent = value ?? '—';
  row.append(element(document, 'div', label, 'wb-kv-k'), cell);
  return row;
}

function recentCells(document, recent, t) {
  const strip = element(document, 'span', undefined, 'wb-sched-cells');
  for (const run of recent ?? []) {
    const cell = element(document, 'i', undefined, 'wb-sched-cell ' + (RESULT_CLASS[run.status] ?? ''));
    cell.title = t(resultKey(run.status));
    strip.append(cell);
  }
  return strip;
}

export function mountSchedule({ document = globalThis.document, window = globalThis.window, t = key => key,
  locale = () => 'zh', endpoint = path => path, identity = () => 'local', writable = () => true,
  onOpenGroup = () => {}, fetch = globalThis.fetch, now = Date.now } = {}) {
  const root = document.querySelector('#wb-schedule');
  if (!root) return () => {};
  const guard = createFetchGuard();
  let data = null, error = false, selected = null, history = null, historyGen = 0, form = null, confirmFor = null,
    filter = { status: 'all', target: 'all', query: '' }, owner = identity(), stopped = false, notice = null,
    fullPrompt = null, detailTask = null, detailError = false, detailGen = 0, listBusy = false, pageCount = 1, legacyServer = false;
  // The page, the drawer and the dialog layer stay mounted across redraws, so a refresh keeps the drawer's
  // scroll position and an open form keeps its focus and typed text.
  const main = element(document, 'div', undefined, 'wb-sched-main');
  const aside = element(document, 'aside', undefined, 'wb-sched-side');
  const layer = element(document, 'div', undefined, 'wb-sched-layer');
  let mounted = false, sideKey = null, sideBody = null;
  aside.hidden = true;
  const level = () => document.documentElement?.dataset?.detail === 'technical' ? 'technical' : 'plain';
  const tz = () => data?.tz ?? null;
  const time = epoch => formatTime(epoch, tz(), locale());
  const day = epoch => dayTime(epoch, { tz: tz(), nowMs: now(), t });
  const previewer = createPreviewer({
    fetchPreview: path => read(path),
    onResult: value => form?.handle.setPreview(value),
  });
  function reset() {
    if (owner === identity()) return false;
    owner = identity();
    guard.invalidate();
    data = null;
    error = false;
    selected = null;
    history = null;
    historyGen++;
    detailGen++;
    detailTask = null;
    detailError = false;
    listBusy = false;
    pageCount = 1;
    legacyServer = false;
    filter = { status: 'all', target: 'all', query: '' };
    form = null;
    confirmFor = null;
    notice = null;
    root.replaceChildren();
    mounted = false;
    return true;
  }
  async function read(path) {
    const captured = identity();
    const response = await fetch(endpoint(path));
    if (captured !== identity() || stopped) throw Error('view_changed');
    if (!response.ok) throw Error('read_failed');
    const value = await response.json();
    if (captured !== identity() || stopped) throw Error('view_changed');
    return value;
  }
  const visible = () => {
    reset();
    return document.visibilityState !== 'hidden' && document.querySelector('#tab-schedule')?.classList.contains('active') &&
      !document.querySelector('#agent-detail')?.hidden;
  };
  const pagedList = () => !legacyServer && (filter.status === 'completed' ||
    (filter.status === 'all' && Boolean(filter.query.trim())));
  function listPath(cursor = null) {
    if (legacyServer) return '/api/workbench/schedule';
    const query = new URLSearchParams();
    if (filter.status !== 'all') query.set('status', filter.status);
    if (filter.query.trim()) query.set('q', filter.query.trim());
    if (cursor !== null) query.set('cursor', cursor);
    return '/api/workbench/schedule' + (query.size ? `?${query}` : '');
  }
  async function refresh({ force = false, more = false } = {}) {
    if (!force && !visible()) return;
    reset();
    if (listBusy && !force) return;
    if (more && (!pagedList() || !data?.nextCursor)) return;
    if (force && !more) pageCount = 1;
    const gen = guard.next();
    const paged = pagedList();
    const pages = paged && !more ? pageCount : 1;
    let cursor = more ? data.nextCursor : null;
    listBusy = true;
    redraw();
    try {
      let value, tasks = more ? [...data.tasks] : [], loaded = 0;
      // Follow fresh cursors on a poll so an already expanded completed list keeps
      // its depth without retaining stale cursor boundaries after task changes.
      do {
        value = await read(listPath(cursor));
        if (!guard.current(gen)) return;
        tasks.push(...value.tasks);
        loaded++;
        cursor = value.nextCursor;
      } while (!more && paged && cursor && loaded < pages);
      const unique = new Map(tasks.map(task => [task.id, task]));
      data = { ...value, tasks: [...unique.values()] };
      legacyServer = data.tasks.some(legacyTask);
      pageCount = more ? pageCount + 1 : loaded;
      error = false;
    } catch {
      if (!guard.current(gen)) return;
      error = true;
    } finally {
      if (guard.current(gen)) listBusy = false;
    }
    redraw();
    if (selected && !form) loadDetail(selected);
  }
  function changeList(change) {
    filter = { ...filter, ...change };
    if (legacyServer) { redraw(); return; }
    guard.invalidate();
    listBusy = false;
    pageCount = 1;
    if (data) data = { ...data, tasks: [], nextCursor: null };
    refresh({ force: true });
  }
  async function loadDetail(id) {
    const gen = ++detailGen;
    const listed = [...(data?.tasks ?? []), ...(data?.timelineTasks ?? [])].find(task => task.id === id);
    if (listed && legacyTask(listed)) {
      detailTask = listed;
      detailError = false;
      redraw();
      return;
    }
    try {
      const value = await read(`/api/workbench/schedule/${encodeURIComponent(id)}`);
      if (gen !== detailGen || selected !== id) return;
      if (!value.task || value.task.id !== id) throw Error('invalid_detail');
      detailTask = value.task;
      detailError = false;
    } catch {
      if (gen !== detailGen || selected !== id) return;
      detailTask = null;
      detailError = true;
    }
    redraw();
  }
  async function loadHistory(task, more = false) {
    const gen = ++historyGen;
    const query = new URLSearchParams({ limit: more ? '200' : '30' });
    if (more && history?.next) {
      query.set('before', String(history.next.before));
      query.set('beforeId', String(history.next.beforeId));
    }
    try {
      const value = await read(`/api/workbench/schedule/${encodeURIComponent(task.id)}/history?${query}`);
      if (gen !== historyGen || selected !== task.id) return;
      history = { rows: more ? [...(history?.rows ?? []), ...value.rows] : value.rows, next: value.next,
        expanded: history?.expanded };
    } catch {
      if (gen !== historyGen) return;
      history = { ...(history ?? { rows: [], next: null }), failed: true };
    }
    redraw();
  }
  async function write(method, path, body) {
    let outcome;
    try {
      const response = await fetch(endpoint(path), {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json().catch(() => null);
      outcome = writeOutcome(response.status, value);
    } catch {
      outcome = { result: 'unknown', reason: 'request_failed' };
    }
    // The page always re-reads once so the list shows the scheduler's current state.
    await refresh({ force: true });
    return outcome;
  }
  function select(id) {
    selected = id;
    form = null;
    confirmFor = null;
    history = null;
    fullPrompt = null;
    detailTask = null;
    detailError = false;
    redraw();
    loadDetail(id);
    loadHistory({ id });
  }
  function close() {
    detailGen++;
    historyGen++;
    detailTask = null;
    selected = null;
    form = null;
    confirmFor = null;
    history = null;
    redraw();
  }
  function openForm(task, reenable = false) {
    // Only the detail endpoint owns a complete prompt; list summaries never
    // become edit state, even when the summary happens to fit in 200 characters.
    if (task && (task !== detailTask || task.promptTruncated)) return;
    const creating = !task;
    const original = initialForm(task, { reenable, tz: tz() });
    const handle = createForm(document, {
      state: original, t, creating, reenable, formatTime: time,
      tzLabel: tz() ? t('wb.schedule.tzFromEnv', { tz: tz() }) : t('wb.schedule.tzUnknown'),
      onChange: (state, scheduleChanged) => {
        if (scheduleChanged && state.value.trim()) previewer.request(previewPath(state, { reenable, locale: locale() }));
      },
      onCancel: () => {
        form = null;
        redraw();
      },
      onSave: async state => {
        handle.setBusy(true);
        handle.setMessage('');
        const body = formPayload(state, creating ? null : original, { reenable });
        const outcome = creating ? await write('POST', '/api/workbench/schedule', body)
          : await write('PUT', `/api/workbench/schedule/${encodeURIComponent(task.id)}`, body);
        handle.setBusy(false);
        const message = writeMessage(outcome, t);
        if (message === null) {
          form = null;
          selected = outcome.data?.task?.id ?? selected;
          if (selected) loadDetail(selected);
          notice = outcome.data?.reenabled ? t('wb.schedule.reenabled') : null;
          redraw();
        } else {
          handle.setMessage(message);
        }
      },
    });
    form = { handle, taskId: task?.id ?? null };
    if (creating) selected = null;
    if (original.value) previewer.request(previewPath(original, { reenable, locale: locale() }));
    redraw();
  }
  async function act(task, action) {
    const outcome = action === 'remove'
      ? await write('DELETE', `/api/workbench/schedule/${encodeURIComponent(task.id)}`)
      : await write('POST', `/api/workbench/schedule/${encodeURIComponent(task.id)}/${action}`);
    confirmFor = null;
    notice = writeMessage(outcome, t);
    if (action === 'remove' && outcome.result === 'done') selected = null;
    redraw();
  }
  function renderKpi() {
    const kpi = data.kpi;
    const row = element(document, 'div', undefined, 'wb-sched-kpi');
    for (const [key, value, extra] of [['enabled', kpi.enabled], ['paused', kpi.paused],
      ['next24h', t('wb.schedule.times', { n: kpi.next24h })], ['runs7d', t('wb.schedule.times', { n: kpi.runs7d })],
      ['bad7d', kpi.bad7d, kpi.bad7d ? ' wb-txt-err' : ''], ['running', kpi.running]]) {
      const item = element(document, 'div', undefined, 'wb-sched-kpi-item');
      item.append(element(document, 'small', t('wb.schedule.kpi.' + key)), element(document, 'b', value, extra?.trim()));
      row.append(item);
    }
    if (kpi.partialPreview) row.append(element(document, 'small', t('wb.schedule.partialPreview'), 'wb-sched-note'));
    return row;
  }
  function renderWeek() {
    const kpi = data.kpi;
    const days = data.daily7d?.days ?? [];
    const box = element(document, 'section', undefined, 'wb-sched-block');
    box.append(sectionHead(document, 'activity', t('wb.schedule.week.title')));
    const body = element(document, 'div', undefined, 'wb-sched-week');
    const totals = { success: 0, timeout: 0, failed: 0 };
    for (const item of days) for (const key of Object.keys(totals)) totals[key] += item[key] ?? 0;
    const finished = totals.success + totals.failed;
    const ring = element(document, 'div', undefined, 'wb-sched-ring');
    const ok = finished ? totals.success / finished * 100 : 0;
    ring.style.setProperty('--ok', `${ok}%`);
    ring.style.setProperty('--late', `${ok}%`);
    if (!finished) ring.classList.add('wb-no-runs');
    const hole = element(document, 'div', undefined, 'wb-sched-ring-hole');
    hole.append(element(document, 'b', kpi.successRate7d == null ? '—' : `${Math.round(kpi.successRate7d * 100)}%`),
      element(document, 'small', t('wb.schedule.kpi.rate7d')));
    ring.append(hole);
    const legend = element(document, 'div', undefined, 'wb-sched-legend');
    for (const [key, name] of [['success', 'check'], ['timeout', 'clock'], ['failed', 'x']]) {
      const line = element(document, 'div', undefined, 'wb-sched-legend-row wb-' + key);
      line.append(icon(document, name, 'xs'), element(document, 'span', t(resultKey(key))), element(document, 'b', totals[key]));
      legend.append(line);
    }
    const worst = days.reduce((top, item) => item.failed > (top?.failed ?? 0) ? item : top, null);
    if (worst) legend.append(element(document, 'small', t('wb.schedule.week.worst',
      { date: worst.date.slice(5), n: worst.failed }), 'wb-sched-note'));
    const chart = element(document, 'div', undefined, 'wb-sched-days');
    const peak = Math.max(1, ...days.map(item => item.success + item.timeout + item.failed));
    days.forEach((item, index) => {
      const column = element(document, 'div', undefined, 'wb-sched-day');
      const stack = element(document, 'div', undefined, 'wb-sched-stack');
      for (const key of ['failed', 'timeout', 'success']) {
        if (!item[key]) continue;
        const part = element(document, 'i', undefined, 'wb-' + key);
        part.style.setProperty('height', `${item[key] / peak * 100}%`);
        part.title = `${t(resultKey(key))} ${item[key]}`;
        stack.append(part);
      }
      column.title = `${item.date} · ${item.success + item.timeout + item.failed}`;
      column.append(stack, element(document, 'small', index === days.length - 1 ? t('wb.schedule.today') : item.date.slice(5)));
      chart.append(column);
    });
    body.append(ring, legend, chart);
    box.append(body);
    return box;
  }
  function renderTimeline() {
    const box = element(document, 'section', undefined, 'wb-sched-block wb-sched-lane');
    box.append(sectionHead(document, 'clock', t('wb.schedule.kpi.next24h')));
    const lane = element(document, 'div', undefined, 'wb-sched-timeline');
    const axis = element(document, 'div', undefined, 'wb-sched-axis');
    const start = Math.floor(now() / 1000);
    const { labels, hideNow } = axisLabels(laneTicks(start, tz()));
    axis.append(element(document, 'span', t('wb.schedule.now'), 'wb-sched-axis-now' + (hideNow ? ' wb-near' : '')));
    for (const tick of labels) {
      const line = element(document, 'i', undefined, 'wb-sched-tick');
      line.style.setProperty('left', `${tick.left}%`);
      lane.append(line);
      // A narrow lane keeps every other label; labels close to "now" are dropped so they never overlap it.
      const label = element(document, 'span', tick.midnight ? t('wb.schedule.day.tomorrow', { time: '00:00' }) : `${tick.hour}:00`,
        [...tick.classes, tick.midnight ? 'wb-midnight' : ''].filter(Boolean).join(' ') || undefined);
      label.style.setProperty('left', `${tick.left}%`);
      axis.append(label);
    }
    const timeline = data.timelineTasks ?? data.tasks;
    const dense = timeline.filter(task => (task.nextRuns?.in24h?.length ?? 0) > 96);
    if (dense.length) lane.style.setProperty('height', `${46 + dense.length * 44}px`);
    for (const [index, task] of dense.entries()) {
      const runs = task.nextRuns.in24h;
      const first = Math.max(0, Math.min(100, (runs[0] - start) / 864));
      const last = Math.max(first, Math.min(100, (runs.at(-1) - start) / 864));
      const band = button(document, '', () => select(task.id), 'wb-sched-band' +
        (task.priority === 1 ? ' wb-p1' : '') + (task.id === selected ? ' active' : ''));
      band.title = `${task.name} · ${t('wb.schedule.times', { n: runs.length })}`;
      band.setAttribute('aria-label', band.title);
      band.style.setProperty('left', `${first}%`);
      band.style.setProperty('width', `${last - first}%`);
      band.style.setProperty('top', `${46 + index * 44}px`);
      lane.append(band);
    }
    for (const dot of laneDots(timeline.filter(task => (task.nextRuns?.in24h?.length ?? 0) <= 96), start)) {
      const node = button(document, '', () => select(dot.task.id), 'wb-sched-dot' +
        (dot.task.priority === 1 ? ' wb-p1' : '') + (dot.task.id === selected ? ' active' : ''));
      node.title = `${dot.task.name} · ${day(dot.at)}`;
      node.setAttribute('aria-label', node.title);
      node.style.setProperty('left', `${dot.left}%`);
      node.style.setProperty('top', `${10 + dot.row * 7.5}px`);
      lane.append(node);
    }
    box.append(lane, axis);
    return box;
  }
  function renderFilters() {
    const bar = element(document, 'div', undefined, 'wb-sched-filters');
    const counts = data.counts ?? statusCounts(data.tasks);
    const seg = element(document, 'div', undefined, 'wb-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', t('wb.schedule.filter.label'));
    for (const value of FILTERS) {
      const item = button(document, t('wb.schedule.filter.' + value), () => {
        changeList({ status: value });
      });
      item.append(element(document, 'span', counts[value] ?? 0, 'wb-n'));
      item.setAttribute('aria-pressed', String(filter.status === value));
      seg.append(item);
    }
    const target = document.createElement('select');
    target.className = 'wb-input wb-select';
    target.setAttribute('aria-label', t('wb.schedule.filter.allTargets'));
    const all = element(document, 'option', t('wb.schedule.filter.allTargets'));
    all.value = 'all';
    target.append(all);
    for (const label of [...new Set([...(data.timelineTasks ?? []), ...data.tasks].map(task => targetLabel(task.target, { t })))].sort()) {
      const option = element(document, 'option', label);
      option.value = label;
      target.append(option);
    }
    target.value = filter.target;
    target.addEventListener('change', () => {
      filter = { ...filter, target: target.value };
      redraw();
    });
    const searchWrap = element(document, 'label', undefined, 'wb-search');
    const search = document.createElement('input');
    search.type = 'search';
    search.value = filter.query;
    search.placeholder = t('wb.schedule.search');
    search.setAttribute('aria-label', t('wb.schedule.search'));
    const apply = () => {
      if (search.value === filter.query) return;
      changeList({ query: search.value });
    };
    search.addEventListener('change', apply);
    search.addEventListener('search', apply);
    searchWrap.append(icon(document, 'search', 'xs'), search);
    bar.append(seg, wrapSelect(document, target), searchWrap);
    if (writable()) {
      const create = button(document, t('wb.schedule.new'), () => openForm(null), 'wb-btn wb-btn-primary wb-sched-new');
      create.replaceChildren(icon(document, 'plus', 'xs'), element(document, 'span', t('wb.schedule.new')));
      bar.append(create);
    }
    return bar;
  }
  function renderTarget(task) {
    const label = targetLabel(task.target, { t, level: level() });
    if (task.target?.kind !== 'group') return element(document, 'span', label, 'wb-sched-target');
    const node = button(document, label, () => onOpenGroup(task.target.sessionGroup), 'wb-sched-target');
    node.title = t('wb.schedule.openGroup');
    return node;
  }
  function statePill(task) {
    const pill = element(document, 'span', undefined, 'wb-sched-state ' + (STATE_CLASS[task.status] ?? ''));
    pill.append(element(document, 'i', undefined, 'wb-dot'), element(document, 'span', t(statusKey(task.status))));
    return pill;
  }
  function renderRow(task) {
    // Two sibling buttons: one selects the task, the other opens its target group.
    const row = element(document, 'div', undefined, 'wb-sched-row' + (task.id === selected ? ' active' : ''));
    const open = button(document, undefined, () => select(task.id), 'wb-sched-select');
    const name = element(document, 'span', undefined, 'wb-sched-name');
    // The name sits in its own span: an ellipsis needs a block box, and the bold line is a flex row.
    const title = element(document, 'b');
    title.append(element(document, 'span', task.name, 'wb-sched-title'));
    if (level() === 'technical') title.append(element(document, 'span', 'P' + task.priority, 'wb-tag wb-sched-prio'));
    name.append(title, element(document, 'small', firstSentence(task.promptSummary ?? task.prompt)));
    const rule = element(document, 'span', scheduleText(task, { t, locale: locale() }), 'wb-sched-rule');
    if (level() === 'technical' && task.cron) rule.append(element(document, 'small', task.cron, 'wb-mono'));
    // The original rule stays reachable in plain view, including rules that are not put into words.
    if (task.cron) rule.title = task.cron;
    const upcoming = nextRun(task);
    const next = element(document, 'span', task.nextRuns?.unavailable ? t('wb.schedule.noPreview')
      : upcoming == null ? '—' : untilText(upcoming, now(), t), 'wb-sched-next');
    if (!task.nextRuns?.unavailable && upcoming != null) next.append(element(document, 'small', day(upcoming)));
    const recent = element(document, 'span', undefined, 'wb-sched-recent');
    recent.append(recentCells(document, task.recent, t));
    const success = [...(task.recent ?? [])].reverse().find(run => run.status === 'success');
    if (success) recent.append(element(document, 'small', t('wb.schedule.lastSuccess', { time: day(success.executedAt) })));
    open.append(name, rule, next, recent);
    row.append(open, renderTarget(task), statePill(task));
    return row;
  }
  function renderList() {
    const wrap = element(document, 'div', undefined, 'wb-sched-table');
    const head = element(document, 'div', undefined, 'wb-sched-th');
    for (const key of ['task', 'rule', 'next', 'recent', 'target', 'status']) head.append(element(document, 'span', t('wb.schedule.col.' + key)));
    wrap.append(head);
    const sections = groupTasks(data.tasks, { ...filter, query: legacyServer ? filter.query : '', t });
    if (!sections.length) wrap.append(element(document, 'p', t('wb.schedule.noMatch'), 'wb-sched-empty'));
    for (const section of sections) {
      const block = element(document, 'section', undefined, 'wb-sched-section');
      block.append(element(document, 'h3', t('wb.schedule.section.' + section.name)));
      if (section.name === 'enabled') block.children[0].append(element(document, 'small', t('wb.schedule.sortedByNext')));
      for (const task of section.tasks) block.append(renderRow(task));
      wrap.append(block);
    }
    if (pagedList() && data.nextCursor) {
      const more = button(document, t('wb.detail.loadMore'), () => refresh({ more: true }), 'wb-link-btn wb-sched-more');
      more.disabled = listBusy;
      wrap.append(more);
    }
    return wrap;
  }
  function renderHistory(task) {
    const box = element(document, 'section', undefined, 'wb-detail-section wb-sched-history');
    box.append(sectionHead(document, 'activity', t('wb.schedule.history')));
    if (!history) return box;
    const rows = history.rows;
    if (!rows.length && !history.failed) box.append(element(document, 'p', t('wb.schedule.noHistory'), 'wb-note'));
    const recent = rows.slice(0, 30).reverse();
    if (recent.length) {
      const chart = element(document, 'div', undefined, 'wb-sched-bars');
      const peak = Math.max(1, ...recent.map(row => row.duration ?? 0));
      for (const run of recent) {
        const bar = element(document, 'i', undefined, 'wb-sched-bar ' + (RESULT_CLASS[run.status] ?? ''));
        bar.style.setProperty('height', `${Math.max(4, Math.round((run.duration ?? 0) / peak * 100))}%`);
        bar.title = `${time(run.executedAt)} · ${t(resultKey(run.status))} · ${durationText(run.duration)}`;
        chart.append(bar);
      }
      const axis = element(document, 'div', undefined, 'wb-sched-bars-axis');
      axis.append(element(document, 'span', day(recent[0].executedAt)),
        element(document, 'span', t('wb.schedule.longest', { span: durationText(Math.max(...recent.map(row => row.duration ?? 0))) })),
        element(document, 'span', t('wb.schedule.latest')));
      box.append(chart, axis);
    }
    const list = element(document, 'div', undefined, 'wb-sched-runs');
    for (const run of rows.slice(0, history.expanded ? rows.length : 8)) {
      const line = element(document, 'div', undefined, 'wb-sched-run ' + (RESULT_CLASS[run.status] ?? ''));
      const what = element(document, 'span', t(resultKey(run.status)), 'wb-sched-run-what');
      if (['failed', 'timeout'].includes(run.status) && run.error) what.append(element(document, 'small', run.error));
      line.append(element(document, 'time', day(run.executedAt)), icon(document, RESULT_ICON[run.status] ?? 'help', 'xs'), what,
        element(document, 'span', durationText(run.duration), 'wb-sched-run-dur'));
      list.append(line);
    }
    box.append(list);
    if (history.failed) box.append(element(document, 'p', t('wb.readFailed'), 'wb-sched-note'));
    if (history.next || (!history.expanded && rows.length > 8)) {
      const more = button(document, t('wb.schedule.loadAll'), () => {
        history.expanded = true;
        if (history.next) loadHistory(task, true);
        else redraw();
      }, 'wb-link-btn wb-chev');
      box.append(more);
    }
    return box;
  }
  function renderConfirm(task) {
    const back = element(document, 'div', undefined, 'wb-modal-bg');
    const dialog = element(document, 'div', undefined, 'wb-modal');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const cancel = () => {
      confirmFor = null;
      redraw();
    };
    const acts = element(document, 'div', undefined, 'wb-modal-acts');
    acts.append(button(document, t('wb.schedule.cancel'), cancel, 'wb-btn'));
    if (task.status === 'pending') acts.append(button(document, t('wb.schedule.pauseInstead'), () => act(task, 'pause'), 'wb-btn'));
    acts.append(button(document, t('wb.schedule.delete'), () => act(task, 'remove'), 'wb-btn wb-btn-danger wb-danger'));
    dialog.append(element(document, 'h3', t('wb.schedule.deleteTitle', { name: task.name })),
      element(document, 'p', t('wb.schedule.confirmDelete')), acts);
    back.append(dialog);
    return back;
  }
  function renderPrompt(task) {
    const box = element(document, 'section', undefined, 'wb-detail-section');
    box.append(sectionHead(document, 'book', t('wb.schedule.section.content')));
    const text = String(task.prompt ?? '');
    const long = text.length > 320 || text.split('\n').length > 8;
    const open = !long || fullPrompt === task.id;
    box.append(element(document, 'pre', task.prompt, 'wb-sched-prompt' + (open ? '' : ' wb-clamped')));
    if (long) {
      box.append(button(document, t(open ? 'wb.schedule.collapse' : 'wb.schedule.expand'), () => {
        fullPrompt = open ? null : task.id;
        redraw();
      }, 'wb-link-btn'));
    }
    return box;
  }
  function renderDetail(task) {
    const panel = element(document, 'div', undefined, 'wb-sched-detail');
    const header = element(document, 'div', undefined, 'wb-detail-header');
    const top = element(document, 'div', undefined, 'wb-d-top');
    const badge = element(document, 'span', undefined, 'wb-ch');
    badge.append(icon(document, 'clock'));
    // State and actions share one wrapper: on phones it becomes the second row under the title.
    const sub = element(document, 'div', undefined, 'wb-d-sub');
    sub.append(statePill(task));
    top.append(badge, element(document, 'h3', task.name, 'wb-d-title'), sub);
    const acts = element(document, 'div', undefined, 'wb-d-acts');
    if (writable()) {
      if (task.status === 'pending') acts.append(iconButton(document, 'pause', t('wb.schedule.pause'), () => act(task, 'pause')));
      if (task.status === 'paused') acts.append(iconButton(document, 'play', t('wb.schedule.resume'), () => act(task, 'resume')));
      // An expired one-time task edits through the re-enable form: saving a future time enables it again.
      acts.append(iconButton(document, 'edit', t('wb.schedule.edit'), () => openForm(task, task.reenable)));
      acts.append(iconButton(document, 'trash', t('wb.schedule.delete'), () => {
        confirmFor = task.id;
        redraw();
      }, 'wb-icon-danger'));
    }
    sub.append(acts); top.append(iconButton(document, 'x', t('wb.close'), close, 'wb-sched-close'));
    const meta = element(document, 'p', undefined, 'wb-detail-meta');
    if (level() === 'technical') meta.append(element(document, 'span', `${task.id} · P${task.priority} · `, 'wb-mono wb-sched-tech'));
    meta.append(element(document, 'span', t('wb.schedule.updated', { time: time(task.updatedAt) })));
    header.append(top, meta);
    panel.append(header);
    const body = element(document, 'div', undefined, 'wb-detail-body');
    sideBody = body;
    const rows = history?.rows ?? [];
    const finished = rows.filter(run => ['success', 'failed'].includes(run.status));
    const rate = finished.length ? `${Math.round(finished.filter(run => run.status === 'success').length / finished.length * 100)}%` : '—';
    const typical = median(finished.filter(run => run.status === 'success').map(run => run.duration));
    const upcoming = nextRun(task);
    const last = rows[0];
    const numbers = element(document, 'div', undefined, 'wb-detail-numbers');
    for (const [key, value, sub, extra] of [
      ['next', upcoming == null ? '—' : untilText(upcoming, now(), t), upcoming == null ? '' : day(upcoming)],
      ['rate', rate, finished.length ? t('wb.schedule.lastN', { n: finished.length }) : ''],
      ['median', typical == null ? '—' : durationText(typical), t('wb.schedule.successRuns')],
      ['last', last ? t(resultKey(last.status)) : '—', day(task.lastRunAt), last && last.status !== 'success' ? 'wb-hi' : ''],
    ]) {
      const cell = element(document, 'div', undefined, extra || undefined);
      cell.append(element(document, 'small', t('wb.schedule.detail.' + key)), element(document, 'b', value));
      if (sub) cell.append(element(document, 'small', sub));
      numbers.append(cell);
    }
    body.append(numbers);
    if (task.showLastError || task.reenable) {
      const card = element(document, 'div', undefined, 'wb-sched-error-card');
      const head = element(document, 'div', undefined, 'wb-now-title');
      head.append(icon(document, 'alert'), element(document, 'span',
        task.showLastError ? t('wb.schedule.lastError', { error: task.lastError ?? t('wb.schedule.result.failed') })
          : t('wb.schedule.reenable'), 'wb-sched-error'));
      card.append(head);
      if (task.reenable) card.append(element(document, 'p', t('wb.schedule.reenableHint'), 'wb-now-sub'));
      if (task.reenable && writable()) {
        card.append(button(document, t('wb.schedule.reenable'), () => openForm(task, true), 'wb-btn wb-btn-primary wb-sched-reenable'));
      }
      const wrap = element(document, 'section', undefined, 'wb-detail-section');
      wrap.append(card);
      body.append(wrap);
    }
    body.append(renderPrompt(task));
    const when = element(document, 'section', undefined, 'wb-detail-section');
    when.append(sectionHead(document, 'clock', t('wb.schedule.section.time')));
    const rule = element(document, 'span', scheduleText(task, { t, locale: locale() }));
    if (level() === 'technical' && task.cron) rule.append(element(document, 'small', ' ' + task.cron, 'wb-mono'));
    when.append(keyValue(document, t('wb.schedule.rule'), rule));
    when.append(keyValue(document, t('wb.schedule.tz'), tz() ? t('wb.schedule.tzValue', { tz: tz() }) : t('wb.schedule.tzUnknown')));
    let upcomingNode;
    if (task.nextRuns?.unavailable) upcomingNode = t('wb.schedule.noPreview');
    else {
      upcomingNode = element(document, 'span', undefined, 'wb-chips');
      (task.nextRuns?.runs ?? []).slice(0, 5).forEach((at, index) =>
        upcomingNode.append(element(document, 'span', day(at), 'wb-sched-chip' + (index ? '' : ' wb-first'))));
      if (!task.nextRuns?.runs?.length) upcomingNode.textContent = '—';
    }
    when.append(keyValue(document, t('wb.schedule.next5'), upcomingNode));
    when.append(keyValue(document, t('wb.schedule.missLabel'), t('wb.schedule.missText', { span: missText(task.missThreshold, t) })));
    body.append(when);
    const send = element(document, 'section', undefined, 'wb-detail-section');
    send.append(sectionHead(document, 'send', t('wb.schedule.section.delivery')));
    send.append(keyValue(document, t('wb.schedule.col.target'), renderTarget(task)));
    send.append(element(document, 'p', deliveryLine(task, { t, level: level(), locale: locale() }), 'wb-sched-delivery'));
    send.append(element(document, 'p', t(task.requireIdle ? 'wb.schedule.requireIdle.yes' : 'wb.schedule.requireIdle.no'),
      'wb-sched-idle'));
    body.append(send, renderHistory(task));
    panel.append(body);
    return panel;
  }
  function renderFormPanel() {
    const panel = element(document, 'div', undefined, 'wb-sched-detail');
    const header = element(document, 'div', undefined, 'wb-detail-header');
    const top = element(document, 'div', undefined, 'wb-d-top');
    top.append(form.handle.title, iconButton(document, 'x', t('wb.close'), () => {
      form = null;
      redraw();
    }));
    header.append(top);
    const body = element(document, 'div', undefined, 'wb-detail-body');
    body.append(form.handle.root);
    panel.append(header, body);
    return panel;
  }
  function redraw() {
    if (stopped) return;
    const notes = [];
    if (data && !data.tz) notes.push(element(document, 'p', t('wb.schedule.tzUnknown'), 'wb-sched-tz wb-txt-warn'));
    if (error) notes.push(element(document, 'p', t('wb.readFailed'), 'wb-sched-error'));
    if (notice) notes.push(element(document, 'p', notice, 'wb-sched-notice'));
    if (data && !data.available) {
      const empty = element(document, 'div', undefined, 'wb-empty-state');
      empty.append(icon(document, 'clock'), element(document, 'p', t('wb.schedule.empty')));
      notes.push(empty);
    }
    const task = data?.available && detailTask?.id === selected ? detailTask : null;
    if (data?.available) {
      const top = element(document, 'div', undefined, 'wb-sched-top');
      top.append(renderKpi(), renderWeek(), renderTimeline());
      notes.push(top, renderFilters(), renderList());
    }
    main.replaceChildren(...notes);
    const showForm = data?.available && form && (form.taskId === null || form.taskId === task?.id);
    const key = showForm ? form : selected;
    if (showForm) {
      // A mounted form is never rebuilt: its inputs keep focus and their text.
      form.panel ??= renderFormPanel();
      if (aside.children[0] !== form.panel) aside.replaceChildren(form.panel);
    } else if (task) {
      const scroll = key === sideKey ? sideBody?.scrollTop ?? 0 : 0;
      aside.replaceChildren(renderDetail(task));
      if (scroll) sideBody.scrollTop = scroll;
    } else if (selected) {
      const pending = element(document, 'div', undefined, 'wb-sched-detail');
      pending.append(iconButton(document, 'x', t('wb.close'), close),
        element(document, 'p', t(detailError ? 'wb.readFailed' : 'chat.loading'), 'wb-sched-note'));
      aside.replaceChildren(pending);
    } else {
      aside.replaceChildren();
    }
    sideKey = key;
    aside.hidden = key === null;
    layer.replaceChildren(...(task && confirmFor === task.id ? [renderConfirm(task)] : []));
    root.className = 'wb-schedule' + (key === null ? '' : ' wb-has-side');
    if (!mounted) {
      root.replaceChildren(main, aside, layer);
      mounted = true;
    }
    fitAxis();
  }
  /**
   * After layout, keep every lane label inside the lane: a label crossing an edge is aligned to that edge,
   * and one that still touches the label before it is dropped (long words such as "Tomorrow 00:00").
   * On a collision "Tomorrow 00:00" stays and the other label goes.
   */
  function fitAxis() {
    const frame = window?.requestAnimationFrame;
    if (!frame) return;
    frame(() => {
      const axis = root.querySelector?.('.wb-sched-axis');
      if (!axis?.getBoundingClientRect) return;
      const lane = axis.getBoundingClientRect();
      let last = null;
      for (const label of axis.children) {
        label.classList.remove('wb-crowded', 'wb-fit-start', 'wb-fit-end');
        if (getComputedStyle(label).display === 'none') continue;
        let box = label.getBoundingClientRect();
        if (box.left < lane.left - 0.5) {
          label.classList.add('wb-fit-start');
          box = label.getBoundingClientRect();
        } else if (box.right > lane.right + 0.5) {
          label.classList.add('wb-fit-end');
          box = label.getBoundingClientRect();
        }
        if (box.right > lane.right + 0.5) label.classList.add('wb-crowded');
        else if (last && box.left < last.box.right + 6) {
          if (label.classList.contains('wb-midnight')) {
            last.label.classList.add('wb-crowded');
            last = { label, box };
          } else label.classList.add('wb-crowded');
        } else last = { label, box };
      }
    });
  }
  const visibility = () => {
    if (document.visibilityState === 'visible') refresh();
  };
  const keydown = event => {
    if (event.key !== 'Escape' || !document.querySelector('#tab-schedule')?.classList.contains('active')) return;
    // Esc also cancels an input method's candidate list; that must never close the form.
    if (event.isComposing || event.keyCode === 229) return;
    if (confirmFor) confirmFor = null;
    // A form with typed changes stays open; it is closed with Cancel.
    else if (form?.handle.dirty()) return;
    else if (form) form = null;
    else if (selected) { close(); event.preventDefault?.(); return; }
    else return;
    event.preventDefault?.();
    redraw();
  };
  const toggle = document.querySelector('#wb-detail-toggle');
  const redrawLater = () => redraw();
  const observer = window?.MutationObserver ? new window.MutationObserver(() => {
    if (reset()) redraw();
    refresh();
  }) : null;
  const tab = document.querySelector('#tab-schedule');
  if (tab) observer?.observe(tab, { attributes: true, attributeFilter: ['class'] });
  const detail = document.querySelector('#agent-detail');
  if (detail) observer?.observe(detail, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('dashboard-locale-change', redrawLater);
  document.addEventListener('keydown', keydown);
  toggle?.addEventListener('change', redrawLater);
  window?.addEventListener('popstate', visibility);
  window?.addEventListener('resize', fitAxis);
  const timer = setInterval(refresh, 30000);
  refresh();
  return () => {
    stopped = true;
    clearInterval(timer);
    guard.invalidate();
    previewer.destroy();
    observer?.disconnect();
    document.removeEventListener('visibilitychange', visibility);
    document.removeEventListener('dashboard-locale-change', redrawLater);
    document.removeEventListener('keydown', keydown);
    toggle?.removeEventListener('change', redrawLater);
    window?.removeEventListener('popstate', visibility);
    window?.removeEventListener('resize', fitAxis);
  };
}
