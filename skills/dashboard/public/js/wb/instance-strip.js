import { element, icon, runtimeName } from './plain-text.js?v=106';
import { recoveryTime } from './cooldown.js?v=89';
import { formatZoned, zonedDay } from './instance-zone.js?v=100';
// Account quota samples are passed through as each runtime reports them: Claude uses
// used_percentage (or utilization), Codex keeps its camelCase usedPercentage.
export const accountUsedPercent = usage => usage?.used_percentage ?? usage?.utilization ?? usage?.usedPercentage ?? null;
export function remainingQuotaPercent(used) {
  if (used == null || used === '' || !Number.isFinite(Number(used))) return null;
  return Math.max(0, Math.min(100, 100 - Number(used)));
}
const quotaHue = remaining => Number((remaining * 1.2).toFixed(2));
export const quotaColor = remaining => `hsl(${quotaHue(remaining)} 75% var(--wb-quota-lightness))`;
export const quotaFillColor = remaining => `hsl(${quotaHue(remaining)} var(--wb-quota-fill-saturation) var(--wb-quota-fill-lightness))`;
export function accountRuntimes(snapshot) {
  return [...new Set([snapshot.baselineRuntime,
    ...(snapshot.rows ?? []).map(row => row.launchConfig?.runtime ?? row.target?.runtime),
    ...['claude', 'codex'].filter(runtime => accountUsedPercent(snapshot.instance?.accounts?.[runtime]) != null)
  ].filter(Boolean))];
}
const clock = at => formatZoned(at, undefined, { hour: '2-digit', minute: '2-digit' });
export function quotaRecordedTime(usage, now = Date.now()) {
  if (usage?.live !== false || !Number.isFinite(usage.recordedAt)) return null;
  const sameDay = zonedDay(usage.recordedAt) === zonedDay(now);
  return formatZoned(usage.recordedAt, undefined, { ...(sameDay ? {} : { month: '2-digit', day: '2-digit' }),
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
export const money = value => value == null ? '—' : '$' + Number(value).toFixed(Math.abs(value) >= 1 ? 2 : 4);
function meter(document, pct) {
  const bar = element(document, 'span', undefined, 'wb-meter');
  const fill = element(document, 'i'); fill.style.width = pct + '%'; fill.style.backgroundColor = quotaFillColor(pct);
  bar.append(fill); return bar;
}
function item(document, ...children) {
  const node = element(document, 'span', undefined, 'wb-inst-item');
  node.append(...children); return node;
}
const finite = value => typeof value === 'number' && Number.isFinite(value);
const gib = bytes => Number((bytes / 1073741824).toFixed(2));
export function poolSource(pool, t) {
  if (pool.capacity == null) return '';
  const record = pool.capacityRecord;
  if (record?.valid !== true) return t('wb.inst.poolUnavailable', { capacity: pool.capacity });
  if (record.fresh !== true) return t('wb.inst.poolExpired', { capacity: pool.capacity });
  if (record.source === 'fixed') return finite(record.kMemory) && pool.capacity > record.kMemory
    ? t('wb.inst.poolFixedAdvice', { capacity: pool.capacity, recommended: record.kMemory }) : t('wb.inst.poolFixed');
  if (record.source === 'auto') return t('wb.inst.poolAuto');
  if (record.source === 'fallback') return t('wb.inst.poolFallback');
  return '';
}
export function poolExplanation(record, t) {
  const parts = [], memory = record?.memory, model = record?.model;
  if (memory && typeof memory === 'object') {
    const fields = [];
    if (memory.source === 'host') fields.push(t('wb.inst.poolMemoryHost'));
    if (memory.source === 'darwin') fields.push(t('wb.inst.poolMemoryDarwin'));
    for (const [field, key] of [['limitBytes', 'poolMemoryLimit'], ['usedBytes', 'poolMemoryUsed'], ['reserveBytes', 'poolMemoryReserve']]) {
      if (finite(memory[field]) && memory[field] >= 0) fields.push(t('wb.inst.' + key, { amount: gib(memory[field]) }));
    }
    if (fields.length) parts.push(fields.join(' · '));
  }
  if (model && typeof model === 'object' && ['default', 'fitted'].includes(model.state)) {
    const fields = [];
    if (model.state === 'default') fields.push(t('wb.inst.poolModelDefault'));
    if (finite(model.slopeBytes) && model.slopeBytes > 0) fields.push(t('wb.inst.poolModelSession', { amount: gib(model.slopeBytes) }));
    if (model.state === 'fitted' && finite(model.interceptBytes)) fields.push(t('wb.inst.poolModelFixed', { amount: gib(model.interceptBytes) }));
    if (finite(model.windowDays) && model.windowDays > 0) fields.push(t('wb.inst.poolModelWindow', { days: model.windowDays }));
    if (fields.length) parts.push(fields.join(' · '));
  }
  if (record?.reason === 'floor') parts.push(t('wb.inst.poolFloor'));
  return parts;
}
/** One-line instance strip; the host button stays at the right end. */
export function instanceStrip(root, snapshot, { document = root.ownerDocument, t = key => key, cost = null, costSummary = null, onHost = () => {}, hostOpen = false, level = 'plain', now = Date.now() } = {}) {
  root.replaceChildren(); const instance = snapshot.instance ?? {};
  const technical = level === 'technical';
  // Run mode in both views: the raw value as a chip when technical, a plain name otherwise.
  const unreadable = snapshot.mode == null || snapshot.mode === 'unreadable';
  const mode = technical ? element(document, 'span', unreadable ? t('wb.unknown') : snapshot.mode, 'wb-mode-chip')
    : element(document, 'span', unreadable ? t('wb.mode') + ' · ' + t('wb.unknown')
      : { multi: t('wb.inst.modeMulti'), single: t('wb.inst.modeSingle') }[snapshot.mode] ?? t('wb.mode') + ' · ' + snapshot.mode);
  mode.title = t('wb.mode'); root.append(item(document, mode));
  const runtimes = accountRuntimes(snapshot);
  for (const runtime of runtimes) {
    const health = instance.runtimeHealth?.[runtime], usage = instance.accounts?.[runtime];
    const box = item(document, element(document, 'i', undefined, `wb-health wb-health-${health?.health ?? 'unknown'}`), element(document, 'b', runtimeName(runtime)));
    box.classList.add('wb-account');
    if (health?.health === 'auth_failed') box.append(element(document, 'span', t(technical ? 'wb.inst.authFailedTech' : 'wb.authFailed'), 'wb-txt-err'));
    else if (['rate_limited', 'recovering'].includes(health?.health)) {
      const at = recoveryTime(health.cooldownUntil, now);
      box.append(element(document, 'span', technical
        ? (at === null ? t('wb.inst.coolingUnknown') : t('wb.inst.cooling', { time: clock(at) }))
        : (at === null ? t('wb.recoveryUnknown') : t('wb.recovery', { time: clock(at) })), 'wb-txt-warn'));
    }
    else {
      const pct = remainingQuotaPercent(accountUsedPercent(usage));
      if (technical) box.append(element(document, 'span', health?.health === 'ok' ? t('wb.inst.ok') : t('wb.unknown')));
      box.append(element(document, 'span', t('wb.week'), 'wb-inst-label'));
      if (pct != null) box.append(meter(document, pct));
      const amount = element(document, 'span', pct == null ? t('wb.quotaUnknown') : Math.round(pct) + '%');
      if (pct != null) amount.style.color = quotaColor(pct);
      box.append(amount);
      box.title = pct == null ? t('wb.quotaUnknown') : t('wb.quotaRemaining', { pct: Math.round(pct) });
      const recordedTime = pct == null ? null : quotaRecordedTime(usage, now);
      if (recordedTime) {
        box.append(element(document, 'small', '· ' + t('wb.quotaRecorded', { time: recordedTime }), 'wb-quota-recorded'));
        box.title += ' · ' + t('wb.quotaRecordedHint');
      }
    }
    root.append(box);
  }
  const pool = instance.pool ?? {}, multi = snapshot.mode === 'multi';
  const used = multi ? pool.used : pool.ready == null ? null : pool.ready + pool.starting;
  const capacity = multi ? pool.capacity ?? null : null;
  const full = used != null && capacity != null && used >= capacity;
  const poolItem = item(document, icon(document, 'layers', 'xs'), element(document, 'span', technical ? t('wb.inst.pool') : t('wb.pool')));
  // The capacity and queue stay whole and the source note wraps only between words. The longer capacity
  // explanations live in the host panel's pool section; the title keeps them for hover.
  poolItem.classList.add('wb-pool');
  poolItem.style.flexWrap = 'wrap'; poolItem.style.maxWidth = '100%';
  if (technical && used != null) {
    const pips = element(document, 'span', undefined, 'wb-pips' + (full ? ' wb-full' : ''));
    for (let i = 0; i < Math.max(used, capacity ?? 0); i++) pips.append(element(document, 'i', undefined, i < used ? 'wb-slot wb-on' : 'wb-slot'));
    poolItem.append(pips);
  }
  const amount = used == null ? t('wb.unknown') : capacity == null ? String(used) : `${used} / ${capacity}`;
  poolItem.append(element(document, 'b', amount, full ? 'wb-txt-warn' : undefined));
  if ((technical || multi) && used != null) poolItem.append(element(document, 'span', t('wb.inst.inUse')));
  const source = multi ? poolSource(pool, t) : '';
  const details = technical && multi ? poolExplanation(pool.capacityRecord, t) : [];
  if (source) poolItem.append(element(document, 'span', ' · ' + source, 'wb-sub wb-pool-note'));
  if (pool.waiting) poolItem.append(element(document, 'span', ' · ' + t(technical ? 'wb.inst.queuedTech' : 'wb.inst.queued', { count: pool.waiting }), 'wb-txt-warn'));
  poolItem.title = [t('wb.inst.poolHint'), source, ...details].filter(Boolean).join(' · ');
  root.append(poolItem);
  cost = costSummary?.today?.total ?? cost;
  const costLabel = technical ? t('wb.inst.costTech') + ' ' + t('wb.inst.today') : t('wb.cost');
  const expense = item(document, icon(document, 'dollar', 'xs'), element(document, 'span', costLabel), element(document, 'b', money(cost)));
  // The scope chip leaves the screen in the compact strip; the title keeps it, so the cost never reads as one group's.
  expense.title = costLabel + ' · ' + t('wb.usage.allGroups');
  if (technical) {
    expense.append(element(document, 'span', '· ' + t('wb.usage.range.7d')), element(document, 'b', costSummary == null ? '—' : money(costSummary.sevenDay?.total)));
    const bars = element(document, 'span', undefined, 'wb-spark');
    const daily = costSummary?.daily ?? [], max = Math.max(0, ...daily.map(row => row.total));
    for (const row of daily) {
      const bar = element(document, 'i'); bar.style.height = Math.max(2, max ? Math.round(row.total / max * 14) : 2) + 'px';
      bar.title = row.at + ' · ' + money(row.total); bar.setAttribute('aria-label', bar.title); bars.append(bar);
    }
    expense.append(bars);
  }
  expense.append(element(document, 'small', t('wb.usage.allGroups'), 'wb-scope'));
  root.append(expense);
  const services = instance.services;
  const down = services == null ? null : services.total - services.online;
  root.append(item(document, icon(document, 'server', 'xs'), technical
    ? element(document, 'span', `${t('wb.inst.servicesTech')} ${services == null ? t('wb.unknown') : services.online + ' / ' + services.total}`, down ? 'wb-txt-warn' : undefined)
    : element(document, 'span', services == null ? t('wb.services') + ' · ' + t('wb.unknown') : down ? t('wb.inst.servicesDown', { count: down }) : t('wb.inst.servicesOk'), down ? 'wb-txt-warn' : undefined)));
  const host = element(document, 'button', t('wb.host.open'), 'wb-inst-more'); host.type = 'button'; host.id = 'wb-host-open'; host.setAttribute('aria-expanded', String(hostOpen)); host.addEventListener('click', onHost);
  root.append(host);
}
