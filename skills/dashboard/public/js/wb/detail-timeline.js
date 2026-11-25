import { instantMs } from './api-time.js';
import { formatZoned } from './instance-zone.js';
import { workingNowText } from './working-display.js';
import { listen } from './detail-update.js';
import { element, icon } from './plain-text.js';
import { endReasonLabel, timeValue } from './event-labels.js';
import { eventRow, eventTime, repeatRow } from './detail-overview.js';
import { eventRows, mergeRepeats, newestFirst, plainActivityRows, showsEvent } from './timeline-rows.js';

export { timeValue };

// Filter chips combine freely; one chip alone uses the server-side type filter.
export const chipNames = ['messages', 'tools', 'lifecycle'];
const filters = ['all', ...chipNames];
export const isInvalidCursor = error => (error.body?.error?.code ?? error.code) === 'invalid_cursor';

async function settleReads(reads) {
  const results = await Promise.allSettled(reads);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}

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
    expanded: new Set(), events: new Map(), eventPages: new Map(), runsCursor: null, currentEvents: [], messages: new Map(), between: [], filter: 'all', chips: new Set(chipNames),
    level: level(), error: null, loading: false };
  let generation = 0, filterGeneration = 0, controller = null, pendingOperations = 0;
  let messagePage = null;
  const messageRows = new Map();
  const current = gen => gen === generation && active() && !controller?.signal.aborted;
  const publish = () => { if (active()) onChange(state); };
  const path = suffix => `/api/groups/${encodeURIComponent(state.key ?? 'origin')}/${suffix}`;
  async function read(pathname, gen) {
    const value = await request(pathname, { signal: controller.signal });
    if (!current(gen)) throw Object.assign(new Error('view_changed'), { name: 'AbortError' });
    return value;
  }
  function readPage(resource, parameters, cursor, direction, gen) {
    const query = new URLSearchParams(parameters);
    if (cursor != null) query.set('cursor', cursor);
    if (direction === 'after') query.set('direction', direction);
    return read(path(resource) + '?' + query, gen);
  }
  async function loadMessages(gen, poll = false, recover = true) {
    if (!state.runs.length) return;
    // The current run is still open after its latest event. Include messages
    // through this read; ended segments retain their recorded event bounds.
    const bounds = state.runs.map(run => run.runId === state.currentRunId
      ? { ...run, endAt: new Date(Math.max(timeValue(run.endAt), now())).toISOString() } : run);
    const starts = bounds.map(run => timeValue(run.startAt)).filter(Number.isFinite);
    const ends = bounds.map(run => timeValue(run.endAt)).filter(Number.isFinite);
    if (!starts.length || !ends.length) return;
    const start = Math.floor(Math.min(...starts) / 1000) * 1000;
    const end = Math.floor(Math.max(...ends) / 1000) * 1000;
    const readMessages = (cursor, direction) => readPage('messages', { limit: 100 }, cursor, direction, gen);
    const remember = value => {
      for (const row of value.items ?? []) messageRows.set(row.id, row);
    };
    try {
      if (!messagePage) {
        const value = await readMessages(null, 'before');
        messagePage = { nextCursor: value.nextCursor, afterCursor: value.afterCursor, oldest: timeValue(value.items?.[0]?.timestamp) };
        remember(value);
      } else if (poll && messagePage.afterCursor) {
        const value = await readMessages(messagePage.afterCursor, 'after');
        messagePage.afterCursor = value.afterCursor;
        remember(value);
      }
      while (messagePage.nextCursor && !(messagePage.oldest < start)) {
        const value = await readMessages(messagePage.nextCursor, 'before');
        messagePage.nextCursor = value.nextCursor;
        messagePage.oldest = timeValue(value.items?.[0]?.timestamp);
        remember(value);
      }
    } catch (error) {
      if (!isInvalidCursor(error) || !recover) throw error;
      messageRows.clear();
      messagePage = null;
      return loadMessages(gen, false, false);
    }
    const rows = [...messageRows.values()].filter(row => {
      const at = timeValue(row.timestamp);
      return at >= start && at <= end;
    }).sort((left, right) => left.id - right.id);
    const { attributed, between } = attributeMessages(rows, bounds);
    state.messages = attributed;
    state.between = between;
  }
  async function runEvents(runId, direction, gen = generation, filterGen = filterGeneration) {
    if (state.filter === 'messages') return;
    const previous = state.eventPages.get(runId);
    let cursor = direction === 'after' ? previous?.afterCursor : direction === 'before' ? previous?.nextCursor : null;
    if (previous && direction && cursor == null) return;
    const parameters = { runId, filter: state.filter, level: state.level };
    let page;
    try { page = await readPage('events', parameters, cursor, cursor ? direction : null, gen); }
    catch (error) {
      if (!cursor || !isInvalidCursor(error) || filterGen !== filterGeneration) throw error;
      cursor = null;
      page = await readPage('events', parameters, null, null, gen);
    }
    if (filterGen !== filterGeneration) return;
    const existing = cursor ? state.events.get(runId) ?? [] : [];
    const incoming = page.items ?? [];
    const ordered = cursor && direction === 'before' ? [...incoming, ...existing] : [...existing, ...incoming];
    const events = [...new Map(ordered.map(event => [event.id, event])).values()];
    state.events.set(runId, events);
    state.eventPages.set(runId, {
      nextCursor: cursor && direction === 'after' ? previous.nextCursor : page.nextCursor,
      afterCursor: cursor && direction === 'before' ? previous.afterCursor : page.afterCursor,
    });
    if (runId === state.currentRunId && state.filter === 'all') state.currentEvents = events;
  }
  function updateRuns(value) {
    const merged = new Map(state.runs.map(run => [run.runId, run]));
    for (const run of value.items ?? []) merged.set(run.runId, run);
    state.runs = [...merged.values()].sort((a, b) => timeValue(b.startAt) - timeValue(a.startAt));
    state.totalEvents = value.totalEvents ?? 0;
    state.totalRuns = value.totalRuns ?? 0;
    state.unattributed = value.unattributed ?? 0;
  }
  // Run segments always span all their events; in plain view the counts cover plain events only.
  // A read started for an earlier level (`filterGen` given and since superseded) is dropped on arrival.
  async function loadRuns(cursor, gen = generation, { count = 3, replace = false, filterGen = filterGeneration, recover = true } = {}) {
    const items = [];
    let value;
    do {
      try { value = await readPage('runs', { limit: Math.min(100, count - items.length), level: state.level }, cursor, null, gen); }
      catch (error) {
        if (!cursor || !recover || !isInvalidCursor(error) || filterGen !== filterGeneration) throw error;
        return loadRuns(null, gen, { count: Math.max(3, state.runs.length), replace: true, filterGen, recover: false });
      }
      if (filterGen !== filterGeneration) return;
      items.push(...(value.items ?? []));
      cursor = value.nextCursor;
    } while (cursor && items.length < count);
    if (replace) state.runs = [];
    state.runsCursor = cursor;
    updateRuns({ ...value, items });
    await loadMessages(gen);
  }
  async function reload(alongside = async () => {}) {
    const filterGen = ++filterGeneration;
    const gen = generation;
    // Cached event arrays belong to the previous filter or level, including collapsed
    // segments. A failed reload must not leave those arrays available to append.
    state.events.clear();
    state.eventPages.clear();
    state.currentEvents = [];
    await guarded(() => settleReads([alongside(filterGen), ...[...state.expanded].map(runId => runEvents(runId, null, gen, filterGen))]));
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
      await guarded(() => settleReads([loadRuns(null, gen), currentRunId ? runEvents(currentRunId, null, gen) : Promise.resolve()]));
    },
    async refresh() {
      if (!state.open || !active() || state.loading) return;
      const gen = generation;
      await guarded(() => settleReads([state.currentRunId ? runEvents(state.currentRunId, 'after', gen) : Promise.resolve(), loadMessages(gen, true)]));
    },
    async loadEarlier() {
      if (!state.runsCursor || state.loading) return;
      await guarded(() => loadRuns(state.runsCursor));
    },
    async loadEarlierEvents(runId) {
      if (!state.eventPages.get(runId)?.nextCursor || state.loading) return;
      await guarded(() => runEvents(runId, 'before'));
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
      await reload(filterGen => loadRuns(null, generation, { count: Math.max(3, state.runs.length), replace: true, filterGen }));
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
      state.runsCursor = null;
      state.events = new Map();
      state.eventPages = new Map();
      state.currentEvents = [];
      state.messages = new Map();
      state.between = [];
      messageRows.clear();
      messagePage = null;
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
    if (working.subagents && Number.isFinite(instantMs(working.subagents.lastActivityAt))) {
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
    ? [{ runId: state.currentRunId, endReason: 'running' }, ...state.runs]
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
    if (run.n != null) toggle.append(element(document, 'span', t(run.n === 1 ? 'wb.timeline.countOne' : 'wb.timeline.count', { count: run.n }), 'wb-sub'));
    listen(toggle, 'click', () => open ? loader.collapse(run.runId) : loader.expand(run.runId));
    section.append(toggle);
    if (open) {
      const rows = [];
      const events = state.filter === 'messages' ? [] : state.events.get(run.runId) ?? [];
      rows.push(...eventRows(events, { plain: level !== 'technical' }).filter(row => showEvent(row.event)));
      if (showMessages && ['all', 'messages'].includes(state.filter)) {
        const page = state.eventPages?.get(run.runId);
        const earliest = page?.nextCursor
          ? events.reduce((bound, event) => Math.min(bound, timeValue(event.timestamp)), Infinity)
          : state.filter === 'messages' || page || !state.loading ? -Infinity : Infinity;
        for (const message of state.messages.get(run.runId) ?? []) {
          const at = timeValue(message.timestamp);
          if (at >= earliest) rows.push({ at, message });
        }
      }
      // Newest first inside a run as across runs, so "back to latest" (the top) is the latest row.
      const ordered = newestFirst(rows);
      for (const group of mergeRepeats(level === 'technical' ? ordered : plainActivityRows(ordered, t))) {
        const { event, message } = group.newest;
        section.append(message
          ? eventRow(document, message, { level, t, label: messageLabel(message), className: 'wb-ev wb-timeline-message' })
          : repeatRow(document, group, { level, t, className: 'wb-ev wb-timeline-event' }));
      }
      if (!rows.length && !state.loading) section.append(element(document, 'p', t('wb.timeline.empty'), 'wb-note'));
    }
    if (open && state.eventPages?.get(run.runId)?.nextCursor) {
      const more = element(document, 'button', t('wb.timeline.earlier'), 'wb-link-btn wb-more wb-more-events');
      more.type = 'button'; more.disabled = state.loading;
      listen(more, 'click', () => loader.loadEarlierEvents(run.runId));
      section.append(more);
    }
    root.append(section);
  }
  if (state.between.length && showMessages && ['all', 'messages'].includes(state.filter)) {
    const between = element(document, 'section', undefined, 'wb-timeline-between');
    between.append(element(document, 'h4', t('wb.timeline.between')));
    for (const message of state.between) between.append(eventRow(document, message, { level, t, label: messageLabel(message) }));
    root.append(between);
  }
  if (state.unattributed) root.append(element(document, 'p', t(state.unattributed === 1 ? 'wb.timeline.unattributedOne' : 'wb.timeline.unattributed', { count: state.unattributed }), 'wb-note'));
  if (state.runsCursor) {
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
