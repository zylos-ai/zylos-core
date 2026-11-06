import { element, fallbackName } from './plain-text.js?v=84';
import { toolLabel, waitText } from './view-mode.js?v=84';
import { activityStrip } from './activity-strip.js?v=84';
import { createFetchGuard } from './fetch-guard.js?v=84';
const same = (a, b) => a.runtime === b.runtime && a.mode === b.mode &&
  (a.mode === 'default' || (a.model === b.model && a.effort === b.effort));
export function modelCell(row, t = key => key) {
  if (['running', 'starting'].includes(row.presence) && !row.launchConfig && row.target?.reason === 'launch_config_unreadable') {
    return [row.target.runtime, t('wb.unknown')].filter(Boolean).join(' · ');
  }
  const value = ['running', 'starting'].includes(row.presence) && row.launchConfig ? row.launchConfig : row.target?.runtime ? row.target : null;
  return value ? [value.runtime, typeof value.model === 'object' ? value.model?.model : value.model ?? value.mode,
    value.effort ?? value.model?.effort].filter(Boolean).join(' · ') : '—';
}
export function pendingModel(row) {
  return !row.target?.onlyMulti && Boolean((row.presence === 'running' && row.launchConfig && row.desired &&
    !same(row.launchConfig, row.desired)) || row.fence?.reason === 'model_config');
}
export function renderRow(row, { document, level = 'plain', activity, single = false, t = key => key, onSelect = () => {} }) {
  const root = element(document, 'button', undefined, 'wb-row'); root.type = 'button';
  const name = element(document, 'span', single ? t('wb.single') : row.name?.displayName ??
    (level === 'technical' ? row.sessionGroup : fallbackName(row, t)) ?? t('wb.single'), 'wb-name');
  if (level === 'technical' && row.name?.displayName && !single) name.append(element(document, 'small', row.sessionGroup));
  root.append(name);
  const state = element(document, 'span', t(`wb.state.${row.state?.kind ?? 'unknown'}`), `wb-state wb-${row.state?.kind ?? 'unknown'}`);
  if (row.duration != null) state.append(element(document, 'small', ` · ${Math.floor(row.duration / 60)}m ${Math.floor(row.duration % 60)}s`));
  if (level === 'technical') state.title = [row.state?.reason ?? row.state?.reasonCode, row.state?.sampledAt].filter(v => v != null).join(' · ');
  root.append(state);
  const tool = row.tools?.[0];
  const current = element(document, 'span', tool ? toolLabel(tool.name, level, t) +
    (level === 'technical' ? ` ${tool.detail ?? ''}` : '') : row.wait ? waitText({ ...row.wait, pendingCount: row.queue?.pending?.count }, level, t) : row.preview?.text ?? '', 'wb-current');
  if (tool) current.title = tool.name;
  root.append(current, activityStrip(document, activity, { inboundUnknown: activity?.inboundUnknown, t }));
  if (level === 'technical') {
    root.append(element(document, 'span', !row.queue ? '—' : row.queue.known === false ? t('wb.unknown') :
      `${row.queue.pending?.count ?? 0} · ${row.queue.running?.count ?? 0}`, 'wb-queue'));
    const context = element(document, 'span', row.contextPct == null ? t('wb.unknown') : `${Math.round(row.contextPct)}%`, 'wb-context');
    if (row.contextPct != null) { context.classList.add('wb-context-ring'); context.style.setProperty('--context', `${Math.max(0, Math.min(100, row.contextPct))}%`); }
    else context.title = row.contextReason ?? '';
    root.append(context, element(document, 'span', modelCell(row, t) + (!single && pendingModel(row) ? ` · ${t('wb.pending')}` : ''), 'wb-model'));
  }
  root.addEventListener('click', () => onSelect(row));
  return root;
}
export function renderBoard(root, snapshot, { rows = snapshot?.rows ?? [], query = '', document = root.ownerDocument,
  t = key => key, activity, onSearch = () => {}, ...options } = {}) {
  root.replaceChildren();
  if (!rows.length) root.append(element(document, 'p', t(query ? 'wb.noMatch' : 'wb.noGroups')));
  for (const row of rows) root.append(renderRow(row, { document, t, single: snapshot?.view === 'single',
    activity: activity ? { ...activity.groups?.[row.sessionGroup], start: activity.start, cellSeconds: activity.cellSeconds,
      inboundUnknown: Boolean(activity.inboundError) } : null, ...options }));
  if (snapshot?.hasOlder === true && !query) {
    const older = element(document, 'button', t('wb.older'), 'wb-older'); older.type = 'button';
    older.addEventListener('click', onSearch); root.append(older);
  }
}
export function boardController({ fetchSnapshot, onSnapshot, onError, visible = () => true, now = Date.now,
  setTimer = setInterval, clearTimer = clearInterval }) {
  const guard = createFetchGuard(); let timer, lastSuccess = null;
  async function refresh() {
    if (!visible()) return;
    const gen = guard.next();
    try { const value = await fetchSnapshot(); if (guard.current(gen)) { lastSuccess = now(); onSnapshot(value); } }
    catch (error) { if (guard.current(gen)) onError(error, lastSuccess); }
  }
  return { refresh, invalidate() { guard.invalidate(); lastSuccess = null; },
    start() { refresh(); timer = setTimer(refresh, 5000); }, stop() { clearTimer(timer); guard.invalidate(); } };
}
