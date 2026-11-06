import { element, fallbackName } from './plain-text.js?v=82';
import { createFetchGuard } from './fetch-guard.js?v=82';
import { cronText } from './cron-text.js?v=82';
import { createForm, createPreviewer, formPayload, initialForm, intervalText, previewPath } from './schedule-form.js?v=82';

const ENABLED = new Set(['pending', 'running']);
const SECTIONS = [
  ['enabled', task => ENABLED.has(task.status)],
  ['failed', task => task.status === 'failed'],
  ['paused', task => task.status === 'paused'],
  ['completed', task => task.status === 'completed'],
];
const RESULT_CLASS = { success: 'wb-ok', timeout: 'wb-timeout', failed: 'wb-bad', started: 'wb-running' };

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

export const firstSentence = text => String(text ?? '').split(/(?<=[。！？.!?])\s*|\n/)[0].slice(0, 120);

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
  'invalid_task', 'invalid_json', 'payload_too_large', 'insufficient_scope', 'read_only_proxy', 'unauthorized']);
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
    return [hint, outcome.message].filter(Boolean).join(' · ') || outcome.code;
  }
  return t('wb.schedule.unknownResult');
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

function button(document, text, onClick, className) {
  const node = element(document, 'button', text, className);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

export function mountSchedule({ document = globalThis.document, window = globalThis.window, t = key => key,
  locale = () => 'zh', endpoint = path => path, identity = () => 'local', writable = () => true,
  onOpenGroup = () => {}, fetch = globalThis.fetch, now = Date.now } = {}) {
  const root = document.querySelector('#wb-schedule');
  if (!root) return () => {};
  const guard = createFetchGuard();
  let data = null, error = false, selected = null, history = null, historyGen = 0, form = null, confirmFor = null,
    filter = { status: 'all', target: 'all', query: '' }, owner = identity(), stopped = false, notice = null;
  const level = () => document.documentElement?.dataset?.detail === 'technical' ? 'technical' : 'plain';
  const tz = () => data?.tz ?? null;
  const time = epoch => formatTime(epoch, tz(), locale());
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
    form = null;
    confirmFor = null;
    notice = null;
    root.replaceChildren();
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
  async function refresh({ force = false } = {}) {
    if (!force && !visible()) return;
    reset();
    const gen = guard.next();
    try {
      const value = await read('/api/workbench/schedule');
      if (!guard.current(gen)) return;
      data = value;
      error = false;
    } catch {
      if (!guard.current(gen)) return;
      error = true;
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
      history = { rows: more ? [...(history?.rows ?? []), ...value.rows] : value.rows, next: value.next };
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
    redraw();
    const task = data?.tasks.find(item => item.id === id);
    if (task) loadHistory(task);
  }
  function openForm(task, reenable = false) {
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
          notice = outcome.data?.reenabled ? t('wb.schedule.reenabled') : null;
          redraw();
        } else {
          handle.setMessage(message);
        }
      },
    });
    form = { handle, taskId: task?.id ?? null };
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
    const rate = kpi.successRate7d == null ? '—' : `${Math.round(kpi.successRate7d * 100)}%`;
    for (const [key, value] of [['enabled', kpi.enabled], ['paused', kpi.paused], ['running', kpi.running],
      ['next24h', kpi.next24h], ['runs7d', kpi.runs7d], ['bad7d', kpi.bad7d], ['rate7d', rate]]) {
      const item = element(document, 'span', undefined, 'wb-sched-kpi-item');
      item.append(element(document, 'b', value), element(document, 'small', t('wb.schedule.kpi.' + key)));
      row.append(item);
    }
    if (kpi.partialPreview) row.append(element(document, 'small', t('wb.schedule.partialPreview'), 'wb-sched-note'));
    return row;
  }
  function renderTimeline() {
    const line = element(document, 'div', undefined, 'wb-sched-timeline');
    const start = Math.floor(now() / 1000);
    for (const task of data.tasks) {
      for (const at of task.nextRuns?.in24h ?? []) {
        const dot = button(document, '', () => select(task.id), 'wb-sched-dot');
        dot.title = `${task.name} · ${time(at)}`;
        dot.style.setProperty('left', `${Math.max(0, Math.min(100, (at - start) / 864))}%`);
        line.append(dot);
      }
    }
    return line;
  }
  function renderFilters() {
    const bar = element(document, 'div', undefined, 'wb-sched-filters');
    const status = document.createElement('select');
    for (const value of ['all', 'enabled', 'paused', 'failed', 'completed']) {
      const option = element(document, 'option', t('wb.schedule.filter.' + value));
      option.value = value;
      status.append(option);
    }
    status.value = filter.status;
    status.addEventListener('change', () => {
      filter = { ...filter, status: status.value };
      redraw();
    });
    const target = document.createElement('select');
    const all = element(document, 'option', t('wb.schedule.filter.allTargets'));
    all.value = 'all';
    target.append(all);
    for (const label of [...new Set(data.tasks.map(task => targetLabel(task.target, { t })))].sort()) {
      const option = element(document, 'option', label);
      option.value = label;
      target.append(option);
    }
    target.value = filter.target;
    target.addEventListener('change', () => {
      filter = { ...filter, target: target.value };
      redraw();
    });
    const search = document.createElement('input');
    search.type = 'search';
    search.value = filter.query;
    search.placeholder = t('wb.schedule.search');
    search.addEventListener('change', () => {
      filter = { ...filter, query: search.value };
      redraw();
    });
    bar.append(status, target, search);
    if (writable()) bar.append(button(document, t('wb.schedule.new'), () => openForm(null), 'wb-sched-new'));
    return bar;
  }
  function renderTarget(task) {
    const label = targetLabel(task.target, { t, level: level() });
    if (task.target?.kind !== 'group') return element(document, 'span', label, 'wb-sched-target');
    return button(document, label, event => {
      event?.stopPropagation?.();
      onOpenGroup(task.target.sessionGroup);
    }, 'wb-sched-target');
  }
  function renderRow(task) {
    // A row holds the target-group button, so it is not a button itself.
    const row = element(document, 'div', undefined, 'wb-sched-row' + (task.id === selected ? ' active' : ''));
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.addEventListener('click', () => select(task.id));
    row.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault?.();
      select(task.id);
    });
    const name = element(document, 'span', task.name, 'wb-sched-name');
    name.append(element(document, 'small', firstSentence(task.prompt)));
    const rule = element(document, 'span', scheduleText(task, { t, locale: locale() }), 'wb-sched-rule');
    if (level() === 'technical' && task.cron) rule.append(element(document, 'small', task.cron));
    const upcoming = nextRun(task);
    const next = element(document, 'span', task.nextRuns?.unavailable ? t('wb.schedule.noPreview')
      : upcoming == null ? '—' : `${relativeTime(upcoming, now(), t)} · ${time(upcoming)}`, 'wb-sched-next');
    row.append(name, rule, next, recentCells(document, task.recent, t), renderTarget(task));
    return row;
  }
  function renderHistory(task) {
    const box = element(document, 'div', undefined, 'wb-sched-history');
    box.append(element(document, 'h4', t('wb.schedule.history')));
    if (!history) return box;
    const rows = history.rows;
    const chart = element(document, 'div', undefined, 'wb-sched-bars');
    const peak = Math.max(1, ...rows.slice(0, 30).map(row => row.duration ?? 0));
    for (const run of rows.slice(0, 30).reverse()) {
      const bar = element(document, 'i', undefined, 'wb-sched-bar ' + (RESULT_CLASS[run.status] ?? ''));
      bar.style.setProperty('height', `${Math.max(4, Math.round((run.duration ?? 0) / peak * 100))}%`);
      bar.title = `${time(run.executedAt)} · ${t(resultKey(run.status))}`;
      chart.append(bar);
    }
    box.append(chart);
    const list = element(document, 'ul');
    for (const run of rows.slice(0, history.expanded ? rows.length : 8)) {
      const reason = ['failed', 'timeout'].includes(run.status) && run.error ? ' · ' + run.error : '';
      const seconds = run.duration == null ? '' : ` · ${Math.round(run.duration / 1000)}s`;
      list.append(element(document, 'li', `${time(run.executedAt)} · ${t(resultKey(run.status))}${seconds}${reason}`));
    }
    box.append(list);
    if (history.failed) box.append(element(document, 'p', t('wb.readFailed'), 'wb-sched-note'));
    if (history.next || (!history.expanded && rows.length > 8)) {
      box.append(button(document, t('wb.schedule.loadAll'), () => {
        history.expanded = true;
        if (history.next) loadHistory(task, true);
        else redraw();
      }));
    }
    return box;
  }
  function renderDetail(task) {
    const panel = element(document, 'section', undefined, 'wb-sched-detail');
    const head = element(document, 'div', undefined, 'wb-sched-head');
    head.append(element(document, 'h3', task.name), element(document, 'span', t(statusKey(task.status)), 'wb-sched-status'));
    if (writable()) {
      if (task.status === 'pending') head.append(button(document, t('wb.schedule.pause'), () => act(task, 'pause')));
      if (task.status === 'paused') head.append(button(document, t('wb.schedule.resume'), () => act(task, 'resume')));
      if (!task.reenable) head.append(button(document, t('wb.schedule.edit'), () => openForm(task)));
      head.append(button(document, t('wb.schedule.delete'), () => {
        confirmFor = task.id;
        redraw();
      }));
    }
    head.append(element(document, 'small', t('wb.schedule.updated', { time: time(task.updatedAt) })));
    panel.append(head);
    if (confirmFor === task.id) {
      const confirm = element(document, 'div', undefined, 'wb-sched-confirm');
      confirm.append(element(document, 'p', t('wb.schedule.confirmDelete')),
        button(document, t('wb.schedule.delete'), () => act(task, 'remove'), 'wb-danger'));
      if (task.status === 'pending') confirm.append(button(document, t('wb.schedule.pauseInstead'), () => act(task, 'pause')));
      confirm.append(button(document, t('wb.schedule.cancel'), () => {
        confirmFor = null;
        redraw();
      }));
      panel.append(confirm);
    }
    if (task.reenable && writable()) {
      panel.append(button(document, t('wb.schedule.reenable'), () => openForm(task, true), 'wb-sched-reenable'));
    }
    const rows = history?.rows ?? [];
    const finished = rows.filter(run => run.status !== 'started');
    const rate = finished.length ? `${Math.round(finished.filter(run => run.status === 'success').length / finished.length * 100)}%` : '—';
    const typical = median(finished.map(run => run.duration));
    const numbers = element(document, 'div', undefined, 'wb-sched-kpi');
    for (const [key, value] of [['next', nextRun(task) == null ? '—' : time(nextRun(task))], ['rate', rate],
      ['median', typical == null ? '—' : `${Math.round(typical / 1000)}s`], ['last', time(task.lastRunAt)]]) {
      const item = element(document, 'span', undefined, 'wb-sched-kpi-item');
      item.append(element(document, 'b', value), element(document, 'small', t('wb.schedule.detail.' + key)));
      numbers.append(item);
    }
    panel.append(numbers);
    if (task.showLastError) panel.append(element(document, 'p', t('wb.schedule.lastError', { error: task.lastError ?? t('wb.schedule.result.failed') }), 'wb-sched-error'));
    panel.append(element(document, 'pre', task.prompt, 'wb-sched-prompt'));
    const rule = element(document, 'p', scheduleText(task, { t, locale: locale() }));
    if (level() === 'technical' && task.cron) rule.append(element(document, 'small', ' ' + task.cron));
    panel.append(rule, element(document, 'p', deliveryLine(task, { t, level: level(), locale: locale() }), 'wb-sched-delivery'));
    panel.append(element(document, 'p', t(task.requireIdle ? 'wb.schedule.requireIdle.yes' : 'wb.schedule.requireIdle.no'),
      'wb-sched-idle'));
    const upcoming = task.nextRuns?.unavailable ? t('wb.schedule.noPreview')
      : (task.nextRuns?.runs ?? []).slice(0, 5).map(time).join(' · ') || '—';
    panel.append(element(document, 'p', t('wb.schedule.next5') + ' · ' + upcoming));
    if (level() === 'technical') panel.append(element(document, 'small', `${task.id} · P${task.priority}`, 'wb-sched-tech'));
    panel.append(renderHistory(task));
    return panel;
  }
  function redraw() {
    if (stopped) return;
    const nodes = [];
    const tzLine = data?.tz ? t('wb.schedule.tzFromEnv', { tz: data.tz }) : data ? t('wb.schedule.tzUnknown') : '';
    if (tzLine) nodes.push(element(document, 'p', tzLine, 'wb-sched-tz'));
    if (error) nodes.push(element(document, 'p', t('wb.readFailed'), 'wb-sched-error'));
    if (notice) nodes.push(element(document, 'p', notice, 'wb-sched-notice'));
    if (data && !data.available) nodes.push(element(document, 'p', t('wb.schedule.empty')));
    if (data?.available) {
      nodes.push(renderKpi(), renderTimeline(), renderFilters());
      if (form && form.taskId === null) nodes.push(form.handle.root);
      const sections = groupTasks(data.tasks, { ...filter, t });
      if (!sections.length) nodes.push(element(document, 'p', t('wb.schedule.noMatch')));
      for (const section of sections) {
        const block = element(document, 'section', undefined, 'wb-sched-section');
        block.append(element(document, 'h3', t('wb.schedule.section.' + section.name)));
        for (const task of section.tasks) block.append(renderRow(task));
        nodes.push(block);
      }
      const task = data.tasks.find(item => item.id === selected);
      if (form && form.taskId !== null && form.taskId === task?.id) nodes.push(form.handle.root);
      else if (task) nodes.push(renderDetail(task));
    }
    root.replaceChildren(...nodes);
  }
  const visibility = () => {
    if (document.visibilityState === 'visible') refresh();
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
  toggle?.addEventListener('change', redrawLater);
  window?.addEventListener('popstate', visibility);
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
    toggle?.removeEventListener('change', redrawLater);
    window?.removeEventListener('popstate', visibility);
  };
}
