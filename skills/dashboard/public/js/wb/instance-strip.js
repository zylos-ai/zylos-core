import { countLabel } from '../count-label.js?v=1';
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
export function quotaReset(usage, t, now = Date.now()) {
  const raw = usage?.resets_at ?? usage?.resetsAt;
  // Both runtime readers retain numeric reset timestamps in Unix seconds.
  const at = typeof raw === 'number' ? raw * 1000
    : typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw) ? Date.parse(raw) : NaN;
  if (!Number.isFinite(at) || !Number.isFinite(now) || at <= now || !Number.isFinite(new Date(at).getTime())) return null;
  const time = formatZoned(at, undefined, { ...(zonedDay(at) === zonedDay(now) ? {} : { month: '2-digit', day: '2-digit' }),
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const minutes = Math.ceil((at - now) / 60_000), days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  const parts = [[days, 'Days'], [hours, 'Hours'], [minutes % 60, 'Minutes']]
    .filter(([count]) => count > 0).map(([count, unit]) => t('wb.quotaReset' + unit, { count }));
  const duration = parts.join('\u00a0');
  return { at, time, duration, text: t('wb.quotaReset', { time, duration }) };
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
// The collector samples every 30 seconds; three missed rounds make the numbers stale rather than current.
export const SYSTEM_STALE_MS = 90_000;
const oneDecimal = bytes => (bytes / 1073741824).toFixed(1);
/** CPU, memory (used = total minus available) and disk percentages: icon and number on screen, the name read out, details in the title. */
export function systemItems(document, system, { t = key => key, readAt } = {}) {
  // Group snapshots carry readAt; freshness uses the same snapshot clock as the sample.
  const stale = system != null && !(readAt - system.sampledAt <= SYSTEM_STALE_MS);
  const memory = system && system.mem_total_bytes > 0 && system.mem_used_bytes != null ? system.mem_used_bytes / system.mem_total_bytes * 100 : null;
  const specs = [
    ['cpu', 'cpu', system?.cpu_pct, system?.cpu_count > 0 ? countLabel(t, 'wb.inst.cpuCores', system.cpu_count) : '', system?.cpu_source],
    ['memory', 'memory', memory, memory == null ? ''
      : t('wb.inst.memoryUsed', { used: oneDecimal(system.mem_used_bytes), total: oneDecimal(system.mem_total_bytes) }), system?.mem_source],
    ['disk', 'disk', system?.disk_pct, system?.disk_free_bytes != null ? t('wb.inst.diskFree', { free: oneDecimal(system.disk_free_bytes) }) : ''],
  ];
  return specs.map(([glyph, name, value, detail, source]) => {
    const label = t('wb.host.' + name), known = !stale && typeof value === 'number' && Number.isFinite(value);
    const amount = known ? Math.round(Math.max(0, Math.min(100, value))) + '%' : '—';
    const node = item(document, icon(document, glyph, 'xs'), element(document, 'span', label, 'wb-sys-word wb-vh'), element(document, 'b', amount));
    node.classList.add('wb-sys', 'wb-sys-' + name);
    if (stale) node.classList.add('wb-stale');
    node.title = [label + ' ' + amount, ['host', 'container'].includes(source) ? t('wb.inst.resourceSource.' + source) : '', known ? detail : '',
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
    const reset = quotaReset(usage, t, now);
    if (reset) box.title += ' · ' + reset.text;
    root.append(box);
  }
  const pool = instance.pool ?? {}, multi = snapshot.mode === 'multi';
  const used = multi ? pool.used : snapshot.groupCounts?.listKnown === false ? null : snapshot.groupCounts?.running?.total ?? null;
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
  const waiting = snapshot.groupCounts?.offline?.waitingSlot ?? 0;
  const queued = waiting ? t(technical ? 'wb.inst.queuedTech' : 'wb.inst.queued', { count: waiting }) : '';
  if (queued) poolItem.append(element(document, 'span', '· ' + queued, 'wb-txt-warn'));
  poolItem.title = [poolName, occupancy == null ? t('wb.unknown') : technical || multi ? t('wb.inst.inUse') + ' ' + occupancy : occupancy,
    queued, t('wb.inst.poolHint')].filter(Boolean).join(' · ');
  root.append(poolItem, ...systemItems(document, instance.resources ?? null, { t, readAt: snapshot.readAt }));
  cost = costSummary?.today?.cost ?? cost;
  const costName = t(technical ? 'wb.inst.costTech' : 'wb.cost'), today = money(cost);
  const expense = item(document, icon(document, 'dollar', 'xs'), spoken(document, costName), element(document, 'b', today));
  expense.classList.add('wb-cost');
  // The title names the scope, so the cost never reads as one group's.
  if (technical) {
    const week = costSummary == null ? '—' : money(costSummary.sevenDay?.cost);
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
