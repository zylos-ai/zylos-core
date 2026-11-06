import { element, fallbackName } from './plain-text.js?v=82';
import { olderRow } from './older-row.js?v=82';
import { renderOverview } from './detail-overview.js?v=82';
import { createTimelineLoader, renderTimeline } from './detail-timeline.js?v=82';
import { createGroupConfig, fetchJson, renderGroupConfig, responseError } from './group-config.js?v=82';
import { renderNameEditor } from './name-edit.js?v=82';
import { loadNamePrompt, renderAutoName } from './auto-name.js?v=82';

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
  return ['interrupt', 'chop-chop', 'restart'].map(action => ({ action,
    disabled: !writable || !running,
    reason: !writable ? 'wb.readOnly' : !running ? (action === 'restart' ? 'wb.actions.alreadyStopped' : 'wb.actions.targetRequired') : null,
  }));
}

export function groupActionText(value, t = key => key) {
  if (value?.messageKey && !Array.isArray(value.steps)) return t(value.messageKey, value.messageParams);
  if (value?.unknown || value?.submission === 'unknown') return t('wb.actions.unknown');
  if (value?.result === 'already_stopped') return t('wb.actions.alreadyStopped');
  if (value?.result === 'stale_target' || value?.code === 'stale_target' || value?.reason === 'stale_target') {
    return t('wb.actions.staleTarget', { runId: value.currentRunId ?? '' });
  }
  if (Array.isArray(value?.steps)) return value.steps.map((step, index) => `${index + 1}: ${groupActionText(step, t)}`).join(' · ');
  if (value?.ok === false || value?.error) return responseError(value, value.code ?? value.reason ?? value.rejectionCode ?? 'rejected');
  return String(value?.result ?? value?.submission ?? value?.code ?? value?.reason ?? t('wb.actions.submitted'));
}

export function createGroupDetail({ root, document = root.ownerDocument, fetch = globalThis.fetch,
  t = key => key, writable = () => true, detail = () => 'plain', identity = () => '',
  onClose = () => {}, onMemory = () => {}, onRename = () => {}, confirm = globalThis.confirm,
  clipboard = globalThis.navigator?.clipboard, schedule = setInterval, cancel = clearInterval,
  isVisible = () => document.visibilityState !== 'hidden', now = Date.now } = {}) {
  const state = { row: null, snapshot: null, historical: false, tab: 'overview', recent: [], backlog: null,
    totalEvents: 0, totalRuns: 0, currentEvents: [], error: null, lastSuccess: null,
    configOpen: false, nameOpen: false, nameDraft: '', actionResult: '', actionBusy: false, autoName: null };
  let generation = 0, controller = null, timer = null, owner = null, config = null, stopped = false;
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
      if (value.currentRunId) state.currentEvents = value.currentEvents;
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
      ? [row.sessionGroup ?? 'origin', row.live?.runId, row.createdAt, row.launchConfig?.runtime, row.launchConfig?.model, row.launchConfig?.effort].filter(value => value != null).join(' · ')
      : platform + ' · ' + (row.createdAt == null ? t('wb.unknown') : t('wb.detail.continuous', { minutes: uptime }));
    const tabs = element(document, 'nav', undefined, 'wb-detail-tabs');
    for (const tab of ['overview', 'timeline']) {
      const button = element(document, 'button', t('wb.detail.' + tab) + (tab === 'timeline' ? ` ${state.totalEvents}` : ''));
      button.type = 'button'; button.setAttribute('aria-selected', String(state.tab === tab));
      button.addEventListener('click', () => { state.tab = tab; draw(); }); tabs.append(button);
    }
    const body = element(document, 'div', undefined, 'wb-detail-body');
    if (state.tab === 'overview') {
      const sections = renderOverview(body, row, state, { document, t, level: getLevel(), snapshot: state.snapshot,
        onTimeline: () => { state.tab = 'timeline'; draw(); }, onMemory: () => onMemory(row.sessionGroup),
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
    if (state.autoName) {
      const modal = element(document, 'div', undefined, 'wb-auto-name');
      renderAutoName(modal, state.autoName, { document, t, clipboard, onClose: () => { state.autoName = null; draw(); } });
      body.append(modal);
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
        body: JSON.stringify({ runId: row.live?.runId, sessionId: row.live?.sessionId ?? null }),
      });
      if (active(gen)) state.actionResult = groupActionText(value, t);
    } catch (error) {
      if (active(gen) && error.name !== 'AbortError') state.actionResult = error.body ? groupActionText(error.body, t) : t('wb.actions.unknown');
    } finally { if (active(gen)) { state.actionBusy = false; draw(); } }
  }
  async function refresh({ readRuns = true } = {}) {
    invalidateOwner();
    if (!controller || !active(generation) || !isVisible()) return;
    const gen = generation, key = state.row.sessionGroup ?? 'origin';
    const query = new URLSearchParams({ session_group: state.row.sessionGroup ?? '', order: 'desc', limit: '5' });
    const values = await Promise.allSettled([
      request('/api/timeline?' + query),
      request(`/api/workbench/groups/${encodeURIComponent(key)}/backlog`),
      readRuns ? request(`/api/workbench/groups/${encodeURIComponent(key)}/runs?limit=3`) : Promise.resolve(null),
    ]);
    if (!active(gen)) return;
    if (values[0].status === 'fulfilled') state.recent = values[0].value.events ?? [];
    if (values[1].status === 'fulfilled') state.backlog = values[1].value;
    if (values[2].status === 'fulfilled' && values[2].value) {
      state.totalEvents = values[2].value.totalEvents;
      state.totalRuns = values[2].value.totalRuns;
    }
    const failure = values.find(value => value.status === 'rejected');
    state.error = failure?.reason?.message ?? null;
    if (!failure) state.lastSuccess = now();
    draw();
    if (!timeline.state.open) await timeline.open(state.row.sessionGroup, state.row.live?.runId);
    else await timeline.refresh({ overview: state.tab === 'overview' });
  }
  function close() {
    controller?.abort(); controller = null; generation++;
    timeline.close();
    if (timer != null) cancel(timer); timer = null;
    state.row = null; state.tab = 'overview'; state.recent = []; state.currentEvents = [];
    state.totalEvents = state.totalRuns = 0; state.backlog = null; state.error = null;
    state.configOpen = state.nameOpen = false; state.autoName = null;
    state.actionResult = ''; state.actionBusy = false;
    root.hidden = true; root.replaceChildren(); onClose();
  }
  return {
    state, timeline, refresh, close, act,
    async open(selection, snapshot = {}) {
      close(); stopped = false; controller = new AbortController(); owner = identity();
      const selected = resolveDetailRow(selection, snapshot);
      state.row = selected.row; state.historical = selected.historical; state.snapshot = snapshot;
      const gen = generation, key = state.row.sessionGroup ?? 'origin';
      config = createGroupConfig({ key, request, t, active: () => active(gen), onChange: draw });
      draw();
      const loading = isVisible() ? Promise.all([timeline.open(state.row.sessionGroup, state.row.live?.runId), refresh({ readRuns: false })]) : Promise.resolve();
      timer = schedule(refresh, 5000);
      await loading;
    },
    updateSnapshot(snapshot) {
      invalidateOwner();
      if (!controller) return;
      state.snapshot = snapshot;
      const previousRun = state.row.live?.runId;
      if (!state.historical) state.row = snapshot.rows?.find(row => row.sessionGroup === state.row.sessionGroup) ??
        olderRow(state.row.sessionGroup, { name: state.row.name, listKnown: snapshot.listKnown });
      if (previousRun !== state.row.live?.runId && isVisible()) {
        state.currentEvents = [];
        void timeline.open(state.row.sessionGroup, state.row.live?.runId);
      }
      draw();
    },
    setViewDetail() { draw(); },
    async autoName() {
      invalidateOwner();
      if (!controller || !getWritable()) return;
      try { state.autoName = await loadNamePrompt({ request }); draw(); }
      catch (error) { if (error.name !== 'AbortError') { state.error = error.message; draw(); } }
    },
    destroy() { close(); stopped = true; },
  };
}
