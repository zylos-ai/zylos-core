import { createViewMode, observerNavEntry } from './view-mode.js?v=81';
import { boardController, renderBoard } from './board.js?v=81';
import { createBoardSearch } from './board-search.js?v=81';
import { instanceStrip } from './instance-strip.js?v=81';
import { renderAttention } from './attention-bar.js?v=81';
import { showSidePanel } from './side-panel.js?v=81';
import { element } from './plain-text.js?v=81';
export function mountWorkbench({ document = globalThis.document, window = globalThis.window, t = key => key,
  endpoint = path => path, identity = () => endpoint('/api/workbench/groups'), openSettings = () => {},
  observerStatus = () => null, storage = globalThis.localStorage, fetch = globalThis.fetch } = {}) {
  const board = document.querySelector('#wb-board'); if (!board) return () => {};
  const mode = createViewMode({ storage, document });
  const searchInput = document.querySelector('#wb-search'), rangeInput = document.querySelector('#wb-range');
  const toggle = document.querySelector('#wb-detail-toggle'), nav = document.querySelector('#observer-tab');
  let snapshot = null, searchRows = null, error = null, lastSuccess = null, activity = null, activityAt = 0,
    range = '60m', activityGen = 0, cost = null, transition = null, owner = identity(), stopped = false;
  try { if (storage.getItem('zylos-dashboard-activity-range') === '6h') range = '6h'; } catch {}
  rangeInput.value = range;
  const read = async path => {
    const captured = identity(), response = await fetch(endpoint(path));
    if (captured !== identity() || stopped) { if (!stopped) resetOwner(); throw Error('view_changed'); }
    if (!response.ok) throw Error('read_failed');
    const value = await response.json();
    if (captured !== identity() || stopped) { if (!stopped) resetOwner(); throw Error('view_changed'); }
    return value;
  };
  const syncNav = () => {
    const entry = observerNavEntry(observerStatus(), mode.detailLevel(), t);
    if (nav) { if (nav.hidden !== !entry) nav.hidden = !entry; if (nav.textContent !== (entry?.label ?? '')) nav.textContent = entry?.label ?? ''; }
  };
  function redraw() {
    syncNav();
    const legend = document.querySelector('#wb-legend');
    if (legend) { legend.replaceChildren(); for (const state of ['idle', 'busy', 'waiting', 'error', 'none']) {
      const item = element(document, 'span', t('wb.state.' + state), 'wb-legend-item');
      item.append(element(document, 'i', undefined, 'wb-bucket wb-' + state)); legend.append(item);
    } legend.append(element(document, 'span', t(activity?.inboundError ? 'wb.inboundUnknown' : 'wb.inboundLegend'))); }
    searchInput.placeholder = t('wb.search'); searchInput.setAttribute('aria-label', t('wb.search'));
    const attention = document.querySelector('#wb-attention');
    renderAttention(attention, snapshot, { document, t, error, lastSuccess, level: mode.detailLevel() });
    if (transition) attention.append(element(document, 'p', t('wb.transition') + ' · ' + transition.phase, 'wb-transition'));
    if (!snapshot) return;
    instanceStrip(document.querySelector('#wb-instance'), snapshot, { document, t, cost, level: mode.detailLevel() });
    const fresh = new Map(snapshot.rows.map(row => [row.sessionGroup, row]));
    const rows = searchRows?.map(row => fresh.get(row.sessionGroup) ?? row) ?? snapshot.rows;
    renderBoard(board, snapshot, { rows, query: search.query(), activity, document, t, level: mode.detailLevel(),
      onSearch: () => searchInput.focus(), onSelect: row => showSidePanel(document.querySelector('#wb-side'),
        snapshot.view === 'single' ? { ...row, name: { displayName: t('wb.single') } } : row, { document, t }) });
  }
  const search = createBoardSearch({ fetchRows: q => read('/api/workbench/groups/search?q=' + encodeURIComponent(q)),
    onRows: rows => { searchRows = rows; redraw(); }, onClear: () => { searchRows = null; redraw(); },
    onError: () => { error = true; redraw(); } });
  function resetOwner() {
    if (owner === identity()) return false;
    owner = identity(); controller.invalidate(); search.input(''); searchInput.value = '';
    snapshot = null; searchRows = null; activity = null; activityAt = 0; activityGen++; cost = null; transition = null; error = null;
    for (const selector of ['#wb-board', '#wb-instance', '#wb-attention', '#wb-side']) document.querySelector(selector)?.replaceChildren();
    document.querySelector('#wb-side').hidden = true;
    return true;
  }
  const visible = () => {
    resetOwner();
    return document.visibilityState !== 'hidden' && document.querySelector('#tab-overview')?.classList.contains('active') &&
      !document.querySelector('#agent-detail')?.hidden;
  };
  const controller = boardController({ visible,
    fetchSnapshot: async () => {
      const [groups, expense, sessionMode] = await Promise.allSettled([read('/api/workbench/groups'),
        read('/api/metrics/aggregate?metric=cost&period=today'), read('/api/session-mode')]);
      if (groups.status !== 'fulfilled') throw groups.reason;
      return { snapshot: groups.value, cost: expense.status === 'fulfilled' ? expense.value.value : null,
        transition: sessionMode.status === 'fulfilled' ? sessionMode.value?.data?.transition : null };
    },
    onSnapshot: value => { snapshot = value.snapshot; cost = value.cost; transition = value.transition;
      error = null; lastSuccess = Date.now(); redraw(); refreshActivity(); },
    onError: (_, at) => { error = true; lastSuccess = at; redraw(); } });
  async function refreshActivity(force = false) {
    if (!force && Date.now() - activityAt < (range === '60m' ? 60000 : 300000)) return;
    const gen = ++activityGen;
    try { const value = await read('/api/workbench/activity?range=' + range);
      if (gen !== activityGen) return; activity = value; activityAt = Date.now(); redraw(); } catch {}
  }
  const changeDetail = () => mode.setDetailLevel(toggle.checked ? 'technical' : 'plain');
  const input = () => search.input(searchInput.value);
  const changeRange = () => { range = rangeInput.value === '6h' ? '6h' : '60m';
    try { storage.setItem('zylos-dashboard-activity-range', range); } catch {} refreshActivity(true); };
  const visibility = () => { if (document.visibilityState === 'visible') controller.refresh(); };
  const observerClick = event => {
    const entry = observerNavEntry(observerStatus(), mode.detailLevel(), t);
    if (!entry || entry.target === 'settings') { event.preventDefault(); event.stopImmediatePropagation(); if (entry) openSettings('observer'); }
  };
  toggle.checked = mode.detailLevel() === 'technical'; toggle.addEventListener('change', changeDetail);
  const unsubscribe = mode.subscribe(redraw);
  searchInput.addEventListener('input', input); rangeInput.addEventListener('change', changeRange);
  nav?.addEventListener('click', observerClick, true); document.addEventListener('visibilitychange', visibility);
  const localeChange = () => redraw(); document.addEventListener('dashboard-locale-change', localeChange);
  let previousVisible = visible();
  const observer = window.MutationObserver ? new window.MutationObserver(() => {
    const changed = resetOwner(), active = visible(); syncNav();
    if (active && (changed || !previousVisible)) controller.refresh(); previousVisible = active;
  }) : null;
  if (nav) observer?.observe(nav, { attributes: true, attributeFilter: ['hidden'] });
  observer?.observe(document.querySelector('#tab-overview'), { attributes: true, attributeFilter: ['class'] });
  const detail = document.querySelector('#agent-detail'); if (detail) observer?.observe(detail, { attributes: true, attributeFilter: ['hidden'] });
  // Navigation can change the viewed agent without changing the active tab.
  window.addEventListener('popstate', visibility);
  redraw(); controller.start();
  return () => { stopped = true; controller.stop(); search.destroy(); unsubscribe(); activityGen++; observer?.disconnect();
    toggle.removeEventListener('change', changeDetail); searchInput.removeEventListener('input', input); rangeInput.removeEventListener('change', changeRange);
    nav?.removeEventListener('click', observerClick, true); document.removeEventListener('visibilitychange', visibility);
    document.removeEventListener('dashboard-locale-change', localeChange); window.removeEventListener('popstate', visibility); };
}
