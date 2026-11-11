import { listen, reconcileChildren } from './detail-update.js?v=158';
import { element, fallbackName, icon, runtimeName } from './plain-text.js?v=106';
import { olderRow } from './older-row.js?v=85';
import { channelIcon, platformLabel, statePill } from './board.js?v=152';
import { groupEventCount, rawKey, renderOverview } from './detail-overview.js?v=162';
import { createTimelineLoader, renderTimeline } from './detail-timeline.js?v=162';
import { eventTypesFor, recentWindow } from './timeline-rows.js?v=108';
import { createGroupConfig, fetchJson, renderGroupConfig, responseError } from './group-config.js?v=115';
import { renderNameEditor } from './name-edit.js?v=115';
import { formatZoned, zonedDay } from './instance-zone.js?v=100';

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

const actionIcons = { interrupt: 'stop', 'chop-chop': 'nudge', restart: 'restart' };

/** In-page confirmation in the dashboard's own style; resolves true only on the explicit action. */
export function confirmDialog(document, { title, body, ok, cancel, danger = true }) {
  if (!document.body) return Promise.resolve(Boolean(globalThis.confirm?.(body)));
  return new Promise(resolve => {
    const backdrop = element(document, 'div', undefined, 'wb-modal-bg');
    const dialog = element(document, 'div', undefined, 'wb-modal');
    dialog.setAttribute('role', 'alertdialog'); dialog.setAttribute('aria-modal', 'true');
    const no = element(document, 'button', cancel, 'wb-btn'), yes = element(document, 'button', ok, danger ? 'wb-btn wb-btn-danger' : 'wb-btn wb-btn-primary');
    no.type = yes.type = 'button';
    const actions = element(document, 'div', undefined, 'wb-modal-acts'); actions.append(no, yes);
    dialog.append(element(document, 'h3', title), element(document, 'p', body), actions);
    backdrop.append(dialog);
    const previous = document.activeElement;
    const finish = value => {
      document.removeEventListener('keydown', keydown, true);
      backdrop.remove(); previous?.focus?.(); resolve(value);
    };
    const keydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); } };
    no.addEventListener('click', () => finish(false)); yes.addEventListener('click', () => finish(true));
    backdrop.addEventListener('click', event => { if (event.target === backdrop) finish(false); });
    document.addEventListener('keydown', keydown, true);
    document.body.append(backdrop); no.focus();
  });
}

export function formatStartedAt(value, locale) {
  if (value == null) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? formatZoned(date, locale) : null;
}

/** The plain header line: the engine and when this run started (the time alone today, with the date otherwise). */
export function plainMeta(row, t = key => key, { now = Date.now(), locale } = {}) {
  const runtime = row.launchConfig?.runtime ?? row.target?.runtime;
  const date = row.createdAt == null ? null : new Date(row.createdAt * 1000);
  const started = date && Number.isFinite(date.getTime()) ? t('wb.detail.startedAt', { time: formatZoned(date, locale,
    zonedDay(date) === zonedDay(now) ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }) : null;
  return [runtime ? runtimeName(runtime) : null, started].filter(Boolean).join(' · ');
}

export function createGroupDetail({ root, document = root.ownerDocument, fetch = globalThis.fetch,
  t = key => key, writable = () => true, detail = () => 'plain', identity = () => '', showLastReceived = true,
  onClose = () => {}, onMemory = () => {}, onRename = () => {}, onConversation, confirm, observable = () => false, onObserve = () => {},
  isVisible = () => document.visibilityState !== 'hidden', now = Date.now } = {}) {
  const state = { row: null, snapshot: null, historical: false, tab: 'overview', recent: [], backlog: null,
    totalEvents: 0, totalRuns: 0, unattributed: 0, currentEvents: [], error: null, lastSuccess: null, level: null,
    configOpen: false, nameOpen: false, nameDraft: '', actionResult: '', actionBusy: false };
  let generation = 0, controller = null, owner = null, config = null, stopped = false, refreshTask = null;
  let renderedLevel = null, configRevision = 0;
  let subagentRun = null, subagentCursor = 0, subagentReady = false, subagentController = null;
  const getWritable = () => typeof writable === 'function' ? writable() : writable;
  const getLevel = () => typeof detail === 'function' ? detail() : detail;
  const readLevel = () => getLevel() === 'technical' ? 'technical' : 'plain';
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
  const timeline = createTimelineLoader({ request, now, active: () => active(generation), detail: readLevel,
    onChange(value) {
      state.totalEvents = value.totalEvents;
      state.totalRuns = value.totalRuns;
      state.unattributed = value.unattributed ?? 0;
      draw();
    },
    onError: () => {},
  });
  function draw({ reset = false } = {}) {
    if (!controller || !active(generation) || !state.row) return;
    const row = state.row;
    const key = row.sessionGroup ?? 'origin';
    const header = element(document, 'header', undefined, 'wb-detail-header wb-group-head');
    const top = element(document, 'div', undefined, 'wb-d-top');
    const title = row.sessionGroup == null ? t('wb.single') : row.name?.displayName ?? fallbackName(row, t);
    const box = element(document, 'span', undefined, 'wb-ch'); box.append(icon(document, channelIcon(row)));
    const heading = element(document, 'div', undefined, 'wb-d-title-wrap');
    heading.append(element(document, 'h2', title, 'wb-d-title'));
    if (row.sessionGroup !== 'origin' && row.sessionGroup != null) {
      const rename = element(document, 'button', undefined, 'wb-icon-btn wb-icon-btn-sm'); rename.type = 'button'; rename.disabled = !getWritable();
      rename.setAttribute('aria-label', t('wb.name.edit')); rename.title = getWritable() ? t('wb.name.edit') : t('wb.readOnly');
      rename.append(icon(document, 'edit', 'xs'));
      listen(rename, 'click', () => { state.nameOpen = true; state.nameDraft = row.name?.displayName ?? ''; draw(); });
      heading.append(rename);
    }
    // State and actions share one wrapper: on phones it becomes the second row under the title.
    const sub = element(document, 'div', undefined, 'wb-d-sub');
    sub.append(statePill(document, row, { t, level: getLevel() }));
    top.append(box, heading, sub);
    const actions = element(document, 'div', undefined, 'wb-d-acts');
    // Opening the conversation is the main action, so it leads the action row.
    if (typeof onConversation === 'function' && row.sessionGroup && row.sessionGroup !== 'origin') {
      const conversation = element(document, 'button', undefined, 'wb-btn wb-btn-primary wb-d-conv');
      conversation.append(element(document, 'span', t('chat.page.viewConversation'), 'wb-conv-label'));
      conversation.type = 'button';
      conversation.dataset.action = 'viewConversation';
      listen(conversation, 'click', () => onConversation(row));
      actions.append(conversation);
    }
    for (const item of groupActionButtons(row, getWritable())) {
      const button = element(document, 'button', undefined, 'wb-icon-btn wb-act'); button.type = 'button';
      button.disabled = item.disabled || state.actionBusy;
      button.dataset.wbAction = item.action;
      button.setAttribute('aria-label', t('wb.actions.' + item.action));
      // Unavailable actions stay visible and say why in their tooltip; narrow screens also show the label.
      button.title = t('wb.actions.' + item.action) + (item.reason ? ' · ' + t(item.reason) : '');
      button.append(icon(document, actionIcons[item.action]), element(document, 'span', t('wb.actions.' + item.action), 'wb-act-label'));
      listen(button, 'click', () => act(item.action)); actions.append(button);
    }
    const closeButton = element(document, 'button', undefined, 'wb-icon-btn'); closeButton.type = 'button';
    closeButton.setAttribute('aria-label', t('wb.close')); closeButton.title = t('wb.closeEsc');
    closeButton.append(icon(document, 'x')); listen(closeButton, 'click', close);
    sub.append(actions); top.append(closeButton);
    header.append(top);
    const platform = row.sessionGroup == null ? t('wb.single') : row.sessionGroup === 'origin' ? t('wb.term.origin') : platformLabel(row, t, { describe: false });
    // Technical: the group key in monospace, then run, start and launch configuration.
    const meta = element(document, 'p', undefined, 'wb-detail-meta');
    if (getLevel() === 'technical') {
      meta.append(element(document, 'span', row.sessionGroup ?? 'origin', 'wb-mono'));
      const rest = [row.live?.runId, formatStartedAt(row.createdAt, document.documentElement?.lang), ...(row.launchConfig ? [runtimeName(row.launchConfig.runtime), row.launchConfig.model, row.launchConfig.effort]
        : row.target?.reason === 'launch_config_unreadable' ? [runtimeName(row.target.runtime), t('wb.detail.launchConfigUnreadable')] : [])].filter(value => value != null);
      if (rest.length) meta.append(element(document, 'span', ' · ' + rest.join(' · ')));
    } else meta.textContent = plainMeta(row, t, { now: now(), locale: document.documentElement?.lang }) || platform;
    const tabs = element(document, 'nav', undefined, 'wb-detail-tabs');
    tabs.setAttribute('role', 'tablist');
    for (const tab of ['overview', 'timeline']) {
      const button = element(document, 'button', t('wb.detail.' + tab));
      if (tab === 'timeline') button.append(element(document, 'span', ` ${groupEventCount(state)}`, 'wb-n'));
      button.type = 'button'; button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(state.tab === tab));
      listen(button, 'click', () => { void selectTab(tab); }); tabs.append(button);
    }
    const body = element(document, 'div', undefined, 'wb-detail-body');
    const observe = observable(row) ? view => onObserve(key, view) : null;
    if (state.tab === 'overview') {
      const sections = renderOverview(body, row, state, { document, t, level: getLevel(), snapshot: state.snapshot, currentTime: now(), showLastReceived,
        onTimeline: () => { void selectTab('timeline'); }, onMemory: () => onMemory(row.sessionGroup), onObserve: observe,
        onRaw: open => { void openRaw(row, open); },
        onConfig: async () => {
          if (state.configOpen) { state.configOpen = false; draw(); return; }
          state.configOpen = true; draw();
          try {
            const value = await config.load();
            await config.loadMeta(value?.runtime?.data?.resolved?.runtime ?? 'claude');
          } catch (error) { if (error.name !== 'AbortError') { config.state.error = error.message; draw(); } }
        },
      });
      if (state.configOpen) {
        renderGroupConfig(sections.config, config, { document, t, writable: getWritable(), rotationThreshold: row.rotationThreshold,
          onCancel: () => { state.configOpen = false; draw(); } });
        // Form handlers own their field references. A controller publication
        // changes the form; ordinary board snapshots keep the mounted editor.
        const form = [...sections.config.children].find(node => node.classList.contains('wb-cfg-edit'));
        if (form) form.dataset.updateKey = `config:${configRevision}:${getWritable()}:${row.rotationThreshold}`;
      }
    } else {
      body.classList.add('wb-detail-timeline');
      renderTimeline(body, timeline, { document, t, level: getLevel(), onObserve: observe });
    }
    if (state.nameOpen) {
      const editor = element(document, 'div', undefined, 'wb-name-editor');
      editor.dataset.updateKey = 'name:' + getWritable();
      header.append(editor);
      const gen = generation;
      renderNameEditor(editor, { key, name: state.nameDraft, request, document, t, writable: getWritable(), active: () => active(gen),
        onInput: value => { state.nameDraft = value; }, onCancel: () => { state.nameOpen = false; draw(); },
        onSave: value => { state.row = { ...state.row, name: value }; state.nameOpen = false; onRename(value); draw(); },
      });
    }
    header.append(meta, tabs);
    if (state.error) header.append(element(document, 'p', t('wb.readFailed') + ' · ' + state.error, 'wb-detail-error'));
    if (state.actionResult) header.append(element(document, 'p', state.actionResult, 'wb-action-result'));
    const level = getLevel();
    if (reset || renderedLevel !== level || !root.firstChild) root.replaceChildren(header, body);
    else {
      const desired = element(document, 'div'); desired.append(header, body);
      reconcileChildren(root, desired);
    }
    renderedLevel = level;
    root.hidden = false;
  }
  // The stored message of a labelled preview is read when its fold opens, once per preview; a failed read is retried
  // on the next opening.
  async function openRaw(row, open) {
    const key = rawKey(row);
    if (state.raw?.key !== key) state.raw = { key, open: false, status: 'idle', text: null };
    const raw = state.raw;
    if (raw.open === open) return;
    raw.open = open;
    if (!open) return;
    if (raw.status !== 'error' && raw.status !== 'idle') { draw(); return; }
    raw.status = 'loading'; draw();
    try {
      const value = await request(`/api/workbench/groups/${encodeURIComponent(row.sessionGroup ?? 'origin')}/raw`);
      if (state.raw !== raw) return;
      raw.status = 'ok'; raw.text = typeof value?.raw === 'string' ? value.raw : null;
    } catch (error) {
      if (error.name === 'AbortError' || state.raw !== raw) return;
      raw.status = 'error';
    }
    draw();
  }
  async function act(action) {
    if (!state.row || state.actionBusy || groupActionButtons(state.row, getWritable()).find(item => item.action === action)?.disabled) return;
    const confirmation = state.row.sessionGroup == null || state.row.sessionGroup === 'origin'
      ? 'confirm.restart' : 'wb.actions.restartConfirm';
    if (action === 'restart' && !await (confirm ? confirm(t(confirmation)) : confirmDialog(document, { title: t('wb.actions.restartTitle'),
      body: t(confirmation), ok: t('wb.actions.restart'), cancel: t('wb.cancel') }))) return;
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
    const nextTab = tab === 'timeline' ? 'timeline' : 'overview';
    const reset = state.tab !== nextTab;
    state.tab = nextTab;
    draw({ reset });
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
    // Recent activity and the event counts cover plain events only, unless technical detail is on.
    const level = state.level = readLevel(), types = eventTypesFor('all', level);
    // Read a window larger than the rows shown so merged repeats count every event in it.
    const query = new URLSearchParams({ session_group: state.row.sessionGroup ?? '', order: 'desc', limit: String(recentWindow) });
    const runsQuery = new URLSearchParams({ limit: '3' });
    if (types?.length) { query.set('types', types.join(',')); runsQuery.set('types', types.join(',')); }
    const task = (async () => {
      const values = await Promise.allSettled([
        request('/api/timeline?' + query),
        request(`/api/workbench/groups/${encodeURIComponent(key)}/backlog`),
        request(`/api/workbench/groups/${encodeURIComponent(key)}/runs?` + runsQuery),
        loadSubagents(),
      ]);
      if (!active(gen) || state.row.live?.runId !== runId || readLevel() !== level) return;
      if (values[0].status === 'fulfilled') {
        state.recent = values[0].value.events ?? [];
      }
      if (values[1].status === 'fulfilled') state.backlog = values[1].value;
      if (values[2].status === 'fulfilled') {
        state.totalEvents = values[2].value.totalEvents;
        state.totalRuns = values[2].value.totalRuns;
        state.unattributed = values[2].value.unattributed ?? 0;
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
    renderedLevel = null;
    state.row = null; state.tab = 'overview'; state.recent = []; state.currentEvents = [];
    state.totalEvents = state.totalRuns = state.unattributed = 0; state.backlog = null; state.error = null; state.level = null;
    state.configOpen = state.nameOpen = false;
    state.actionResult = ''; state.actionBusy = false;
    root.hidden = true; root.replaceChildren(); onClose();
  }
  // Esc first leaves the inline name editor, then closes the drawer. Returns whether it acted.
  function escape() {
    if (!controller) return false;
    if (state.nameOpen) { state.nameOpen = false; draw(); return true; }
    close();
    return true;
  }
  return {
    state, timeline, refresh, close, act, selectTab, escape,
    async open(selection, snapshot = {}) {
      close(); stopped = false; controller = new AbortController(); owner = identity();
      const selected = resolveDetailRow(selection, snapshot);
      state.row = selected.row; state.historical = selected.historical; state.snapshot = snapshot;
      const gen = generation, key = state.row.sessionGroup ?? 'origin';
      configRevision = 0;
      config = createGroupConfig({ key, request, t, active: () => active(gen), onChange: () => { configRevision++; draw(); } });
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
    setViewDetail() {
      draw();
      // Technical detail changes which events are read: reread recent activity, counts and the timeline.
      if (!controller || !state.row || readLevel() === state.level) return;
      void timeline.setLevel();
      const again = () => refresh();
      void (refreshTask ? refreshTask.then(again, again) : again());
    },
    destroy() { close(); stopped = true; },
  };
}
