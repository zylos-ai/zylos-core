import { element, icon } from './plain-text.js?v=105';
import { formatZoned } from './instance-zone.js?v=100';

const percent = value => value == null ? '—' : Number(value).toFixed(1) + '%';
const defaultChart = (canvas, config) => new globalThis.Chart(canvas, config);
const seriesPeak = (series, field) => series.reduce((peak, row) => row[field]?.max == null || (peak != null && peak >= row[field].max) ? peak : row[field].max, null);

// Theme colour mixed with transparency, resolved by the browser so any colour syntax works.
function mixColor(document, root, color, percent) {
  const probe = document.createElement('span');
  if (!probe.style || !document.defaultView?.getComputedStyle || !root.append) return color;
  probe.style.color = `color-mix(in srgb, ${color} ${percent}%, transparent)`;
  probe.hidden = true; root.append(probe);
  const value = document.defaultView.getComputedStyle(probe).color;
  probe.remove?.();
  return value || color;
}

// Compact area curve with a 0–100% axis; only the bottom chart carries time ticks so the three read as one stack.
function hostChart(root, { title, current, peak, peakTitle, labels, avg, max, axis, document, t, chartFactory }) {
  const box = element(document, 'div', undefined, 'wb-host-chart');
  const head = element(document, 'h5', title);
  head.append(element(document, 'b', percent(current)));
  const peakNode = element(document, 'small', t('wb.host.peak', { value: percent(peak) }));
  if (peakTitle) peakNode.title = peakTitle;
  head.append(peakNode);
  const frame = element(document, 'div', undefined, 'wb-host-frame');
  frame.style.height = axis ? '128px' : '104px';
  const canvas = element(document, 'canvas'); canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', title);
  frame.append(canvas); box.append(head, frame); root.append(box);
  const style = document.defaultView?.getComputedStyle(root);
  const color = style?.getPropertyValue('--text-dim').trim() || 'currentColor';
  const grid = style?.getPropertyValue('--wb-line').trim() || color;
  const chart = chartFactory(canvas, { type: 'line', data: { labels, datasets: [
    { label: t('wb.host.avg'), data: avg, borderColor: color, backgroundColor: mixColor(document, root, color, 13), fill: 'origin', borderWidth: 1.5, pointRadius: 0, spanGaps: false, tension: 0.25 },
    { label: t('wb.host.max'), data: max, borderColor: mixColor(document, root, color, 55), borderDash: [3, 3], borderWidth: 1, pointRadius: 0, spanGaps: false, fill: false },
  ] }, options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: item => `${item.dataset.label} ${percent(item.raw)}` } } },
    scales: { x: { display: axis, grid: { display: false }, ticks: { color, maxTicksLimit: 6, maxRotation: 0, autoSkip: true, font: { size: 10 } } },
      y: { min: 0, max: 100, ticks: { color, stepSize: 50, font: { size: 10 }, callback: value => value + '%' }, grid: { color: grid }, border: { display: false } } } } });
  return { destroy: () => chart?.destroy() };
}

// One legend for the stack: the solid line is the average of each slot, the dashed one its maximum.
function hostLegend(document, t) {
  const legend = element(document, 'div', undefined, 'wb-host-legend');
  for (const [name, className] of [['avg', 'wb-key-avg'], ['max', 'wb-key-max']]) {
    const item = element(document, 'span'); item.append(element(document, 'i', undefined, className), element(document, 'span', t('wb.host.' + name)));
    legend.append(item);
  }
  return legend;
}

function rangeControl(document, range, onRange, t) {
  const seg = element(document, 'span', undefined, 'wb-seg-sm'); seg.id = 'wb-host-range';
  seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', t('wb.usage.range'));
  for (const name of ['6h', '24h', '7d']) {
    const button = element(document, 'button', t('wb.host.range.' + name)); button.type = 'button'; button.dataset.range = name;
    button.setAttribute('aria-pressed', String(range === name));
    button.addEventListener('click', () => { if (range !== name) onRange(name); });
    seg.append(button);
  }
  return seg;
}

// Only host observations belong in this panel; runtime and group data stay out.
export function renderHost(root, value, { document = root.ownerDocument, t = key => key,
  level = 'plain', range = '6h', meta = null, onRange = () => {}, onClose = () => {}, onUsage = () => {}, chartFactory = defaultChart } = {}) {
  root.replaceChildren();
  const charts = [], header = element(document, 'header', undefined, 'wb-detail-header');
  const top = element(document, 'div', undefined, 'wb-d-top');
  const box = element(document, 'span', undefined, 'wb-ch'); box.append(icon(document, 'server'));
  const close = element(document, 'button', undefined, 'wb-icon-btn'); close.type = 'button'; close.id = 'wb-host-close';
  close.setAttribute('aria-label', t('wb.close')); close.title = t('wb.closeEsc'); close.append(icon(document, 'x')); close.addEventListener('click', onClose);
  top.append(box, element(document, 'h2', t('wb.host.title'), 'wb-d-title'), close);
  header.append(top);
  const metaItems = [meta?.name, ...(level === 'technical' ? [meta?.mode, meta?.core, meta?.version] : [])].filter(Boolean);
  if (metaItems.length) header.append(element(document, 'p', metaItems.join(' · '), 'wb-detail-meta'));
  root.append(header);
  root.setAttribute('aria-label', t('wb.host.title'));
  const body = element(document, 'div', undefined, 'wb-detail-body wb-host-body'); root.append(body);
  const card = element(document, 'section', undefined, 'wb-ip-card');
  const title = element(document, 'h4'); title.append(icon(document, 'server', 'xs'), element(document, 'span', t('wb.host.machine')));
  card.append(title); body.append(card);
  const pm2 = value?.pm2;
  if (level !== 'technical') {
    const grid = element(document, 'div', undefined, 'wb-kvs');
    const down = pm2 == null ? null : pm2.total - pm2.online;
    grid.append(element(document, 'span', t('wb.services')),
      element(document, 'b', pm2 == null ? t('wb.unknown') : `${pm2.online} / ${pm2.total}` + (down ? ' · ' + t('wb.host.offline', { count: down }) : ''), down ? 'wb-txt-warn' : undefined));
    for (const [name, field] of [['cpu', 'cpu_pct'], ['memory', 'mem_used_pct'], ['disk', 'disk_used_pct']]) {
      grid.append(element(document, 'span', t('wb.host.' + name)), element(document, 'b', percent(value?.current?.[field])));
    }
    const note = element(document, 'p', t('wb.host.usageNote'), 'wb-note');
    const go = element(document, 'button', t('wb.host.usageLink'), 'wb-link-btn wb-chev'); go.type = 'button'; go.addEventListener('click', onUsage);
    note.append(go);
    card.append(grid, note);
    return { destroy() {} };
  }
  title.append(rangeControl(document, range, onRange, t));
  card.append(element(document, 'p', `${t('wb.host.pm2')} ${pm2 == null ? t('wb.unknown') : pm2.online + ' / ' + pm2.total} ${t('wb.host.online')}`, 'wb-host-svc'));
  const series = value?.series ?? [], lang = document.documentElement?.lang || undefined;
  const short = range === '7d' ? { month: 'numeric', day: 'numeric' } : { hour: '2-digit', minute: '2-digit' };
  const labels = series.map(row => formatZoned(row.at, lang, short));
  const peak = value?.cpuPeak;
  card.append(hostLegend(document, t));
  const fields = [['cpu', 'cpu', 'cpu_pct'], ['mem', 'memory', 'mem_used_pct'], ['disk', 'disk', 'disk_used_pct']];
  for (const [index, [field, label, current]] of fields.entries()) {
    charts.push(hostChart(card, { title: t('wb.host.' + label), current: value?.current?.[current],
      peak: field === 'cpu' ? peak?.value ?? seriesPeak(series, field) : seriesPeak(series, field),
      peakTitle: field === 'cpu' && peak?.at ? formatZoned(peak.at, lang) : '',
      labels, avg: series.map(row => row[field]?.avg ?? null), max: series.map(row => row[field]?.max ?? null),
      axis: index === fields.length - 1, document, t, chartFactory }));
  }
  const details = element(document, 'details', undefined, 'wb-host-table');
  details.append(element(document, 'summary', t('wb.usage.dataTable')));
  const scroll = element(document, 'div', undefined, 'wb-table-scroll');
  const table = element(document, 'table'), head = element(document, 'tr');
  head.append(element(document, 'th', t('wb.usage.bucket')));
  for (const [, label] of fields) for (const statistic of ['avg', 'max']) head.append(element(document, 'th', `${t('wb.host.' + label)} ${t('wb.host.' + statistic)}`));
  const thead = element(document, 'thead'), tbody = element(document, 'tbody'); thead.append(head); table.append(thead, tbody);
  for (const row of series) {
    const line = element(document, 'tr'); line.append(element(document, 'th', formatZoned(row.at, lang)));
    for (const [field] of fields) for (const statistic of ['avg', 'max']) line.append(element(document, 'td', percent(row[field]?.[statistic])));
    tbody.append(line);
  }
  scroll.append(table); details.append(scroll); card.append(details);
  return { destroy() { charts.forEach(chart => chart.destroy()); } };
}

export function createHostPanel({ root, read, identity = () => '', detail = () => 'plain', meta = () => null,
  document = root.ownerDocument, t = key => key, onOpen = () => {}, onClose = () => {}, onUsage = () => {}, chartFactory } = {}) {
  let active = false, generation = 0, owner = null, data = null, rendered = null, range = '6h', failure = null;
  const draw = () => {
    rendered?.destroy(); rendered = renderHost(root, data, { document, t, level: detail(), range, meta: meta(), onClose: close,
      onUsage: () => { close(); onUsage(); }, onRange: next => { range = next; void refresh(); }, chartFactory });
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
    root.hidden = true; root.replaceChildren(); onClose();
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
