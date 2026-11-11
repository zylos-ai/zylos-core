import { formatZoned } from './instance-zone.js?v=100';
import { workingNowText } from './working-display.js?v=1';
import { listen } from './detail-update.js?v=158';
import { element, icon } from './plain-text.js?v=106';
import { endReasonLabel, timeValue } from './event-labels.js?v=91';
import { eventRow, eventTime, repeatRow } from './detail-overview.js?v=162';
import { eventTypesFor, mergeRepeats, newestFirst, showsEvent } from './timeline-rows.js?v=108';

export { timeValue };

// Filter chips combine freely; one chip alone uses the server-side type filter.
export const chipNames = ['messages', 'tools', 'lifecycle'];
const filters = ['all', ...chipNames];

export function attributeMessages(messages, runs) {
  const attributed = new Map(runs.map(run => [run.runId, []]));
  const between = [];
  for (const row of messages) {
    // Explicitly project only timing and direction, even if a caller supplied
    // additional fields. Message bodies never enter this model.
    const message = { id: row.id, direction: row.direction, channel: row.channel, timestamp: row.timestamp };
    const time = timeValue(message.timestamp);
    const run = runs.find(item => time >= timeValue(item.startAt) && time <= timeValue(item.endAt));
    if (run) attributed.get(run.runId).push(message);
    else between.push(message);
  }
  return { attributed, between };
}

export function createTimelineLoader({ request, onChange = () => {}, onError = () => {}, active = () => true, now = Date.now,
  detail = () => 'plain' }) {
  const level = () => detail() === 'technical' ? 'technical' : 'plain';
  const state = { open: false, key: null, currentRunId: null, runs: [], totalEvents: 0, totalRuns: 0, unattributed: 0,
    expanded: new Set(), events: new Map(), currentEvents: [], messages: new Map(), between: [], filter: 'all', chips: new Set(chipNames),
    level: level(), error: null, loading: false };
  let generation = 0, filterGeneration = 0, controller = null, pendingOperations = 0;
  const current = gen => gen === generation && active() && !controller?.signal.aborted;
  const publish = () => { if (active()) onChange(state); };
  const path = suffix => `/api/workbench/groups/${encodeURIComponent(state.key ?? 'origin')}/${suffix}`;
  async function read(pathname, gen) {
    const value = await request(pathname, { signal: controller.signal });
    if (!current(gen)) throw Object.assign(new Error('view_changed'), { name: 'AbortError' });
    return value;
  }
  async function fetchEvents(runId, gen, filterGen, filter = state.filter) {
    if (filter === 'messages') return [];
    const output = [];
    let afterSeq = null;
    for (;;) {
      const query = new URLSearchParams({ session_group: state.key ?? '', run_id: runId, order: 'asc', limit: '1000' });
      const types = eventTypesFor(filter, state.level);
      if (types?.length) query.set('types', types.join(','));
      if (afterSeq != null) query.set('after_seq', String(afterSeq));
      const value = await read('/api/timeline?' + query, gen);
      if (filterGen !== filterGeneration) throw Object.assign(new Error('filter_changed'), { name: 'AbortError' });
      const events = value.events ?? [];
      output.push(...events);
      if (events.length < 1000) return output;
      const next = events.at(-1)?.event_seq;
      if (!Number.isFinite(next) || (afterSeq != null && next <= afterSeq)) throw new Error('timeline_cursor_invalid');
      afterSeq = next;
    }
  }
  async function loadMessages(gen) {
    if (!state.runs.length) return;
    // The current run is still open after its latest event. Include messages
    // through this read; ended segments retain their recorded event bounds.
    const bounds = state.runs.map(run => run.runId === state.currentRunId
      ? { ...run, endAt: new Date(Math.max(timeValue(run.endAt), now())).toISOString() } : run);
    const starts = bounds.map(run => timeValue(run.startAt)).filter(Number.isFinite);
    const ends = bounds.map(run => timeValue(run.endAt)).filter(Number.isFinite);
    if (!starts.length || !ends.length) return;
    const query = new URLSearchParams({ since: new Date(Math.min(...starts)).toISOString(), until: new Date(Math.max(...ends)).toISOString() });
    const value = await read(path('messages') + '?' + query, gen);
    const { attributed, between } = attributeMessages(Array.isArray(value) ? value : value.messages ?? [], bounds);
    state.messages = attributed;
    state.between = between;
  }
  async function runEvents(runId, gen = generation, filterGen = filterGeneration) {
    const events = await fetchEvents(runId, gen, filterGen);
    if (current(gen) && filterGen === filterGeneration) {
      state.events.set(runId, events);
      if (runId === state.currentRunId && state.filter === 'all') state.currentEvents = events;
    }
  }
  function updateRuns(value) {
    const merged = new Map(state.runs.map(run => [run.runId, run]));
    for (const run of value.runs ?? []) merged.set(run.runId, run);
    state.runs = [...merged.values()].sort((a, b) => timeValue(b.startAt) - timeValue(a.startAt));
    state.totalEvents = value.totalEvents ?? 0;
    state.totalRuns = value.totalRuns ?? 0;
    state.unattributed = value.unattributed ?? 0;
  }
  // Run segments always span all their events; in plain view the counts cover plain events only.
  // A read started for an earlier level (`filterGen` given and since superseded) is dropped on arrival.
  async function loadRuns(before, gen = generation, { limit = 3, replace = false, filterGen = null } = {}) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before != null) query.set('before', before);
    const types = eventTypesFor('all', state.level);
    if (types?.length) query.set('types', types.join(','));
    const value = await read(path('runs') + '?' + query, gen);
    if (filterGen != null && filterGen !== filterGeneration) return;
    if (replace) state.runs = [];
    updateRuns(value);
    await loadMessages(gen);
  }
  async function appendCurrent(gen) {
    const runId = state.currentRunId;
    if (!runId || state.filter === 'messages') return;
    const filterGen = filterGeneration;
    const loaded = state.events.get(runId) ?? [];
    const afterSeq = loaded.at(-1)?.event_seq ?? 0;
    const query = new URLSearchParams({ session_group: state.key ?? '', run_id: runId,
      order: 'asc', limit: '1000', after_seq: String(afterSeq) });
    const types = eventTypesFor(state.filter, state.level);
    if (types?.length) query.set('types', types.join(','));
    const value = await read('/api/timeline?' + query, gen);
    if (filterGen !== filterGeneration) return;
    // A snapshot refresh reads one page only. If over 1000 new events arrive,
    // the following board snapshot continues from this page's final sequence.
    const events = [...loaded, ...(value.events ?? [])];
    state.events.set(runId, events);
    if (state.filter === 'all') state.currentEvents = events;
  }
  async function reload(alongside = async () => {}) {
    const filterGen = ++filterGeneration;
    const gen = generation;
    // Cached event arrays belong to the previous filter or level, including collapsed
    // segments. A failed reload must not leave those arrays available to append.
    state.events.clear();
    state.currentEvents = [];
    await guarded(async () => {
      const results = await Promise.allSettled([alongside(filterGen), ...[...state.expanded].map(runId => runEvents(runId, gen, filterGen))]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    });
  }
  async function guarded(operation) {
    const gen = generation;
    try {
      pendingOperations++;
      state.loading = true;
      await operation();
      if (current(gen)) { state.error = null; publish(); }
    } catch (error) {
      if (error.name !== 'AbortError' && current(gen)) { state.error = error.message; onError(error); publish(); }
    } finally {
      if (current(gen)) {
        pendingOperations--;
        state.loading = pendingOperations > 0;
        publish();
      }
    }
  }
  return {
    state, updateRuns,
    async open(key, currentRunId) {
      this.close();
      state.key = key;
      state.open = true;
      state.level = level();
      state.currentRunId = currentRunId ?? null;
      state.expanded = new Set(currentRunId ? [currentRunId] : []);
      controller = new AbortController();
      const gen = generation;
      await guarded(async () => {
        await Promise.all([loadRuns(null, gen), currentRunId ? runEvents(currentRunId, gen) : Promise.resolve()]);
      });
    },
    async refresh() {
      if (!state.open || !active() || state.loading) return;
      const gen = generation;
      await guarded(async () => {
        await appendCurrent(gen);
        await loadMessages(gen);
      });
    },
    async loadEarlier() {
      if (!state.runs.length || state.loading) return;
      await guarded(() => loadRuns(state.runs.at(-1).startAt));
    },
    async expand(runId) {
      state.expanded.add(runId);
      if (!state.events.has(runId)) await guarded(() => runEvents(runId));
      else publish();
    },
    collapse(runId) { state.expanded.delete(runId); publish(); },
    async setChips(chips) {
      state.chips = new Set(chips.filter(chip => chipNames.includes(chip)));
      const filter = state.chips.size === 1 ? [...state.chips][0] : 'all';
      if (filter !== state.filter) await this.setFilter(filter);
      else publish();
    },
    async setFilter(filter) {
      state.filter = filters.includes(filter) ? filter : 'all';
      await reload();
    },
    /** Technical detail switched: reread the expanded runs and the loaded run counts at the new level. */
    async setLevel() {
      if (!state.open || level() === state.level) { state.level = level(); return; }
      state.level = level();
      await reload(filterGen => loadRuns(null, generation, { limit: Math.min(1000, Math.max(3, state.runs.length)), replace: true, filterGen }));
    },
    close() {
      controller?.abort();
      controller = null;
      generation++;
      filterGeneration++;
      pendingOperations = 0;
      state.loading = false;
      state.open = false;
      state.key = null;
      state.currentRunId = null;
      state.runs = [];
      state.events = new Map();
      state.currentEvents = [];
      state.messages = new Map();
      state.between = [];
      state.expanded = new Set();
      state.filter = 'all';
      state.chips = new Set(chipNames);
      state.level = level();
      state.totalEvents = state.totalRuns = state.unattributed = 0;
      state.error = null;
    },
  };
}

export function renderTimeline(root, loader, { document = root.ownerDocument, t = key => key, level = 'plain', onObserve = null, working = null } = {}) {
  const { state } = loader;
  const chips = state.chips ?? new Set(chipNames);
  root.replaceChildren();
  if (working?.on) {
    const line = element(document, 'div', undefined, 'wi-now');
    if (working.on) line.append(icon(document, 'loader'));
    const locale = document.documentElement?.lang;
    const caption = element(document, 'span', workingNowText(working, { t, locale }));
    if (working.subagents && Number.isFinite(working.subagents.lastActivityAt)) {
      const time = formatZoned(new Date(working.subagents.lastActivityAt), locale, { hour: '2-digit', minute: '2-digit' });
      caption.append(element(document, 'span', ' · ' + t('chat.working.latest', { time }), 'wi-now-sub'));
    }
    line.append(caption);
    root.append(line);
  }
  const filters = element(document, 'div', undefined, 'wb-timeline-filters');
  const chipRow = element(document, 'div', undefined, 'wb-chips');
  for (const chip of chipNames) {
    const button = element(document, 'button', t('wb.timeline.' + chip), 'wb-chip');
    button.type = 'button'; button.setAttribute('aria-pressed', String(chips.has(chip)));
    listen(button, 'click', () => {
      const next = chips.has(chip) ? [...chips].filter(value => value !== chip) : [...chips, chip];
      if (loader.setChips) void loader.setChips(next);
      else loader.setFilter(next.length === 1 ? next[0] : 'all');
    });
    chipRow.append(button);
  }
  const note = element(document, 'p', t('wb.timeline.messagesNote'), 'wb-note');
  if (onObserve) {
    const raw = element(document, 'button', t('wb.detail.observeHistory'), 'wb-link-btn wb-chev'); raw.type = 'button';
    listen(raw, 'click', () => onObserve('history')); note.append(raw);
  }
  filters.append(chipRow, note);
  root.append(filters);
  const showMessages = chips.has('messages'), showEvent = event => showsEvent(event, { chips, chipCount: chipNames.length, level });
  const messageLabel = message => t(message.direction === 'in' ? 'wb.timeline.received' : 'wb.timeline.replied');
  const current = state.currentRunId && !state.runs.some(run => run.runId === state.currentRunId)
    ? [{ runId: state.currentRunId, endReason: 'running', n: state.events.get(state.currentRunId)?.length ?? 0 }, ...state.runs]
    : state.runs;
  const lang = document.documentElement?.lang;
  for (const run of current) {
    const section = element(document, 'section', undefined, 'wb-timeline-run');
    section.dataset.runId = run.runId;
    section.dataset.updateKey = run.runId;
    const open = state.expanded.has(run.runId), live = run.runId === state.currentRunId;
    const toggle = element(document, 'button', undefined, 'wb-run-h'); toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.append(icon(document, 'chev', 'xs'));
    if (level === 'technical') toggle.append(element(document, 'span', run.runId, 'wb-mono'));
    const start = eventTime(run.startAt, level, lang), end = live ? null : eventTime(run.endAt, level, lang);
    const span = element(document, 'span', [start.text, end ? end.text : t('wb.timeline.now')].filter(Boolean).join(' – '));
    span.title = [start.title, end?.title].filter(Boolean).join(' – ');
    toggle.append(span, element(document, 'span', live ? t('wb.timeline.currentRun') : endReasonLabel(run.endReason, level, t) ?? '', 'wb-end'));
    if (run.n != null) toggle.append(element(document, 'span', t('wb.timeline.count', { count: run.n }), 'wb-sub'));
    listen(toggle, 'click', () => open ? loader.collapse(run.runId) : loader.expand(run.runId));
    section.append(toggle);
    if (open) {
      const rows = [];
      if (state.filter !== 'messages') for (const event of state.events.get(run.runId) ?? []) if (showEvent(event)) rows.push({ at: timeValue(event.timestamp), event });
      if (showMessages && ['all', 'messages'].includes(state.filter)) for (const message of state.messages.get(run.runId) ?? []) {
        rows.push({ at: timeValue(message.timestamp), message });
      }
      // Newest first inside a run as across runs, so "back to latest" (the top) is the latest row.
      for (const group of mergeRepeats(newestFirst(rows))) {
        const { event, message } = group.newest;
        section.append(message
          ? eventRow(document, message, { level, t, label: messageLabel(message), className: 'wb-ev wb-timeline-message' })
          : repeatRow(document, group, { level, t, className: 'wb-ev wb-timeline-event' }));
      }
      if (!rows.length && !state.loading) section.append(element(document, 'p', t('wb.timeline.empty'), 'wb-note'));
    }
    root.append(section);
  }
  if (state.between.length && showMessages && ['all', 'messages'].includes(state.filter)) {
    const between = element(document, 'section', undefined, 'wb-timeline-between');
    between.append(element(document, 'h4', t('wb.timeline.between')));
    for (const message of state.between) between.append(eventRow(document, message, { level, t, label: messageLabel(message) }));
    root.append(between);
  }
  if (state.unattributed) root.append(element(document, 'p', t('wb.timeline.unattributed', { count: state.unattributed }), 'wb-note'));
  if (state.runs.length < state.totalRuns) {
    const more = element(document, 'button', t('wb.timeline.earlier'), 'wb-link-btn wb-more'); more.type = 'button'; more.disabled = state.loading;
    listen(more, 'click', () => loader.loadEarlier()); root.append(more);
  } else if (state.runs.length) root.append(element(document, 'p', t('wb.timeline.noEarlier'), 'wb-note wb-end-note'));
  if (state.error) root.append(element(document, 'p', t('wb.readFailed') + ' · ' + state.error, 'wb-detail-error'));
  const latest = element(document, 'button', undefined, 'wb-timeline-latest'); latest.type = 'button';
  latest.append(icon(document, 'up', 'xs'), element(document, 'span', t('wb.timeline.latest')));
  latest.hidden = true;
  listen(latest, 'click', event => {
    const button = event.currentTarget ?? latest;
    const body = button.closest?.('.wb-detail-body') ?? root;
    body.scrollTop = 0; button.hidden = true;
  });
  listen(root, 'scroll', event => {
    const body = event.currentTarget ?? root;
    const button = body.querySelector?.('.wb-timeline-latest') ?? latest;
    button.hidden = (body.scrollTop ?? 0) < 20;
  });
  root.append(latest);
}
