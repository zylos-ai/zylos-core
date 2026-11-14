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
/** An item's name for screen readers: on screen its icon stands for it, and its title starts with it. */
const spoken = (document, text) => element(document, 'span', text, 'wb-inst-word wb-vh');
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
export function poolDecision(record, t) {
  if (record?.valid !== true || record.fresh !== true) return '';
  if (record.reason === 'floor') return '';
  if (record.source === 'fixed') return t('wb.inst.poolDecisionFixed');
  if (record.source === 'fallback') return '';
  if (record.limitedBy === 'model') return t('wb.inst.poolDecisionModel');
  if (record.limitedBy === 'live') return t('wb.inst.poolDecisionLive');
  return '';
}
export function poolBuckets(record, t) {
  if (!Array.isArray(record?.model?.buckets)) return [];
  return record.model.buckets.filter(bucket => bucket != null && Number.isInteger(bucket.n) && bucket.n >= 0 &&
    finite(bucket.highBytes) && bucket.highBytes >= 0 && Number.isInteger(bucket.hours) && bucket.hours >= 0 &&
    Number.isInteger(bucket.samples) && bucket.samples >= 0)
    .slice().sort((a, b) => a.n - b.n).map(bucket => t('wb.inst.poolBucket', {
      count: bucket.n, amount: (bucket.highBytes / 1073741824).toFixed(2), hours: bucket.hours, samples: bucket.samples,
    }).replace(/(\d) (?=个|GiB\b|h\b|samples\b)/g, '$1\u00a0'));
}
export function poolAlgorithm(record, t) {
  if (record?.valid !== true || record.fresh !== true || record.source !== 'auto') return '';
  return ['fitted', 'default'].includes(record.model?.state) ? t('wb.inst.poolAlgorithm' +
    (record.model.state === 'fitted' ? 'Fitted' : 'Default')) : '';
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
  const decision = poolDecision(record, t);
  if (decision) parts.push(decision);
  if (record?.reason === 'floor') parts.push(t('wb.inst.poolFloor'));
  return parts;
}
// The collector samples every 30 seconds; three missed rounds make the numbers stale rather than current.
export const SYSTEM_STALE_MS = 90_000;
const oneDecimal = bytes => (bytes / 1073741824).toFixed(1);
/** CPU, memory (used = total minus available) and disk percentages: icon and number on screen, the name read out, details in the title. */
export function systemItems(document, system, { t = key => key, readAt } = {}) {
  // Group snapshots carry readAt; freshness uses the same snapshot clock as the sample.
  const stale = system != null && !(readAt - system.sampledAt <= SYSTEM_STALE_MS);
  const memory = system && system.memTotalBytes > 0 && system.memUsedBytes != null ? system.memUsedBytes / system.memTotalBytes * 100 : null;
  const specs = [
    ['cpu', 'cpu', system?.cpuPct, system?.cpuCount > 0 ? t('wb.inst.cpuCores', { count: system.cpuCount }) : ''],
    ['memory', 'memory', memory, memory == null ? ''
      : t('wb.inst.memoryUsed', { used: oneDecimal(system.memUsedBytes), total: oneDecimal(system.memTotalBytes) })],
    ['disk', 'disk', system?.diskUsedPct, system?.diskFreeBytes != null ? t('wb.inst.diskFree', { free: oneDecimal(system.diskFreeBytes) }) : ''],
  ];
  return specs.map(([glyph, name, value, detail]) => {
    const label = t('wb.host.' + name), known = !stale && typeof value === 'number' && Number.isFinite(value);
    const amount = known ? Math.round(Math.max(0, Math.min(100, value))) + '%' : '—';
    const node = item(document, icon(document, glyph, 'xs'), element(document, 'span', label, 'wb-sys-word wb-vh'), element(document, 'b', amount));
    node.classList.add('wb-sys', 'wb-sys-' + name);
    if (stale) node.classList.add('wb-stale');
    node.title = [label + ' ' + amount, known ? detail : '',
      system == null ? t('wb.inst.systemUnknown') : stale ? t('wb.inst.systemStale', { time: clock(system.sampledAt) }) : ''].filter(Boolean).join(' · ');
    return node;
  });
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
    const health = instance.runtimeHealth?.[runtime], usage = instance.accounts?.[runtime], name = runtimeName(runtime);
    const box = item(document, element(document, 'i', undefined, `wb-health wb-health-${health?.health ?? 'unknown'}`), element(document, 'b', name));
    box.classList.add('wb-account');
    // A sign-in failure or a rate limit stays on screen as words: it is a problem, not a reading.
    let problem = null;
    if (health?.health === 'auth_failed') problem = element(document, 'span', t(technical ? 'wb.inst.authFailedTech' : 'wb.authFailed'), 'wb-txt-err');
    else if (['rate_limited', 'recovering'].includes(health?.health)) {
      const at = recoveryTime(health.cooldownUntil, now);
      problem = element(document, 'span', technical
        ? (at === null ? t('wb.inst.coolingUnknown') : t('wb.inst.cooling', { time: clock(at) }))
        : (at === null ? t('wb.recoveryUnknown') : t('wb.recovery', { time: clock(at) })), 'wb-txt-warn');
    }
    if (problem) {
      box.append(problem);
      box.title = name + ' · ' + problem.textContent;
    } else {
      const pct = remainingQuotaPercent(accountUsedPercent(usage));
      if (pct != null) box.append(meter(document, pct));
      const amount = element(document, 'span', pct == null ? '—' : Math.round(pct) + '%');
      if (pct != null) amount.style.color = quotaColor(pct);
      box.append(amount);
      box.title = [name, t(health?.health === 'ok' ? 'wb.inst.ok' : 'wb.unknown'),
        pct == null ? t('wb.quotaUnknown') : t('wb.quotaRemaining', { pct: Math.round(pct) })].join(' · ');
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
  // Pool, cost and services: icon and number on screen; the title starts with the item's name, then the details.
  const poolName = t(technical ? 'wb.inst.pool' : 'wb.pool');
  const poolItem = item(document, icon(document, 'layers', 'xs'), spoken(document, poolName));
  poolItem.classList.add('wb-pool');
  if (technical && used != null && capacity > 0) {
    const bar = element(document, 'span', undefined, 'wb-meter wb-pool-meter' + (full ? ' wb-warn' : ''));
    const fill = element(document, 'i');
    fill.style.width = Math.max(0, Math.min(100, used / capacity * 100)) + '%';
    fill.style.minWidth = used > 0 ? '2px' : '0';
    bar.append(fill); poolItem.append(bar);
  }
  const occupancy = used == null ? null : capacity == null ? String(used) : `${used} / ${capacity}`;
  poolItem.append(element(document, 'b', occupancy ?? '—', full ? 'wb-txt-warn' : undefined));
  // A queue is a wait, so it stays on screen.
  const queued = pool.waiting ? t(technical ? 'wb.inst.queuedTech' : 'wb.inst.queued', { count: pool.waiting }) : '';
  if (queued) poolItem.append(element(document, 'span', '· ' + queued, 'wb-txt-warn'));
  const source = multi ? poolSource(pool, t) : '';
  const details = technical && multi ? poolExplanation(pool.capacityRecord, t) : [];
  poolItem.title = [poolName, occupancy == null ? t('wb.unknown') : technical || multi ? t('wb.inst.inUse') + ' ' + occupancy : occupancy,
    source, queued, ...details, t('wb.inst.poolHint')].filter(Boolean).join(' · ');
  root.append(poolItem, ...systemItems(document, instance.system ?? null, { t, readAt: snapshot.readAt }));
  cost = costSummary?.today?.total ?? cost;
  const costName = t(technical ? 'wb.inst.costTech' : 'wb.cost'), today = money(cost);
  const expense = item(document, icon(document, 'dollar', 'xs'), spoken(document, costName), element(document, 'b', today));
  expense.classList.add('wb-cost');
  // The title names the scope, so the cost never reads as one group's.
  if (technical) {
    const week = costSummary == null ? '—' : money(costSummary.sevenDay?.total);
    expense.append(element(document, 'span', '·'), element(document, 'b', week));
    expense.title = [costName, t('wb.inst.today') + ' ' + today, t('wb.usage.range.7d') + ' ' + week, t('wb.usage.allGroups')].join(' · ');
  } else expense.title = [costName, today, t('wb.usage.allGroups')].join(' · ');
  root.append(expense);
  const services = instance.services;
  const down = services == null ? null : services.total - services.online;
  const servicesName = t(technical ? 'wb.inst.servicesTech' : 'wb.services');
  const service = item(document, icon(document, 'server', 'xs'), spoken(document, servicesName),
    element(document, 'b', services == null ? '—' : `${services.online} / ${services.total}`, down ? 'wb-txt-warn' : undefined));
  service.classList.add('wb-services');
  service.title = servicesName + ' · ' + (services == null ? t('wb.unknown') : t('wb.inst.servicesOnline', { online: services.online, total: services.total }));
  root.append(service);
  const host = element(document, 'button', t('wb.host.open'), 'wb-inst-more'); host.type = 'button'; host.id = 'wb-host-open'; host.setAttribute('aria-expanded', String(hostOpen)); host.addEventListener('click', onHost);
  root.append(host);
}
