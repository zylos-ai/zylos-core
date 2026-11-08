import { chatKind, element, fallbackName, icon, platformOf, runtimeName } from './plain-text.js?v=103';
import { toolLabel, waitText } from './view-mode.js?v=99';
import { activityStrip } from './activity-strip.js?v=103';
import { createFetchGuard } from './fetch-guard.js?v=85';
const same = (a, b) => a.runtime === b.runtime && a.mode === b.mode &&
  (a.mode === 'default' || (a.model === b.model && a.effort === b.effort));
export function modelCell(row, t = key => key) {
  if (['running', 'starting'].includes(row.presence) && !row.launchConfig && row.target?.reason === 'launch_config_unreadable') {
    return [runtimeName(row.target.runtime), t('wb.unknown')].filter(Boolean).join(' · ');
  }
  const value = ['running', 'starting'].includes(row.presence) && row.launchConfig ? row.launchConfig : row.target?.runtime ? row.target : null;
  return value ? [runtimeName(value.runtime), typeof value.model === 'object' ? value.model?.model : value.model ?? value.mode,
    value.effort ?? value.model?.effort].filter(Boolean).join(' · ') : '—';
}
export function pendingModel(row) {
  return !row.target?.onlyMulti && Boolean((row.presence === 'running' && row.launchConfig && row.desired &&
    !same(row.launchConfig, row.desired)) || row.fence?.reason === 'model_config');
}
/** Compact elapsed time: 42s, 4m12s, 41m, 2h05m. */
export function shortDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + (m < 10 ? String(s % 60).padStart(2, '0') + 's' : '');
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
}
export function statePill(document, row, { t = key => key, level = 'plain' } = {}) {
  const kind = row.state?.kind ?? 'unknown';
  const pill = element(document, 'span', undefined, `wb-state wb-pill wb-${kind}`);
  pill.append(element(document, 'i', undefined, 'wb-dot'), element(document, 'span', t(`wb.state.${kind}`)));
  if (row.duration != null && !['not_running', 'unknown'].includes(kind)) pill.append(element(document, 'span', shortDuration(row.duration), 'wb-dur'));
  if (level === 'technical') pill.title = [row.state?.reason ?? row.state?.reasonCode, row.state?.sampledAt].filter(v => v != null).join(' · ');
  return pill;
}
const channelIcons = { origin: 'origin', telegram: 'send', lark: 'msg', feishu: 'msg', wechat: 'msg', 'web-console': 'monitor', openmax: 'hex' };
export const channelIcon = row => row.sessionGroup == null || row.sessionGroup === 'origin' ? 'origin'
  : channelIcons[platformOf(row)] ?? 'hex';
export function contextRing(document, pct, reason = '') {
  const ring = element(document, 'span', pct == null ? '—' : String(Math.round(pct)), 'wb-context');
  if (pct == null) { ring.title = reason; return ring; }
  ring.classList.add('wb-context-ring');
  if (pct >= 75) ring.classList.add('wb-hi');
  ring.style.setProperty('--context', `${Math.max(0, Math.min(100, pct))}%`);
  return ring;
}
function nameCell(document, row, { level, single, t }) {
  const cell = element(document, 'span', undefined, 'wb-name');
  const origin = row.sessionGroup == null || row.sessionGroup === 'origin';
  const box = element(document, 'span', undefined, 'wb-ch');
  box.append(icon(document, channelIcon(row)));
  const text = element(document, 'span', undefined, 'wb-name-text');
  const name = element(document, 'span', single ? t('wb.single') : row.name?.displayName ??
    (level === 'technical' ? row.sessionGroup : fallbackName(row, t)) ?? t('wb.single'), 'wb-nm');
  if (origin && !single && level === 'technical') name.append(element(document, 'small', t('wb.board.noPool'), 'wb-tag'));
  const sub = level === 'technical'
    ? (origin ? (single ? null : t('wb.board.originTech')) : row.name?.displayName ? row.sessionGroup : null)
    : origin ? t('wb.board.originPlain') : platformLabel(row, t);
  text.append(name);
  if (sub) text.append(element(document, 'small', sub, level === 'technical' && !origin ? 'wb-key wb-mono' : 'wb-key'));
  cell.append(box, text);
  return cell;
}
export function platformLabel(row, t, { describe = true } = {}) {
  const platform = platformOf(row), kind = chatKind(row);
  if (platform === 'web-console' && describe) return t('wb.board.webConsole');
  return fallbackName({ ...row, sessionGroup: platform, name: null }, t) + (kind ? ' · ' + t('wb.chat.' + kind) : '');
}
function nowCell(document, row, { level, t }) {
  const tool = row.tools?.[0];
  const current = element(document, 'span', undefined, 'wb-current');
  if (tool) {
    current.append(icon(document, 'tool', 'xs'));
    const label = element(document, 'span', toolLabel(tool.name, level, t), level === 'technical' ? 'wb-tool wb-tool-label' : 'wb-tool-label');
    current.append(label);
    if (level === 'technical' && tool.detail) current.append(element(document, 'span', ' · ' + tool.detail, 'wb-sub'));
    else if (level !== 'technical' && row.preview?.text) current.append(element(document, 'span', ' · ' + t('wb.board.lastIn', { text: row.preview.text }), 'wb-sub'));
    current.title = tool.name;
    return current;
  }
  const text = row.wait ? waitText({ ...row.wait, pendingCount: row.queue?.pending?.count }, level, t)
    : row.preview?.text ? t('wb.board.lastReceived', { text: row.preview.text })
      : row.state?.kind === 'not_running' && level !== 'technical' ? t('wb.board.standby') : '';
  current.append(element(document, 'span', text));
  current.title = text;
  return current;
}
export function renderRow(row, { document, level = 'plain', activity, single = false, selected = false, t = key => key, onSelect = () => {} }) {
  const root = element(document, 'button', undefined, 'wb-row'); root.type = 'button';
  if (row.sessionGroup == null || row.sessionGroup === 'origin') root.classList.add('wb-row-origin');
  if (selected) { root.classList.add('wb-sel'); root.setAttribute('aria-current', 'true'); }
  root.dataset.group = row.sessionGroup ?? '';
  root.append(nameCell(document, row, { level, single, t }), statePill(document, row, { t, level }),
    nowCell(document, row, { level, t }), activityStrip(document, activity, { inboundUnknown: activity?.inboundUnknown, t }));
  if (level === 'technical') {
    const queue = element(document, 'span', undefined, 'wb-queue');
    if (!row.queue) queue.textContent = '—';
    else if (row.queue.known === false) queue.textContent = t('wb.unknown');
    else queue.append(element(document, 'b', row.queue.pending?.count ?? 0), element(document, 'span', ` · ${row.queue.running?.count ?? 0}`));
    queue.title = t('wb.board.queueHint');
    const model = element(document, 'span', modelCell(row, t), 'wb-model');
    if (!single && pendingModel(row)) {
      const desired = row.desired;
      const value = desired?.mode === 'override' ? [desired.model, desired.effort].filter(Boolean).join(' · ') : desired ? t('wb.term.inherit') : '';
      model.append(element(document, 'small', t('wb.pending') + (value ? '：' + value : ''), 'wb-pend'));
    }
    root.append(queue, contextRing(document, row.contextPct, row.contextReason ?? ''), model);
  }
  root.addEventListener('click', () => onSelect(row));
  return root;
}
export function renderBoard(root, snapshot, { rows = snapshot?.rows ?? [], query = '', document = root.ownerDocument,
  t = key => key, activity, onSearch = () => {}, selected = undefined, ...options } = {}) {
  root.replaceChildren();
  if (!rows.length) root.append(element(document, 'p', t(query ? 'wb.noMatch' : 'wb.noGroups'), 'wb-empty'));
  for (const row of rows) root.append(renderRow(row, { document, t, single: snapshot?.view === 'single',
    selected: selected !== undefined && row.sessionGroup === selected,
    activity: activity ? { ...activity.groups?.[row.sessionGroup], start: activity.start, cellSeconds: activity.cellSeconds,
      inboundUnknown: Boolean(activity.inboundError) } : null, ...options }));
  if (snapshot?.hasOlder === true && !query) {
    const older = element(document, 'button', t('wb.older'), 'wb-older'); older.type = 'button';
    older.addEventListener('click', onSearch); root.append(older);
  }
}
const distOrder = ['busy', 'waiting', 'error', 'unknown', 'idle', 'not_running'];
/** Header summary: listed groups by state; only the listed active groups are counted. */
export function renderDistribution(root, snapshot, { document = root.ownerDocument, t = key => key, level = 'plain' } = {}) {
  root.replaceChildren();
  if (!snapshot) return;
  const counts = snapshot.counts ?? {};
  const total = (snapshot.rows ?? []).length;
  root.append(element(document, 'span', t('wb.board.groups', { count: total }), 'wb-dist-total'));
  for (const kind of distOrder) {
    const count = counts[kind] ?? 0;
    if (!count) continue;
    const item = element(document, 'span', undefined, 'wb-dist-item wb-' + kind);
    item.append(element(document, 'i', undefined, 'wb-dot'), element(document, 'span', level === 'technical' ? count : `${count} ${t('wb.state.' + kind)}`));
    item.title = `${t('wb.state.' + kind)} ${count}`;
    root.append(item);
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
