import { createViewMode, groupObservable, observerNavEntry } from './view-mode.js?v=115';
import { boardController, renderBoard, renderDistribution } from './board.js?v=115';
import { createBoardSearch } from './board-search.js?v=87';
import { instanceStrip } from './instance-strip.js?v=117';
import { renderAttention } from './attention-bar.js?v=104';
import { createGroupDetail } from './detail.js?v=115';
import { loadNamePrompt, renderAutoName } from './auto-name.js?v=104';
import { createHostPanel } from './host-panel.js?v=104';
import { element, icon } from './plain-text.js?v=104';

export function mountWorkbench({ document = globalThis.document, window = globalThis.window, t = key => key,
  endpoint = path => path, identity = () => endpoint('/api/workbench/groups'),
  observerStatus = () => null, observerAvailable = () => true, onObserve = () => {},
  writable = () => true, onMemory = () => {}, onConversation, instanceInfo = () => ({}),
  storage = globalThis.localStorage, fetch = globalThis.fetch } = {}) {
  const board = document.querySelector('#wb-board');
  if (!board) return { openGroup: async () => {}, setViewDetail() {}, destroy() {} };
  const mode = createViewMode({ storage, document });
  const searchInput = document.querySelector('#wb-search');
  const rangeInput = document.querySelector('#wb-range');
  const toggle = document.querySelector('#wb-detail-toggle');
  const nav = document.querySelector('#observer-tab');
  let groupDetail = null, hostPanel = null, nameRequest = null;
  const nameButton = document.querySelector('#wb-auto-name');
  const nameDialog = document.querySelector('#wb-auto-name-dialog');
  let snapshot = null, searchRows = null, error = null, lastSuccess = null, activity = null, activityAt = 0,
    range = '60m', activityGen = 0, cost = null, transition = null, owner = identity(), stopped = false;
  try {
    if (storage.getItem('zylos-dashboard-activity-range') === '6h') range = '6h';
  } catch {}
  const read = async path => {
    const captured = identity();
    const response = await fetch(endpoint(path));
    if (captured !== identity() || stopped) {
      if (!stopped) resetOwner();
      throw Error('view_changed');
    }
    if (!response.ok) throw Error('read_failed');
    const value = await response.json();
    if (captured !== identity() || stopped) {
      if (!stopped) resetOwner();
      throw Error('view_changed');
    }
    return value;
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
      nameButton.disabled = !writable();
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
    const dist = document.querySelector('#wb-dist');
    if (dist) renderDistribution(dist, snapshot, { document, t, level });
    searchInput.placeholder = t('wb.search');
    searchInput.setAttribute('aria-label', t('wb.search'));
    const attention = document.querySelector('#wb-attention');
    renderAttention(attention, snapshot, { document, t, error, lastSuccess, level, onSelect: openFromAttention });
    if (transition) {
      const hint = element(document, 'div', undefined, 'wb-attention-item wb-attention-reminder wb-transition');
      hint.append(icon(document, 'clock'), element(document, 'span', t('wb.transition') + ' · ' + transition.phase));
      attention.append(hint);
    }
    syncSide();
    if (!snapshot) return;
    instanceStrip(document.querySelector('#wb-instance'), snapshot, { document, t, costSummary: cost, level,
      hostOpen: Boolean(hostPanel?.active), onHost: () => { if (hostPanel.active) hostPanel.close(); else { void hostPanel.open(); redraw(); } } });
    const fresh = new Map(snapshot.rows.map(row => [row.sessionGroup, row]));
    const rows = searchRows?.map(row => fresh.get(row.sessionGroup) ?? row) ?? snapshot.rows;
    renderBoard(board, snapshot, {
      rows, query: search.query(), activity, document, t, level,
      selected: groupDetail?.state.row ? groupDetail.state.row.sessionGroup : undefined,
      onSearch: () => searchInput.focus(),
      onSelect: selectRow,
    });
  }
  function selectRow(row) {
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
    fetchRows: q => read('/api/workbench/groups/search?q=' + encodeURIComponent(q)),
    onRows: rows => {
      searchRows = rows;
      redraw();
    },
    onClear: () => {
      searchRows = null;
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
    groupDetail?.close();
    hostPanel?.close();
    nameRequest?.abort();
    if (nameDialog) { nameDialog.hidden = true; nameDialog.replaceChildren(); }
    controller.invalidate();
    search.input('');
    searchInput.value = '';
    snapshot = null;
    searchRows = null;
    activity = null;
    activityAt = 0;
    activityGen++;
    cost = null;
    transition = null;
    error = null;
    for (const selector of ['#wb-board', '#wb-instance', '#wb-attention', '#wb-side']) {
      document.querySelector(selector)?.replaceChildren();
    }
    document.querySelector('#wb-side').hidden = true;
    return true;
  }
  const visible = () => {
    resetOwner();
    return document.visibilityState !== 'hidden' && document.querySelector('#tab-overview')?.classList.contains('active') &&
      !document.querySelector('#agent-detail')?.hidden;
  };
  groupDetail = createGroupDetail({ root: document.querySelector('#wb-side'), document, t,
    fetch: (path, options) => fetch(endpoint(path), options), identity, writable,
    detail: () => mode.detailLevel(), isVisible: visible, onMemory, onConversation, onObserve,
    observable: row => groupObservable(observerEntry(), row),
    onRename: () => controller.refresh(), onClose: () => { if (!stopped) redraw(); },
  });
  hostPanel = createHostPanel({ root: document.querySelector('#wb-side'), document, t, read, identity,
    detail: () => mode.detailLevel(), onOpen: () => groupDetail.close(), onClose: () => { if (!stopped) redraw(); },
    meta: () => ({ ...instanceInfo(), mode: snapshot?.mode && snapshot.mode !== 'unreadable' ? t('wb.mode') + ' ' + snapshot.mode : null }),
    onUsage: () => document.querySelector('.tab[data-tab="trends"]')?.click?.() });
  const autoName = async () => {
    if (!writable() || !nameDialog) return;
    nameRequest?.abort();
    nameRequest = new AbortController();
    const captured = identity(), signal = nameRequest.signal;
    const current = () => !stopped && !signal.aborted && captured === identity();
    nameDialog.hidden = false;
    nameDialog.replaceChildren(element(document, 'p', t('wb.name.loading')));
    try {
      const value = await loadNamePrompt({ request: async path => {
        const response = await fetch(endpoint(path), { signal });
        if (!response.ok) throw Error('read_failed');
        return response.json();
      } });
      if (!current()) return;
      renderAutoName(nameDialog, value, { document, t,
        onClose: () => { nameDialog.hidden = true; nameDialog.replaceChildren(); } });
    } catch (error) {
      if (current()) {
        const close = element(document, 'button', t('wb.close'));
        close.type = 'button'; close.addEventListener('click', () => { nameDialog.hidden = true; });
        nameDialog.replaceChildren(element(document, 'p', t('wb.readFailed')), close);
      }
    }
  };
  nameButton?.addEventListener('click', autoName);
  const controller = boardController({
    visible,
    fetchSnapshot: async () => {
      const [groups, expense] = await Promise.allSettled([
        read('/api/workbench/groups'), read('/api/workbench/usage?summary=cost'),
      ]);
      if (groups.status !== 'fulfilled') throw groups.reason;
      return {
        snapshot: groups.value,
        cost: expense.status === 'fulfilled' ? expense.value.costSummary : null,
      };
    },
    onSnapshot: value => {
      snapshot = value.snapshot;
      groupDetail.updateSnapshot(snapshot);
      cost = value.cost;
      error = null;
      lastSuccess = Date.now();
      redraw();
      refreshActivity();
    },
    onError: (_, at) => {
      error = true;
      lastSuccess = at;
      redraw();
    },
  });
  async function refreshMode() {
    if (!visible()) return;
    try {
      const value = await read('/api/session-mode');
      transition = value?.data?.transition ?? null;
    } catch {
      transition = null;
    }
    if (!stopped) redraw();
  }
  async function refreshActivity(force = false) {
    if (!force && Date.now() - activityAt < (range === '60m' ? 60000 : 300000)) return;
    const gen = ++activityGen;
    try {
      const value = await read('/api/workbench/activity?range=' + range);
      if (gen !== activityGen) return;
      activity = value;
      activityAt = Date.now();
      redraw();
    } catch {}
  }
  const changeDetail = () => mode.setDetailLevel(toggle.checked ? 'technical' : 'plain');
  const input = () => search.input(searchInput.value);
  function changeRange(value) {
    range = value === '6h' ? '6h' : '60m';
    try { storage.setItem('zylos-dashboard-activity-range', range); } catch {}
    redraw();
    refreshActivity(true);
  }
  const typing = target => ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable;
  // Esc closes the open drawer; j/k and arrow keys move between board rows.
  const keydown = event => {
    if (!visible() || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      if (nameDialog && !nameDialog.hidden) { nameDialog.hidden = true; nameDialog.replaceChildren(); return; }
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
    if (document.visibilityState === 'visible') controller.refresh();
    else hostPanel.close();
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
  let previousVisible = visible();
  const observer = window.MutationObserver ? new window.MutationObserver(() => {
    const changed = resetOwner();
    const active = visible();
    syncNav();
    if (active && (changed || !previousVisible)) controller.refresh();
    if (!active) hostPanel.close();
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
  refreshMode();
  const modeTimer = setInterval(refreshMode, 60000);
  function destroy() {
    stopped = true;
    controller.stop();
    groupDetail.destroy();
    hostPanel.destroy();
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
    selectedGroup: () => groupDetail?.state.row?.sessionGroup,
    openGroup(key) {
      if (stopped) return Promise.resolve();
      resetOwner();
      hostPanel.close();
      return groupDetail.open(key, snapshot ?? { rows: [], listKnown: false });
    },
    destroy,
  };
}
