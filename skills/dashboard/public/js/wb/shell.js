import { readGroupSnapshot, readGroupPage, readGroupPages, groupSnapshot, displayGroupRow, groupDetailPath } from './group-data.js';
import { withRequestTimeout } from '../request-timeout.js';
import { countLabel } from '../count-label.js';
import { createViewMode, groupObservable, observerNavEntry } from './view-mode.js';
import { boardController, keepGroupOrder, renderBoard, renderDistribution } from './board.js';
import { createBoardSearch } from './board-search.js';
import { instanceStrip, accountRuntimes } from './instance-strip.js';
import { renderAttention } from './attention-bar.js';
import { confirmDialog, createGroupDetail } from './detail.js';
import { namePromptResult, renderNameResult, sendNamePrompt } from './auto-name.js';
import { fetchJson } from './group-config.js';
import { createHostPanel } from './host-panel.js';
import { element, icon } from './plain-text.js';
import { watchRows } from './label-fit.js';

const REQUEST_TIMEOUT_MS = 30000;

export function mountWorkbench({ document = globalThis.document, window = globalThis.window, t = key => key,
  endpoint = path => path, identity = () => endpoint('/api/groups'),
  observerStatus = () => null, observerAvailable = () => true, onObserve = () => {},
  writable = () => true, onMemory = () => {}, onConversation, conversationAvailable = () => true, instanceInfo = () => ({}),
  storage = globalThis.localStorage, fetch = globalThis.fetch } = {}) {
  const board = document.querySelector('#wb-board');
  if (!board) return { openGroup: async () => {}, locateGroup: async () => {}, setViewDetail() {}, destroy() {} };
  const mode = createViewMode({ storage, document });
  const searchInput = document.querySelector('#wb-search');
  const rangeInput = document.querySelector('#wb-range');
  const toggle = document.querySelector('#wb-detail-toggle');
  const nav = document.querySelector('#observer-tab');
  let groupSide = 'running', groupDepth = 1, searchDepth = 1, pushedCounts = null, instanceRead = null;
  let searchPage = null, locatedRow = null, moreRequest = null;
  const groupPending = new Set(), searchPending = new Set();
  const pendingButton = element(document, 'button', undefined, 'wb-btn wb-btn-sm wb-board-refresh');
  pendingButton.type = 'button';
  pendingButton.hidden = true;
  pendingButton.addEventListener('click', () => refreshFirstPage());
  const sides = element(document, 'div', undefined, 'wb-seg wb-group-sides');
  sides.setAttribute('role', 'group'); sides.setAttribute('aria-label', t('wb.board.groupsLabel'));
  board.parentNode?.insertBefore(sides, board);
  board.parentNode?.insertBefore(pendingButton, board);
  let groupDetail = null, hostPanel = null, nameRequest = null;
  // The automatic-naming run on screen, from the question until its answer is closed; the button stays off meanwhile.
  let nameFlow = null;
  const nameButton = document.querySelector('#wb-auto-name');
  const nameDialog = document.querySelector('#wb-auto-name-dialog');
  // State counts compact before wrapping; instance strip items wrap whole without measurement.
  const labels = watchRows([document.querySelector('#wb-dist')], { document, window });
  let locateGeneration = 0, locatedGroup, snapshot = null, error = null, lastSuccess = null, activity = null, activityAt = 0,
    range = '60m', activityGen = 0, cost = null, transition = null, owner = identity(), stopped = false;
  let activityRequest = null, activityQueued = false;
  let requestedActivityIds = new Set();
  try {
    if (storage.getItem('zylos-dashboard-activity-range') === '6h') range = '6h';
  } catch {}
  const readFresh = async (path, { signal } = {}) => {
    const captured = identity();
    const response = await fetch(endpoint(path), { signal });
    if (captured !== identity() || stopped) {
      if (!stopped) resetOwner();
      throw Error('view_changed');
    }
    const value = await response.json().catch(error => { if (response.ok) throw error; });
    if (captured !== identity() || stopped) {
      if (!stopped) resetOwner();
      throw Error('view_changed');
    }
    if (!response.ok) throw Object.assign(Error('read_failed'), { status: response.status, code: value?.error?.code });
    return value;
  };
  const read = (path, options = {}) => {
    if (path !== '/api/instance') return readFresh(path, options);
    if (!instanceRead || instanceRead.owner !== identity()) {
      const record = { owner: identity(), promise: null };
      record.promise = readFresh(path, options).catch(error => { if (instanceRead === record) instanceRead = null; throw error; });
      instanceRead = record;
    }
    return instanceRead.promise;
  };
  const observerEntry = () => {
    const status = observerStatus();
    return observerAvailable(status) ? observerNavEntry(status, mode.detailLevel(), t) : null;
  };
  const syncNav = () => {
    const entry = observerEntry();
    if (nav) {
      // The page name stays fixed; an unavailable observer says why in the tooltip and on its page.
      const label = entry ? t('tab.observer') : '', hint = entry?.target === 'settings' ? entry.label : '';
      if (nav.hidden !== !entry) nav.hidden = !entry;
      if (nav.textContent !== label) nav.textContent = label;
      nav.dataset.wbHint = hint;
      if (nav.title !== hint) nav.title = hint;
      nav.classList.toggle('wb-tab-muted', Boolean(hint));
    }
  };
  function redraw() {
    syncNav();
    groupDetail?.setViewDetail();
    hostPanel?.setViewDetail();
    if (!hostPanel?.active) document.querySelector('#wb-side')?.setAttribute('aria-label', t('wb.detail.title'));
    if (nameButton) {
      nameButton.textContent = t('wb.name.auto');
      nameButton.disabled = Boolean(nameFlow) || !writable();
      nameButton.title = writable() ? t('wb.name.autoHint') : t('wb.readOnly');
    }
    const level = mode.detailLevel();
    const legend = document.querySelector('#wb-legend');
    if (legend) {
      legend.replaceChildren();
      for (const state of ['busy', 'idle', 'waiting', 'error', 'none']) {
        const item = element(document, 'span', t('wb.legend.' + state), 'wb-legend-item');
        item.append(element(document, 'i', undefined, 'wb-bucket wb-' + state));
        legend.append(item);
      }
      const inbound = element(document, 'span', t(activity?.inboundError ? 'wb.inboundUnknown' : 'wb.inboundLegend'), 'wb-legend-item');
      if (!activity?.inboundError) inbound.append(element(document, 'i', undefined, 'wb-bucket wb-idle wb-inbound'));
      legend.append(inbound, element(document, 'span', t(level === 'technical' ? 'wb.legend.cells.' + range : 'wb.legend.rightNow'), 'wb-legend-note'));
    }
    if (rangeInput) {
      rangeInput.replaceChildren();
      rangeInput.setAttribute('aria-label', t('wb.range'));
      for (const value of ['60m', '6h']) {
        const button = element(document, 'button', t(value === '60m' ? 'wb.range60' : 'wb.range6'));
        button.type = 'button'; button.dataset.range = value; button.setAttribute('aria-pressed', String(range === value));
        button.addEventListener('click', () => changeRange(value));
        rangeInput.append(button);
      }
    }
    sides.replaceChildren();
    for (const side of ['running', 'offline']) {
      const count = snapshot?.groupCounts?.[side]?.total;
      const button = element(document, 'button', t('wb.groups.' + side) + (count == null ? '' : ' · ' + count));
      button.type = 'button'; button.setAttribute('aria-pressed', String(groupSide === side));
      button.addEventListener('click', () => {
        if (groupSide === side && !search.query() && !locatedRow) return;
        search.input('');
        searchInput.value = '';
        groupSide = side;
        refreshFirstPage();
      });
      sides.append(button);
    }
    const dist = document.querySelector('#wb-dist');
    if (dist) renderDistribution(dist, snapshot, { document, t, level });
    searchInput.placeholder = t('wb.search');
    searchInput.maxLength = 64;
    searchInput.setAttribute('aria-label', t('wb.search'));
    const attention = document.querySelector('#wb-attention');
    renderAttention(attention, snapshot, { document, t, error: snapshot && error, lastSuccess, level, onSelect: openFromAttention });
    if (transition) {
      const hint = element(document, 'div', undefined, 'wb-attention-item wb-attention-reminder wb-transition');
      hint.append(icon(document, 'clock'), element(document, 'span', t('wb.transition') + ' · ' + transition.phase));
      attention.append(hint);
    }
    syncSide();
    const pending = searchPage ? searchPending.size : groupPending.size;
    pendingButton.hidden = pending === 0 || Boolean(locatedRow);
    pendingButton.textContent = pendingButton.hidden ? '' : countLabel(t, 'wb.groups.newMessages', pending, { n: pending });
    if (!snapshot) {
      const message = error
        ? element(document, 'div', undefined, 'wb-attention-item wb-attention-problem')
        : element(document, 'p', t('wb.board.loading'), 'wb-empty');
      if (error) message.append(icon(document, 'alert'), element(document, 'span', t('wb.readFailed')));
      message.setAttribute('role', error ? 'alert' : 'status');
      board.replaceChildren(message);
      return;
    }
    instanceStrip(document.querySelector('#wb-instance'), snapshot, { document, t, costSummary: cost, level,
      hostOpen: Boolean(hostPanel?.active), onHost: () => { if (hostPanel.active) hostPanel.close(); else { void hostPanel.open(); redraw(); } } });
    labels.fit();
    const rows = locatedRow ? [snapshot.rows.find(row => row.sessionGroup === locatedRow.sessionGroup) ?? locatedRow]
      : searchPage?.rows ?? snapshot.rows;
    const displayedPage = locatedRow ? { ...snapshot, hasOlder: false, nextCursor: null }
      : searchPage ? { ...snapshot, hasOlder: false, nextCursor: searchPage.nextCursor } : snapshot;
    const focusedGroup = board.contains(document.activeElement) ? document.activeElement.dataset.group : undefined;
    renderBoard(board, displayedPage, {
      rows, query: search.query(), activity, document, t, level,
      selected: groupDetail?.state.row ? groupDetail.state.row.sessionGroup : locatedGroup,
      onSearch: () => searchInput.focus(), onMore: loadMore, loadingMore: Boolean(moreRequest),
      onSelect: selectRow,
    });
    if (focusedGroup !== undefined) [...board.querySelectorAll('.wb-row')].find(node => node.dataset.group === focusedGroup)?.focus({ preventScroll: true });
  }
  function selectRow(row) {
    locateGeneration++;
    locatedGroup = undefined;
    hostPanel.close();
    const opening = groupDetail?.open(row, snapshot);
    redraw();
    return opening;
  }
  function openFromAttention(key) {
    const row = snapshot?.rows.find(item => item.sessionGroup === key) ?? key;
    return selectRow(row);
  }
  // The detail drawer is fixed to the right edge; the overview yields its width while it is open.
  function syncSide() {
    const side = document.querySelector('#wb-side'), overview = document.querySelector('#tab-overview');
    overview?.classList.toggle('wb-has-side', Boolean(side && !side.hidden));
  }
  const search = createBoardSearch({
    fetchRows: q => readGroupPage(read, { q }),
    onRows: (rows, nextCursor) => {
      searchPage = { rows, nextCursor, q: search.query() };
      searchDepth = 1;
      searchPending.clear();
      locatedRow = null;
      redraw();
      refreshActivity();
    },
    onClear: () => {
      searchPage = null;
      searchDepth = 1;
      searchPending.clear();
      redraw();
    },
    onError: () => {
      error = true;
      redraw();
    },
  });
  function resetOwner() {
    if (owner === identity()) return false;
    owner = identity();
    locateGeneration++;
    locatedGroup = undefined;
    groupDetail?.close();
    hostPanel?.close();
    nameRequest?.abort();
    endNameFlow();
    controller.invalidate();
    costController.invalidate();
    search.input('');
    searchInput.value = '';
    snapshot = null;
    locatedRow = null;
    moreRequest = null;
    groupPending.clear();
    resetActivity();
    cost = null;
    groupSide = 'running'; groupDepth = 1;
    transition = null;
    error = null;
    for (const selector of ['#wb-board', '#wb-instance', '#wb-attention', '#wb-side']) {
      document.querySelector(selector)?.replaceChildren();
    }
    document.querySelector('#wb-side').hidden = true;
    return true;
  }
  const pageActive = () => document.querySelector('#tab-overview')?.classList.contains('active') &&
    !document.querySelector('#agent-detail')?.hidden;
  const visible = () => {
    resetOwner();
    return document.visibilityState !== 'hidden' && pageActive();
  };
  groupDetail = createGroupDetail({ root: document.querySelector('#wb-side'), document, t,
    fetch: (path, options) => fetch(endpoint(path), options), identity, writable,
    detail: () => mode.detailLevel(), isVisible: visible, onMemory, onConversation, conversationAvailable, onObserve,
    observable: row => groupObservable(observerEntry(), row),
    onRename: () => controller.refresh(), onClose: () => { if (!stopped) redraw(); },
  });
  hostPanel = createHostPanel({ root: document.querySelector('#wb-side'), document, t, read, identity,
    detail: () => mode.detailLevel(), onOpen: () => groupDetail.close(), onClose: () => { if (!stopped) redraw(); },
    meta: () => ({ ...instanceInfo(), mode: snapshot?.mode && snapshot.mode !== 'unreadable' ? t('wb.mode') + ' ' + snapshot.mode : null }),
    pool: () => snapshot && { mode: snapshot.mode, pool: snapshot.instance?.pool },
    accounts: () => snapshot?.instance?.accounts,
    accountOrder: () => accountRuntimes(snapshot ?? {}),
    onUsage: () => document.querySelector('.tab[data-tab="trends"]')?.click?.() });
  function endNameFlow(flow = nameFlow) {
    if (!flow || flow !== nameFlow) return;
    nameFlow = null;
    if (nameDialog) { nameDialog.hidden = true; nameDialog.replaceChildren(); }
    if (nameButton) nameButton.disabled = !writable();
  }
  const autoName = async () => {
    if (nameFlow || !writable() || !nameDialog) return;
    // One run at a time: a request already sent is never cancelled by another click, so its answer is always shown.
    const flow = nameFlow = { state: 'asking' };
    if (nameButton) nameButton.disabled = true;
    nameRequest = new AbortController();
    const captured = identity(), signal = nameRequest.signal, single = snapshot?.view === 'single';
    const current = () => !stopped && !signal.aborted && captured === identity() && nameFlow === flow;
    // Ask first: the prompt goes to Origin, or to the only session in single mode, which does the naming.
    if (!await confirmDialog(document, { title: t('wb.name.auto'), body: t(single ? 'wb.name.confirmSingle' : 'wb.name.confirm'),
      ok: t('wb.name.send'), cancel: t('wb.cancel'), danger: false }) || !current()) { endNameFlow(flow); return; }
    flow.state = 'sending';
    nameDialog.hidden = false;
    renderNameResult(nameDialog, 'sending', { document, t, single });
    let value, failure;
    try {
      value = await sendNamePrompt({ request: (path, options) => fetchJson(fetch, endpoint(path), { ...options, signal }) });
    } catch (error) { failure = error; }
    if (!current()) { endNameFlow(flow); return; }
    flow.state = 'answered';
    renderNameResult(nameDialog, namePromptResult(value, failure, t, { single }), { document, t, onClose: () => endNameFlow(flow) });
  };
  nameButton?.addEventListener('click', autoName);
  async function readMissingRows(previous, next, signal) {
    const replacements = new Map();
    if (!previous || next.listKnown === false) return replacements;
    const current = new Set(next.rows.map(row => row.sessionGroup));
    await Promise.all(previous.rows.filter(row => !current.has(row.sessionGroup)).map(async row => {
      try {
        const updated = await read(groupDetailPath(row.sessionGroup), { signal });
        if ((updated.id ?? updated.sessionGroup) === row.sessionGroup) replacements.set(row.sessionGroup, displayGroupRow(updated));
      } catch (error) {
        if (error.status === 404) replacements.set(row.sessionGroup, null);
      }
    }));
    return replacements;
  }
  const controller = boardController({
    visible,
    fetchSnapshot: () => withRequestTimeout(async signal => {
      const previous = snapshot, previousSearch = searchPage;
      const next = await readGroupSnapshot(read, { signal, side: groupSide, pages: groupDepth, counts: pushedCounts, instance: pushedCounts ? snapshot?.instance : null });
      const missing = await readMissingRows(previous, next, signal);
      let nextSearch, missingSearch;
      if (previousSearch && previousSearch.q === search.query()) {
        nextSearch = await readGroupPages(read, { signal, q: previousSearch.q, pages: searchDepth });
        missingSearch = await readMissingRows(previousSearch, nextSearch, signal);
      }
      return { next, missing, previousSearch, nextSearch, missingSearch };
    }, REQUEST_TIMEOUT_MS),
    onSnapshot: ({ next, missing, previousSearch, nextSearch, missingSearch }) => {
      if (snapshot) {
        const rows = keepGroupOrder(snapshot.rows, next.rows, missing, groupPending);
        next = groupSnapshot(next.instance, next.groupCounts, { ...next, rows, nextCursor: snapshot.nextCursor });
      }
      snapshot = next;
      if (nextSearch && searchPage === previousSearch && searchPage.q === search.query()) {
        searchPage = { ...searchPage, rows: keepGroupOrder(searchPage.rows, nextSearch.rows, missingSearch, searchPending) };
      }
      groupDetail.updateSnapshot(snapshot);
      error = null;
      lastSuccess = Date.now();
      redraw();
      refreshActivity();
    },
    onError: (failure, at) => {
      if (failure.code === 'invalid_cursor') { refreshFirstPage(); return; }
      error = true;
      lastSuccess = at;
      redraw();
    },
  });
  function refreshFirstPage() {
    locateGeneration++;
    groupDepth = 1;
    groupPending.clear();
    locatedGroup = undefined;
    locatedRow = null;
    snapshot = null;
    searchPage = null;
    searchDepth = 1;
    searchPending.clear();
    moreRequest = null;
    error = null;
    controller.invalidate();
    if (search.query()) search.input(searchInput.value);
    redraw();
    void controller.refresh();
  }
  // Optional cost has its own pending request and generation, so neither read holds up the other.
  const costController = boardController({
    visible,
    fetchSnapshot: () => withRequestTimeout(signal => read('/api/usage/summary', { signal }), REQUEST_TIMEOUT_MS),
    onSnapshot: value => { cost = value; redraw(); },
    onError: () => { cost = null; redraw(); },
  });
  async function loadMore() {
    const target = searchPage ?? snapshot;
    if (locatedRow || moreRequest || !target?.nextCursor || searchPage?.q !== (search.query() || undefined)) return;
    const request = moreRequest = {}, captured = identity(), side = groupSide, q = searchPage?.q;
    const current = () => moreRequest === request && !stopped && captured === identity() && side === groupSide &&
      (q === undefined ? !searchPage && !search.query() : q === searchPage?.q && q === search.query());
    redraw();
    try {
      const value = await withRequestTimeout(signal => readGroupPage(read, { signal, side: q ? undefined : side, q, cursor: target.nextCursor }), REQUEST_TIMEOUT_MS);
      if (!current()) return;
      const page = searchPage ?? snapshot;
      const known = new Set(page.rows.map(row => row.sessionGroup));
      const pending = q ? searchPending : groupPending;
      const rows = [...page.rows, ...value.rows.filter(row => !known.has(row.sessionGroup) && !pending.has(row.sessionGroup))];
      controller.invalidate();
      if (q) {
        searchDepth++;
        searchPage = { ...searchPage, rows, nextCursor: value.nextCursor ?? null };
      } else {
        groupDepth++;
        snapshot = groupSnapshot(snapshot.instance, snapshot.groupCounts, { ...snapshot, rows, nextCursor: value.nextCursor });
      }
      refreshActivity();
    } catch (failure) {
      if (!current()) return;
      if (failure.code === 'invalid_cursor') refreshFirstPage();
      else error = true;
    } finally {
      if (moreRequest === request) {
        moreRequest = null;
        redraw();
      }
    }
  }
  async function refreshMode() {
    if (!visible()) return;
    try {
      const value = await read('/api/instance');
      transition = value?.session_mode?.transition ?? null;
    } catch {
      transition = null;
    }
    if (!stopped) redraw();
  }
  function resetActivity() {
    activity = null;
    activityAt = 0;
    activityGen++;
    activityRequest = null;
    activityQueued = false;
    requestedActivityIds.clear();
  }
  async function refreshActivity() {
    if (!snapshot || stopped) return;
    const ids = new Set([...snapshot.rows, ...(searchPage?.rows ?? []), ...(locatedRow ? [locatedRow] : [])].map(row => row.sessionGroup).filter(Boolean));
    const due = Date.now() - activityAt >= (range === '60m' ? 60000 : 300000);
    const needed = [...ids].filter(id => due || !requestedActivityIds.has(id));
    if (!needed.length) return;
    if (activityRequest) {
      activityQueued = true;
      return;
    }
    const gen = activityGen;
    const groups = new Map(due ? [] : Object.entries(activity?.groups ?? {}).filter(([id]) => ids.has(id)));
    const batches = [];
    for (let i = 0; i < needed.length; i += 100) {
      const params = new URLSearchParams({ range, ids: needed.slice(i, i + 100).join(',') });
      batches.push(withRequestTimeout(signal => read('/api/groups/activity?' + params, { signal }), REQUEST_TIMEOUT_MS));
    }
    activityRequest = Promise.all(batches);
    try {
      const values = await activityRequest;
      if (gen !== activityGen) return;
      for (const { groups: entries, start, cellSeconds, inboundError } of values) {
        for (const [id, value] of Object.entries(entries)) {
          // A newly loaded page can cross a bucket boundary while older rows are still fresh.
          groups.set(id, { ...value, start, cellSeconds, inboundUnknown: Boolean(inboundError) });
        }
      }
      activity = { groups: Object.fromEntries(groups), inboundError: [...groups.values()].some(group => group.inboundUnknown) || values.some(value => value.inboundError) };
      if (due) activityAt = Date.now();
      requestedActivityIds = ids;
      redraw();
    } catch {} finally {
      if (gen === activityGen) {
        activityRequest = null;
        if (activityQueued) {
          activityQueued = false;
          refreshActivity();
        }
      }
    }
  }
  const changeDetail = () => mode.setDetailLevel(toggle.checked ? 'technical' : 'plain');
  const input = () => {
    moreRequest = null;
    search.input(searchInput.value);
  };
  function changeRange(value) {
    range = value === '6h' ? '6h' : '60m';
    resetActivity();
    try { storage.setItem('zylos-dashboard-activity-range', range); } catch {}
    redraw();
    refreshActivity();
  }
  const typing = target => ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable;
  // Esc closes the open drawer; j/k and arrow keys move between board rows.
  const keydown = event => {
    if (!visible() || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      // The answer closes with Esc; while sending it stays, so the result of the request is not lost.
      if (nameDialog && !nameDialog.hidden) { if (nameFlow?.state === 'answered') endNameFlow(); return; }
      if (hostPanel.active) { hostPanel.close(); redraw(); return; }
      if (groupDetail.escape()) redraw();
      return;
    }
    if (typing(event.target) || event.altKey || event.ctrlKey || event.metaKey) return;
    const step = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    const rows = [...board.children].filter(node => node.classList.contains('wb-row'));
    if (!rows.length) return;
    const index = rows.indexOf(document.activeElement);
    rows[index < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, index + step))].focus();
    event.preventDefault?.();
  };
  const visibility = () => {
    if (document.visibilityState === 'visible') { instanceRead = null; controller.refresh(); costController.refresh(); }
  };
  // An installed-but-unavailable observer still opens its page, which explains why and links to settings.
  const observerClick = event => {
    if (observerEntry()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  toggle.checked = mode.detailLevel() === 'technical';
  toggle.addEventListener('change', changeDetail);
  const unsubscribe = mode.subscribe(redraw);
  searchInput.addEventListener('input', input);
  document.addEventListener('keydown', keydown);
  nav?.addEventListener('click', observerClick, true);
  document.addEventListener('visibilitychange', visibility);
  const localeChange = () => redraw();
  document.addEventListener('dashboard-locale-change', localeChange);
  let previousVisible = visible(), previousPageActive = pageActive();
  function syncPageOpen() {
    const opened = pageActive();
    if (opened && !previousPageActive) refreshFirstPage();
    previousPageActive = opened;
    return opened;
  }
  const observer = window.MutationObserver ? new window.MutationObserver(() => {
    const changed = resetOwner();
    const active = visible();
    syncNav();
    if (active && (changed || !previousVisible)) instanceRead = null;
    if (!syncPageOpen()) hostPanel.close();
    if (active && (changed || !previousVisible)) { controller.refresh(); costController.refresh(); }
    previousVisible = active;
  }) : null;
  if (nav) observer?.observe(nav, { attributes: true, attributeFilter: ['hidden'] });
  observer?.observe(document.querySelector('#tab-overview'), { attributes: true, attributeFilter: ['class'] });
  const detail = document.querySelector('#agent-detail');
  if (detail) observer?.observe(detail, { attributes: true, attributeFilter: ['hidden'] });
  // Navigation can change the viewed agent without changing the active tab.
  window.addEventListener('popstate', visibility);
  redraw();
  controller.start();
  costController.start();
  refreshMode();
  const modeTimer = setInterval(() => { if (visible()) instanceRead = null; return refreshMode(); }, 60000);
  function destroy() {
    stopped = true;
    moreRequest = null;
    pendingButton.remove();
    sides.remove();
    controller.stop();
    costController.stop();
    groupDetail.destroy();
    hostPanel.destroy();
    labels.destroy();
    nameRequest?.abort();
    nameButton?.removeEventListener('click', autoName);
    clearInterval(modeTimer);
    search.destroy();
    unsubscribe();
    activityGen++;
    observer?.disconnect();
    toggle.removeEventListener('change', changeDetail);
    searchInput.removeEventListener('input', input);
    document.removeEventListener('keydown', keydown);
    nav?.removeEventListener('click', observerClick, true);
    document.removeEventListener('visibilitychange', visibility);
    document.removeEventListener('dashboard-locale-change', localeChange);
    window.removeEventListener('popstate', visibility);
  }
  return {
    setViewDetail: redraw,
    applyInstance(instance) {
      instanceRead = { owner: identity(), promise: Promise.resolve(instance) };
      transition = instance.session_mode?.transition ?? null;
      if (snapshot) snapshot = groupSnapshot(instance, snapshot.groupCounts, snapshot);
      redraw();
    },
    refresh(counts) {
      pushedCounts = counts ?? null;
      if (snapshot && counts) { snapshot = groupSnapshot(snapshot.instance, counts, snapshot); redraw(); }
      return controller.refresh().finally(() => { pushedCounts = null; });
    },
    selectedGroup: () => groupDetail?.state.row?.sessionGroup,
    async locateGroup(key) {
      if (stopped) return;
      resetOwner();
      syncPageOpen();
      groupDetail.close();
      hostPanel.close();
      search.input('');
      searchInput.value = '';
      locatedRow = null;
      const captured = identity(), generation = ++locateGeneration;
      let groups, selected;
      try {
        if (key) {
          selected = displayGroupRow(await read(groupDetailPath(key)));
          if (stopped || captured !== identity() || generation !== locateGeneration || !pageActive()) return;
          const side = selected.state?.kind === 'offline' ? 'offline' : 'running';
          if (side !== groupSide) { groupDepth = 1; groupPending.clear(); }
          controller.invalidate();
          groupSide = side;
        }
        groups = await readGroupSnapshot(read, { side: groupSide, pages: groupDepth });
      } catch { return; }
      if (stopped || captured !== identity() || generation !== locateGeneration || !pageActive()) return;
      snapshot = groups;
      locatedRow = selected && (groupSide === 'offline' || !snapshot.rows.some(row => row.sessionGroup === key)) ? selected : null;
      groupDetail.updateSnapshot(snapshot);
      locatedGroup = key || snapshot?.rows.find(row => row.flags?.startFailed || row.flags?.blocked?.reason === 'auth_failed')?.sessionGroup;
      redraw();
      refreshActivity();
      const row = [...board.querySelectorAll('.wb-row')].find(node => node.dataset.group === locatedGroup);
      row?.focus();
      row?.scrollIntoView({ block: 'center' });
    },
    async openGroup(key) {
      if (stopped) return;
      resetOwner();
      syncPageOpen();
      const captured = identity(), generation = ++locateGeneration;
      hostPanel.close();
      // A newly selected machine has no snapshot yet. Resolve its live names before
      // opening detail, rather than permanently treating this selection as historical.
      if (!snapshot) {
        let groups;
        try { groups = await readGroupSnapshot(read, { side: groupSide, pages: groupDepth }); } catch { return; }
        if (stopped || captured !== identity() || generation !== locateGeneration || !pageActive()) return;
        snapshot = groups;
      }
      return groupDetail.open(key, snapshot);
    },
    destroy,
  };
}
