import { element } from './plain-text.js?v=85';
export function instanceStrip(root, snapshot, { document = root.ownerDocument, t = key => key, cost = null, level = 'plain' } = {}) {
  root.replaceChildren(); const instance = snapshot.instance ?? {};
  root.append(element(document, 'div', `${t('wb.mode')} · ${snapshot.mode === 'unreadable' ? t('wb.unknown') : snapshot.mode}`));
  const runtimes = new Set([snapshot.baselineRuntime, ...(snapshot.rows ?? []).map(row => row.launchConfig?.runtime ?? row.target?.runtime)].filter(Boolean));
  for (const runtime of runtimes) {
    const health = instance.runtimeHealth?.[runtime], usage = instance.accounts?.[runtime];
    const box = element(document, 'div', undefined, 'wb-account');
    const dot = element(document, 'i', undefined, `wb-health wb-health-${health?.health ?? 'unknown'}`);
    box.append(dot, element(document, 'strong', runtime));
    if (health?.health === 'auth_failed') box.append(element(document, 'p', t('wb.authFailed')));
    else if (['rate_limited', 'recovering'].includes(health?.health)) box.append(element(document, 'p',
      t('wb.recovery', { time: health.cooldownUntil == null ? t('wb.unknown') : new Date(health.cooldownUntil * 1000).toLocaleTimeString() })));
    else {
      const pct = usage?.used_percentage ?? usage?.utilization ?? usage?.usedPercentage;
      box.append(element(document, 'p', `${t('wb.week')} · ${pct == null ? t('wb.unknown') : pct + '%'}`));
      if (pct != null) { const bar = element(document, 'progress'); bar.max = 100; bar.value = pct; bar.title = t('wb.week'); box.append(bar); }
    }
    root.append(box);
  }
  const used = instance.pool?.used;
  const pool = element(document, 'div', `${t('wb.pool')} · ${used == null ? t('wb.unknown') : used + ' / ?'}`);
  if (used != null) for (let i = 0; i < used; i++) pool.append(element(document, 'i', undefined, 'wb-slot'));
  if (instance.pool?.waiting != null) pool.append(element(document, 'small', ` · ${instance.pool.waiting} ${t('wb.waiting')}`));
  root.append(pool);
  const expense = element(document, 'div', `${t('wb.cost')} · ${cost == null ? '—' : '$' + Number(cost).toFixed(4)}`);
  if (level === 'technical') expense.append(element(document, 'small', t('wb.costCoverage')));
  root.append(expense, element(document, 'div', `${t('wb.services')} · ${instance.services == null ? t('wb.unknown') : instance.services.online + ' / ' + instance.services.total}`));
}
