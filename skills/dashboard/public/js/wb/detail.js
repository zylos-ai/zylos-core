import { element, fallbackName } from './plain-text.js?v=83';
import { olderRow } from './older-row.js?v=83';
import { renderOverview } from './detail-overview.js?v=83';
import { createTimelineLoader, renderTimeline } from './detail-timeline.js?v=83';
import { createGroupConfig, fetchJson, renderGroupConfig, responseError } from './group-config.js?v=83';
import { renderNameEditor } from './name-edit.js?v=83';

export function resolveDetailRow(selection, snapshot = {}) {
  const item = typeof selection === 'string' || selection == null ? { sessionGroup: selection } : selection;
  const key = item.sessionGroup;
  const found = snapshot.rows?.find(row => row.sessionGroup === key);
  if (found) return { row: found, historical: false };
  if (item.state && Object.hasOwn(item, 'live')) return { row: item, historical: true };
  const name = typeof item.name === 'string' ? { displayName: item.name } : item.name;
  return { row: olderRow(key, { name, listKnown: snapshot.listKnown }), historical: true };
}

export function groupActionButtons(row, writable = true) {
  const running = ['running', 'starting'].includes(row.presence) && Boolean(row.live?.runId);
  const origin = row.sessionGroup == null || row.sessionGroup === 'origin';
  return ['interrupt', 'chop-chop', 'restart'].map(action => ({ action,
    disabled: !writable || (!running && !(origin && action === 'restart')),
    reason: !writable ? 'wb.readOnly' : !running && !(origin && action === 'restart')
      ? (action === 'restart' ? 'wb.actions.alreadyStopped' : 'wb.actions.targetRequired') : null,
  }));
}

export function groupActionText(value, t = key => key) {
  if (value?.messageKey && !Array.isArray(value.steps)) return t(value.messageKey, value.messageParams);
  if (value?.submission === 'not_submitted') {
    const reason = value.reason ?? (value.error ? responseError(value) : '');
    return t('wb.actions.notSubmitted') + (reason ? ' · ' + reason : '');
  }
  if (value?.unknown || value?.submission === 'unknown') return t('wb.actions.unknown');
  if (value?.result === 'already_stopped') return t('wb.actions.alreadyStopped');
  if (value?.result === 'stale_target' || value?.code === 'stale_target' || value?.reason === 'stale_target') {
    return t('wb.actions.staleTarget', { runId: value.currentRunId ?? '' });
  }
  if (Array.isArray(value?.steps)) return value.steps.map((step, index) => `${index + 1}: ${groupActionText(step, t)}`).join(' · ');
  if (value?.ok === false || value?.error) return responseError(value, value.code ?? value.reason ?? value.rejectionCode ?? 'rejected');
  const result = value?.result ?? value?.submission;
  if (['accepted', 'submitted'].includes(result)) return t('wb.actions.' + result);
  return String(result ?? value?.code ?? value?.reason ?? t('wb.actions.submitted'));
}

export function formatStartedAt(value, locale) {
  if (value == null) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(locale || undefined) : null;
}

export function createGroupDetail({ root, document = root.ownerDocument, fetch = globalThis.fetch,
  t = key => key, writable = () => true, detail = () => 'plain', identity = () => '',
  onClose = () => {}, onMemory = () => {}, onRename = () => {}, confirm = globalThis.confirm,
  isVisible = () => document.visibilityState !== 'hidden', now = Date.now } = {}) {
  const state = { row: null, snapshot: null, historical: false, tab: 'overview', recent: [], backlog: null,
    totalEvents: 0, totalRuns: 0, currentEvents: [], error: null, lastSuccess: null,
    configOpen: false, nameOpen: false, nameDraft: '', actionResult: '', actionBusy: false };
  let generation = 0, controller = null, owner = null, config = null, stopped = false, refreshTask = null;
  let subagentRun = null, subagentCursor = 0, subagentReady = false, subagentController = null;
  const getWritable = () => typeof writable === 'function' ? writable() : writable;
  const getLevel = () => typeof detail === 'function' ? detail() : detail;
  const active = gen => !stopped && controller != null && !controller.signal.aborted && generation === gen && owner === identity();
  function invalidateOwner() {
    if (controller && owner !== identity()) close();
  }
  async function request(path, options = {}) {
    const gen = generation;
    if (!active(gen)) { invalidateOwner(); throw Object.assign(new Error('view_changed'), { name: 'AbortError' }); }
    const value = await fetchJson(fetch, path, { ...options, signal: options.signal ?? controller.signal });
    if (!active(gen)) { invalidateOwner(); throw Object.assign(new Error('view_changed'), { name: 'AbortError' }); }
    return value;
  }
  const timeline = createTimelineLoader({ request, now, active: () => active(generation),
    onChange(value) {
      state.totalEvents = value.totalEvents;
      state.totalRuns = value.totalRuns;
      draw();
    },
    onError: () => {},
  });
  function draw() {
    if (!controller || !active(generation) || !state.row) return;
    const row = state.row;
    const key = row.sessionGroup ?? 'origin';
    const header = element(document, 'header', undefined, 'wb-detail-header');
    const title = row.sessionGroup == null ? t('wb.single') : row.name?.displayName ?? fallbackName(row, t);
    header.append(element(document, 'h2', title), element(document, 'span', t('wb.state.' + (row.state?.kind ?? 'unknown')), 'wb-detail-state'));
    if (row.sessionGroup !== 'origin' && row.sessionGroup != null) {
      const rename = element(document, 'button', '✎'); rename.type = 'button'; rename.disabled = !getWritable();
      rename.setAttribute('aria-label', t('wb.name.edit'));
      rename.addEventListener('click', () => { state.nameOpen = true; state.nameDraft = row.name?.displayName ?? ''; draw(); });
      header.append(rename);
    }
    for (const item of groupActionButtons(row, getWritable())) {
      const button = element(document, 'button', t('wb.actions.' + item.action)); button.type = 'button';
      button.disabled = item.disabled || state.actionBusy;
      if (item.reason) button.title = t(item.reason);
      button.addEventListener('click', () => act(item.action)); header.append(button);
      if (item.reason) header.append(element(document, 'small', t(item.reason), 'wb-action-reason'));
    }
    const closeButton = element(document, 'button', t('wb.close')); closeButton.type = 'button'; closeButton.addEventListener('click', close);
    header.append(closeButton);
    const previousScroll = root.querySelector?.('.wb-detail-timeline')?.scrollTop ?? 0;
    const uptime = row.createdAt == null ? t('wb.unknown') : Math.max(0, Math.floor((now() - row.createdAt * 1000) / 60000));
    const platformKey = row.sessionGroup?.split(':')[0];
    const platform = row.sessionGroup == null ? t('wb.single') : row.sessionGroup === 'origin' ? t('wb.term.origin')
      : fallbackName({ ...row, sessionGroup: platformKey, name: null }, t);
    const meta = getLevel() === 'technical'
      ? [row.sessionGroup ?? 'origin', row.live?.runId, formatStartedAt(row.createdAt, document.documentElement?.lang), row.launchConfig?.runtime, row.launchConfig?.model, row.launchConfig?.effort].filter(value => value != null).join(' · ')
      : platform + ' · ' + (row.createdAt == null ? t('wb.unknown') : t('wb.detail.continuous', { minutes: uptime }));
    const tabs = element(document, 'nav', undefined, 'wb-detail-tabs');
    for (const tab of ['overview', 'timeline']) {
      const button = element(document, 'button', t('wb.detail.' + tab) + (tab === 'timeline' ? ` ${state.totalEvents}` : ''));
      button.type = 'button'; button.setAttribute('aria-selected', String(state.tab === tab));
      button.addEventListener('click', () => { void selectTab(tab); }); tabs.append(button);
    }
    const body = element(document, 'div', undefined, 'wb-detail-body');
    if (state.tab === 'overview') {
      const sections = renderOverview(body, row, state, { document, t, level: getLevel(), snapshot: state.snapshot,
        onTimeline: () => { void selectTab('timeline'); }, onMemory: () => onMemory(row.sessionGroup),
        onConfig: async () => {
          if (state.configOpen) { state.configOpen = false; draw(); return; }
          state.configOpen = true; draw();
          try { await config.load(); } catch (error) { if (error.name !== 'AbortError') { config.state.error = error.message; draw(); } }
        },
      });
      if (state.configOpen) renderGroupConfig(sections.config, config, { document, t, writable: getWritable() });
    } else {
      body.classList.add('wb-detail-timeline');
      renderTimeline(body, timeline, { document, t });
    }
    if (state.nameOpen) {
      const editor = element(document, 'div', undefined, 'wb-name-editor');
      const gen = generation;
      renderNameEditor(editor, { key, name: state.nameDraft, request, document, t, writable: getWritable(), active: () => active(gen),
        onInput: value => { state.nameDraft = value; }, onCancel: () => { state.nameOpen = false; draw(); },
        onSave: value => { state.row = { ...state.row, name: value }; state.nameOpen = false; onRename(value); draw(); },
      });
      body.append(editor);
    }
    root.replaceChildren(header, element(document, 'p', meta, 'wb-detail-meta'), tabs, body);
    if (state.tab === 'timeline') body.scrollTop = previousScroll;
    if (state.error) root.append(element(document, 'p', t('wb.readFailed') + ' · ' + state.error, 'wb-detail-error'));
    if (state.actionResult) root.append(element(document, 'p', state.actionResult, 'wb-action-result'));
    root.hidden = false;
  }
  async function act(action) {
    if (!state.row || state.actionBusy || groupActionButtons(state.row, getWritable()).find(item => item.action === action)?.disabled) return;
    const confirmation = state.row.sessionGroup == null || state.row.sessionGroup === 'origin'
      ? 'confirm.restart' : 'wb.actions.restartConfirm';
    if (action === 'restart' && !await confirm?.(t(confirmation))) return;
    const gen = generation;
    const row = state.row;
    state.actionBusy = true; draw();
    try {
      const value = await request(`/api/workbench/groups/${encodeURIComponent(row.sessionGroup ?? 'origin')}/actions/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionGroup: row.sessionGroup, runId: row.live?.runId, sessionId: row.live?.sessionId ?? null }),
      });
      if (active(gen)) state.actionResult = groupActionText(value, t);
    } catch (error) {
      if (active(gen) && error.name !== 'AbortError') state.actionResult = error.body ? groupActionText(error.body, t) : t('wb.actions.unknown');
    } finally { if (active(gen)) { state.actionBusy = false; draw(); } }
  }
  function rememberSubagents(events) {
    const agents = new Map(state.currentEvents.map(event => [event.agent_id ?? event.metadata?.agent_id, event]));
    for (const event of [...events].sort((a, b) => (a.event_seq ?? 0) - (b.event_seq ?? 0))) {
      if (event.run_id !== state.row.live?.runId) continue;
      const id = event.agent_id ?? event.metadata?.agent_id;
      if (id == null) continue;
      const previous = agents.get(id);
      if (previous?.event_seq != null && event.event_seq != null && previous.event_seq > event.event_seq) continue;
      if (['subagent_start', 'subagent_stop'].includes(event.event_type)) agents.set(id, event);
    }
    state.currentEvents = [...agents.values()];
  }
  function resetSubagents() {
    subagentController?.abort();
    subagentController = null;
    subagentRun = null;
    subagentCursor = 0;
    subagentReady = false;
    state.currentEvents = [];
  }
  async function loadSubagents() {
    const runId = state.row.live?.runId;
    if (!runId) return;
    if (subagentRun !== runId) {
      resetSubagents();
      subagentRun = runId;
      subagentController = new AbortController();
    }
    const signal = subagentController.signal;
    const initial = !subagentReady;
    // Only the first attempt may paginate. A failed initial read resumes one
    // page per board snapshot, so recovery cannot restart unbounded work.
    subagentReady = true;
    do {
      const query = new URLSearchParams({ session_group: state.row.sessionGroup ?? '', run_id: runId,
        types: 'subagent_start,subagent_stop', order: 'asc', limit: '1000' });
      if (subagentCursor || !initial) query.set('after_seq', String(subagentCursor));
      const value = await request('/api/timeline?' + query, { signal });
      if (signal.aborted || state.row?.live?.runId !== runId) return;
      const events = value.events ?? [];
      rememberSubagents(events);
      const next = events.at(-1)?.event_seq;
      if (events.length && (!Number.isFinite(next) || next <= subagentCursor)) throw new Error('timeline_cursor_invalid');
      if (events.length) subagentCursor = next;
      if (events.length < 1000) return;
    } while (initial);
  }
  async function selectTab(tab) {
    invalidateOwner();
    if (!controller || !active(generation)) return;
    state.tab = tab === 'timeline' ? 'timeline' : 'overview';
    draw();
    if (state.tab === 'timeline' && isVisible()) {
      if (!timeline.state.open) await timeline.open(state.row.sessionGroup, state.row.live?.runId);
      else await timeline.refresh();
    }
  }
  function refresh() {
    invalidateOwner();
    if (!controller || !active(generation) || !isVisible()) return Promise.resolve();
    if (refreshTask) return refreshTask;
    const gen = generation, key = state.row.sessionGroup ?? 'origin', runId = state.row.live?.runId;
    const query = new URLSearchParams({ session_group: state.row.sessionGroup ?? '', order: 'desc', limit: '5' });
    const task = (async () => {
      const values = await Promise.allSettled([
        request('/api/timeline?' + query),
        request(`/api/workbench/groups/${encodeURIComponent(key)}/backlog`),
        request(`/api/workbench/groups/${encodeURIComponent(key)}/runs?limit=3`),
        loadSubagents(),
      ]);
      if (!active(gen) || state.row.live?.runId !== runId) return;
      if (values[0].status === 'fulfilled') {
        state.recent = values[0].value.events ?? [];
      }
      if (values[1].status === 'fulfilled') state.backlog = values[1].value;
      if (values[2].status === 'fulfilled') {
        state.totalEvents = values[2].value.totalEvents;
        state.totalRuns = values[2].value.totalRuns;
        if (timeline.state.open) timeline.updateRuns(values[2].value);
      }
      const failure = values.find(value => value.status === 'rejected');
      state.error = failure?.reason?.message ?? null;
      if (!failure) state.lastSuccess = now();
      draw();
      if (state.tab === 'timeline') {
        if (!timeline.state.open) await timeline.open(state.row.sessionGroup, state.row.live?.runId);
        else await timeline.refresh();
      }
    })();
    refreshTask = task;
    void task.finally(() => { if (refreshTask === task) refreshTask = null; });
    return task;
  }
  function close() {
    controller?.abort(); controller = null; generation++;
    timeline.close();
    resetSubagents();
    refreshTask = null;
    state.row = null; state.tab = 'overview'; state.recent = []; state.currentEvents = [];
    state.totalEvents = state.totalRuns = 0; state.backlog = null; state.error = null;
    state.configOpen = state.nameOpen = false;
    state.actionResult = ''; state.actionBusy = false;
    root.hidden = true; root.replaceChildren(); onClose();
  }
  return {
    state, timeline, refresh, close, act, selectTab,
    async open(selection, snapshot = {}) {
      close(); stopped = false; controller = new AbortController(); owner = identity();
      const selected = resolveDetailRow(selection, snapshot);
      state.row = selected.row; state.historical = selected.historical; state.snapshot = snapshot;
      const gen = generation, key = state.row.sessionGroup ?? 'origin';
      config = createGroupConfig({ key, request, t, active: () => active(gen), onChange: draw });
      draw();
      await refresh();
    },
    async updateSnapshot(snapshot) {
      invalidateOwner();
      if (!controller) return;
      state.snapshot = snapshot;
      const previousRun = state.row.live?.runId;
      if (!state.historical) state.row = snapshot.rows?.find(row => row.sessionGroup === state.row.sessionGroup) ??
        olderRow(state.row.sessionGroup, { name: state.row.name, listKnown: snapshot.listKnown });
      if (previousRun !== state.row.live?.runId) {
        resetSubagents();
        timeline.close();
      }
      draw();
      await refresh();
    },
    setViewDetail() { draw(); },
    destroy() { close(); stopped = true; },
  };
}
