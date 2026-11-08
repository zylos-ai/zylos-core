import { element, icon, runtimeName } from './plain-text.js?v=103';
import { recoveryTime } from './cooldown.js?v=89';
// Account quota samples are passed through as each runtime reports them: Claude uses
// used_percentage (or utilization), Codex keeps its camelCase usedPercentage.
export const accountUsedPercent = usage => usage?.used_percentage ?? usage?.utilization ?? usage?.usedPercentage ?? null;
const clock = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const money = value => value == null ? '—' : '$' + Number(value).toFixed(Math.abs(value) >= 1 ? 2 : 4);
function meter(document, pct) {
  const bar = element(document, 'span', undefined, 'wb-meter' + (pct >= 100 ? ' wb-err' : pct >= 80 ? ' wb-warn' : ''));
  const fill = element(document, 'i'); fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  bar.append(fill); return bar;
}
function item(document, ...children) {
  const node = element(document, 'span', undefined, 'wb-inst-item');
  node.append(...children); return node;
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
  const runtimes = new Set([snapshot.baselineRuntime, ...(snapshot.rows ?? []).map(row => row.launchConfig?.runtime ?? row.target?.runtime)].filter(Boolean));
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
      const pct = accountUsedPercent(usage);
      if (technical) box.append(element(document, 'span', health?.health === 'ok' ? t('wb.inst.ok') : t('wb.unknown')));
      box.append(element(document, 'span', technical ? '7d' : t('wb.week'), 'wb-inst-label'));
      if (pct != null) box.append(meter(document, pct));
      box.append(element(document, 'span', pct == null ? t('wb.unknown') : pct + '%'));
      box.title = t('wb.week');
    }
    root.append(box);
  }
  const pool = instance.pool ?? {}, used = pool.used, capacity = pool.capacity ?? null;
  const full = used != null && capacity != null && used >= capacity;
  const poolItem = item(document, icon(document, 'layers', 'xs'), element(document, 'span', technical ? t('wb.inst.pool') : t('wb.pool')));
  if (technical && used != null) {
    const pips = element(document, 'span', undefined, 'wb-pips' + (full ? ' wb-full' : ''));
    for (let i = 0; i < Math.max(used, capacity ?? 0); i++) pips.append(element(document, 'i', undefined, i < used ? 'wb-slot wb-on' : 'wb-slot'));
    poolItem.append(pips);
  }
  const amount = used == null ? t('wb.unknown') : capacity == null ? String(used) : `${used} / ${capacity}`;
  poolItem.append(element(document, 'b', amount, full ? 'wb-txt-warn' : undefined));
  if (technical && used != null) poolItem.append(element(document, 'span', t('wb.inst.inUse')));
  if (pool.waiting) poolItem.append(element(document, 'span', ' · ' + t(technical ? 'wb.inst.queuedTech' : 'wb.inst.queued', { count: pool.waiting }), 'wb-txt-warn'));
  poolItem.title = t('wb.inst.poolHint');
  root.append(poolItem);
  cost = costSummary?.today?.total ?? cost;
  const expense = item(document, icon(document, 'dollar', 'xs'), element(document, 'span', technical ? t('wb.inst.costTech') + ' ' + t('wb.inst.today') : t('wb.cost')),
    element(document, 'b', money(cost)));
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
