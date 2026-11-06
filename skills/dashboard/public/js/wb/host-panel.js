import { element } from './plain-text.js?v=85';
import { seriesChart } from './usage.js?v=87';

const percent = value => value == null ? '—' : Number(value).toFixed(1) + '%';

// Only host observations belong in this panel; runtime and group data stay out.
export function renderHost(root, value, { document = root.ownerDocument, t = key => key,
  level = 'plain', range = '6h', onRange = () => {}, onClose = () => {}, chartFactory } = {}) {
  root.replaceChildren();
  const charts = [], header = element(document, 'header', undefined, 'wb-detail-header');
  header.append(element(document, 'h2', t('wb.host.title')));
  const close = element(document, 'button', '×'); close.type = 'button'; close.id = 'wb-host-close'; close.setAttribute('aria-label', t('wb.close')); close.addEventListener('click', onClose); header.append(close); root.append(header);
  root.setAttribute('aria-label', t('wb.host.title'));
  const body = element(document, 'div', undefined, 'wb-detail-body'); root.append(body);
  const pm2 = value?.pm2;
  body.append(element(document, 'p', `${t('wb.services')} · ${pm2 == null ? t('wb.unknown') : pm2.online + ' / ' + pm2.total}`));
  for (const [name, field] of [['cpu', 'cpu_pct'], ['memory', 'mem_used_pct'], ['disk', 'disk_used_pct']]) {
    body.append(element(document, 'p', t('wb.host.' + name) + ' · ' + percent(value?.current?.[field])));
  }
  if (level === 'technical') {
    const select = element(document, 'select'); select.id = 'wb-host-range'; select.setAttribute('aria-label', t('wb.usage.range'));
    for (const name of ['6h', '24h', '7d']) { const option = element(document, 'option', t('wb.host.range.' + name)); option.value = name; select.append(option); }
    select.value = range; select.addEventListener('change', () => onRange(select.value)); body.append(select);
    const peak = value?.cpuPeak;
    body.append(element(document, 'p', t('wb.host.cpuPeak') + ' · ' + (peak == null ? t('wb.unknown') : percent(peak.value) + ' · ' + new Date(peak.at).toLocaleString(document.documentElement?.lang))));
    const labels = (value?.series ?? []).map(row => new Date(row.at).toLocaleString(document.documentElement?.lang));
    for (const [field, label] of [['cpu', 'cpu'], ['mem', 'memory'], ['disk', 'disk']]) {
      charts.push(seriesChart(body, { title: t('wb.host.' + label), labels, type: 'line', document, t, chartFactory,
        datasets: ['avg', 'max'].map(statistic => ({ label: t('wb.host.' + statistic), data: (value?.series ?? []).map(row => row[field]?.[statistic] ?? null) })) }));
    }
  }
  return { destroy() { charts.forEach(chart => chart.destroy()); } };
}

export function createHostPanel({ root, read, identity = () => '', detail = () => 'plain',
  document = root.ownerDocument, t = key => key, onOpen = () => {}, chartFactory } = {}) {
  let active = false, generation = 0, owner = null, data = null, rendered = null, range = '6h', failure = null;
  const draw = () => {
    rendered?.destroy(); rendered = renderHost(root, data, { document, t, level: detail(), range, onClose: close,
      onRange: next => { range = next; void refresh(); }, chartFactory });
    if (failure) root.append(element(document, 'p', t('wb.readFailed') + (detail() === 'technical' ? ' · ' + failure : ''), 'wb-detail-error'));
    root.hidden = false;
  };
  async function refresh() {
    if (!active) return;
    const current = ++generation, target = identity(); owner = target; failure = null; data = null; draw();
    try {
      const value = await read('/api/workbench/host?range=' + range);
      if (!active || current !== generation || target !== identity()) return;
      data = value; draw();
    } catch (error) {
      if (!active || current !== generation || target !== identity()) return;
      failure = error.message; draw();
    }
  }
  function close() {
    if (!active) return;
    active = false; generation++; data = null; failure = null; rendered?.destroy(); rendered = null;
    root.hidden = true; root.replaceChildren();
  }
  const escape = event => { if (active && event.key === 'Escape') close(); };
  document.addEventListener('keydown', escape);
  return {
    get active() { return active; },
    open() { onOpen(); active = true; return refresh(); }, refresh, close,
    setViewDetail() { if (active && owner === identity()) draw(); },
    destroy() { close(); document.removeEventListener('keydown', escape); },
  };
}
