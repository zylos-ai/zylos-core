import { element, icon } from './plain-text.js?v=106';
import { formatZoned } from './instance-zone.js?v=100';
import { poolExplanation, poolSource, poolDecision, poolBuckets, poolAlgorithm } from './instance-strip.js?v=198';

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
  const currentNode = element(document, 'b', percent(current)); head.append(currentNode);
  const peakNode = element(document, 'small', t('wb.host.peak', { value: percent(peak) }));
  if (peakTitle) peakNode.title = peakTitle;
  head.append(peakNode);
  const frame = element(document, 'div', undefined, 'wb-host-frame');
  frame.style.height = axis ? '128px' : '104px';
  const canvas = element(document, 'canvas'); canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', title);
  frame.append(canvas); box.append(head, frame); root.append(box);
  const style = document.defaultView?.getComputedStyle(root);
  let color = style?.getPropertyValue('--text-dim').trim() || 'currentColor';
  let grid = style?.getPropertyValue('--wb-line').trim() || color;
  const chartData = { labels, datasets: [
    { label: t('wb.host.avg'), data: avg, borderColor: color, backgroundColor: mixColor(document, root, color, 13), fill: 'origin', borderWidth: 1.5, pointRadius: 0, spanGaps: false, tension: 0.25 },
    { label: t('wb.host.max'), data: max, borderColor: mixColor(document, root, color, 55), borderDash: [3, 3], borderWidth: 1, pointRadius: 0, spanGaps: false, fill: false },
  ] };
  const config = { type: 'line', data: chartData, options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: item => `${item.dataset.label} ${percent(item.raw)}` } } },
    scales: { x: { display: axis, grid: { display: false }, ticks: { color, maxTicksLimit: 6, maxRotation: 0, autoSkip: true, font: { size: 10 } } },
      y: { min: 0, max: 100, ticks: { color, stepSize: 50, font: { size: 10 }, callback: value => value + '%' }, grid: { color: grid }, border: { display: false } } } } };
  const chart = chartFactory(canvas, config);
  return {
    update(next) {
      setText(currentNode, percent(next.current));
      setText(peakNode, t('wb.host.peak', { value: percent(next.peak) }));
      peakNode.title = next.peakTitle || '';
      const data = chart?.data ?? chartData;
      const style = document.defaultView?.getComputedStyle(root);
      const nextColor = style?.getPropertyValue('--text-dim').trim() || 'currentColor';
      const nextGrid = style?.getPropertyValue('--wb-line').trim() || nextColor;
      const paletteChanged = nextColor !== color || nextGrid !== grid;
      const dataChanged = !sameValues(data.labels, next.labels) || !sameValues(data.datasets[0].data, next.avg) || !sameValues(data.datasets[1].data, next.max);
      if (!paletteChanged && !dataChanged) return;
      if (paletteChanged) {
        color = nextColor; grid = nextGrid;
        data.datasets[0].borderColor = color; data.datasets[0].backgroundColor = mixColor(document, root, color, 13);
        data.datasets[1].borderColor = mixColor(document, root, color, 55);
        const options = chart?.options ?? config.options;
        options.scales.x.ticks.color = color; options.scales.y.ticks.color = color; options.scales.y.grid.color = grid;
      }
      if (dataChanged) { data.labels = next.labels; data.datasets[0].data = next.avg; data.datasets[1].data = next.max; }
      chart?.update?.('none');
    },
    destroy: () => chart?.destroy(),
  };
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

const setText = (node, text) => { if (node.textContent !== String(text)) node.textContent = text; };
const sameValues = (a, b) => a?.length === b.length && b.every((value, index) => a[index] === value);

// Only changed keys are inserted, moved or removed; an unchanged row keeps its node.
function keyedRows(container, entries, previous, create, update) {
  const next = new Map();
  for (const [key, value] of entries) {
    const item = previous.get(key) ?? create(value);
    update(item, value); next.set(key, item);
  }
  for (const [key, item] of previous) if (!next.has(key)) container.removeChild(item.node);
  let cursor = container.firstChild;
  for (const item of next.values()) {
    if (item.node !== cursor) container.insertBefore(item.node, cursor);
    cursor = item.node.nextSibling;
  }
  return next;
}

// The pool section owns its rows independently of the host metric response.
export function renderHostPool(section, view, { document = section.ownerDocument, t = key => key } = {}) {
  section.replaceChildren();
  let parts = null, notes = new Map();
  const update = value => {
    const pool = value?.mode === 'multi' ? value.pool ?? null : null, record = pool?.capacityRecord;
    section.hidden = !(record && typeof record === 'object' && Object.keys(record).length);
    if (section.hidden) {
      if (parts) for (const node of [parts.title, parts.grid, parts.list]) if (node.parentNode === section) section.removeChild(node);
      parts = null; notes = new Map(); return;
    }
    if (!parts) {
      const title = element(document, 'h4'); title.append(icon(document, 'layers', 'xs'), element(document, 'span', t('wb.host.pool')));
      const grid = element(document, 'div', undefined, 'wb-kvs');
      const slotsLabel = element(document, 'span', t('wb.host.poolSlots')), slots = element(document, 'b');
      const sourceLabel = element(document, 'span', t('wb.host.poolSource')), source = element(document, 'span');
      const list = element(document, 'ul', undefined, 'wb-host-pool-notes');
      grid.append(slotsLabel, slots); section.append(title, grid);
      parts = { title, grid, slotsLabel, slots, sourceLabel, source, list };
    }
    const used = pool.used ?? null, capacity = pool.capacity ?? null;
    setText(parts.slotsLabel, t('wb.host.poolSlots'));
    setText(parts.slots, used == null ? t('wb.unknown') : capacity == null ? String(used) : `${used} / ${capacity}`);
    const source = poolSource(pool, t);
    if (source) {
      setText(parts.sourceLabel, t('wb.host.poolSource')); setText(parts.source, source);
      if (parts.source.parentNode !== parts.grid) parts.grid.append(parts.sourceLabel, parts.source);
    } else if (parts.source.parentNode === parts.grid) {
      parts.grid.removeChild(parts.sourceLabel); parts.grid.removeChild(parts.source);
    }
    const entries = [['memory', poolExplanation({ memory: record.memory }, t)[0]],
      ['model', poolExplanation({ model: record.model }, t)[0]], ['buckets', poolBuckets(record, t)],
      ['algorithm', poolAlgorithm(record, t)], ['decision', poolDecision(record, t)],
      ['floor', poolExplanation({ reason: record.reason }, t)[0]]].filter(([, text]) => text?.length);
    notes = keyedRows(parts.list, entries, notes, () => ({ node: element(document, 'li'), rows: new Map() }), (item, text) => {
      if (Array.isArray(text)) {
        item.rows = keyedRows(item.node, text.map((line, index) => [index, line]), item.rows,
          () => ({ node: element(document, 'div', undefined, 'wb-host-pool-bucket') }), (row, line) => {
            if (row.text === line) return;
            row.text = line;
            row.node.textContent = '';
            const pieces = line.split(/(\d+(?:\.\d+)?\u00a0(?:个(?:会话|小时|样本)|GiB|h\b|samples\b)[）)]?)/g);
            pieces.forEach((piece, index) => row.node.append(element(document, 'span', piece,
              index % 2 ? 'wb-host-pool-bucket-unit' : undefined)));
          });
      } else setText(item.node, text);
    });
    if (entries.length && parts.list.parentNode !== section) section.append(parts.list);
    if (!entries.length && parts.list.parentNode === section) section.removeChild(parts.list);
  };
  update(view);
  return { update };
}

// Structure is mounted once per view; background observations update its retained nodes.
export function renderHost(root, value, { document = root.ownerDocument, t = key => key,
  level = 'plain', range = '6h', meta = null, pool = null, onRange = () => {}, onClose = () => {}, onUsage = () => {}, chartFactory = defaultChart } = {}) {
  root.replaceChildren();
  const charts = [], header = element(document, 'header', undefined, 'wb-detail-header');
  const top = element(document, 'div', undefined, 'wb-d-top');
  const box = element(document, 'span', undefined, 'wb-ch'); box.append(icon(document, 'server'));
  const close = element(document, 'button', undefined, 'wb-icon-btn'); close.type = 'button'; close.id = 'wb-host-close';
  close.setAttribute('aria-label', t('wb.close')); close.title = t('wb.closeEsc'); close.append(icon(document, 'x')); close.addEventListener('click', onClose);
  top.append(box, element(document, 'h2', t('wb.host.title'), 'wb-d-title'), close);
  header.append(top);
  const metaNode = element(document, 'p', undefined, 'wb-detail-meta');
  root.append(header);
  root.setAttribute('aria-label', t('wb.host.title'));
  const body = element(document, 'div', undefined, 'wb-detail-body wb-host-body'); root.append(body);
  const card = element(document, 'section', undefined, 'wb-ip-card');
  const title = element(document, 'h4'); title.append(icon(document, 'server', 'xs'), element(document, 'span', t('wb.host.machine')));
  card.append(title);
  const poolSection = element(document, 'section', undefined, 'wb-ip-card wb-host-pool');
  const poolView = renderHostPool(poolSection, pool, { document, t });
  body.append(card, poolSection);
  const fields = [['cpu', 'cpu', 'cpu_pct'], ['mem', 'memory', 'mem_used_pct'], ['disk', 'disk', 'disk_used_pct']];
  const lang = document.documentElement?.lang || undefined;
  const short = range === '7d' ? { month: 'numeric', day: 'numeric' } : { hour: '2-digit', minute: '2-digit' };
  const service = element(document, level === 'technical' ? 'p' : 'b', undefined, level === 'technical' ? 'wb-host-svc' : undefined);
  const values = new Map(); let tbody = null, rows = new Map();
  if (level !== 'technical') {
    const grid = element(document, 'div', undefined, 'wb-kvs');
    grid.append(element(document, 'span', t('wb.services')), service);
    for (const [name, field] of [['cpu', 'cpu_pct'], ['memory', 'mem_used_pct'], ['disk', 'disk_used_pct']]) {
      const node = element(document, 'b'); values.set(field, node);
      grid.append(element(document, 'span', t('wb.host.' + name)), node);
    }
    const note = element(document, 'p', t('wb.host.usageNote'), 'wb-note');
    const go = element(document, 'button', t('wb.host.usageLink'), 'wb-link-btn wb-chev'); go.type = 'button'; go.addEventListener('click', onUsage);
    note.append(go); card.append(grid, note);
  } else {
    title.append(rangeControl(document, range, onRange, t));
    card.append(service, hostLegend(document, t));
    for (const [index, [, label]] of fields.entries()) {
      charts.push(hostChart(card, { title: t('wb.host.' + label), current: null, peak: null, peakTitle: '',
        labels: [], avg: [], max: [], axis: index === fields.length - 1, document, t, chartFactory }));
    }
    const details = element(document, 'details', undefined, 'wb-host-table');
    details.append(element(document, 'summary', t('wb.usage.dataTable')));
    const scroll = element(document, 'div', undefined, 'wb-table-scroll');
    const table = element(document, 'table'), head = element(document, 'tr');
    head.append(element(document, 'th', t('wb.usage.bucket')));
    for (const [, label] of fields) for (const statistic of ['avg', 'max']) head.append(element(document, 'th', `${t('wb.host.' + label)} ${t('wb.host.' + statistic)}`));
    const thead = element(document, 'thead'); tbody = element(document, 'tbody'); thead.append(head); table.append(thead, tbody);
    scroll.append(table); details.append(scroll); card.append(details);
  }
  let errorNode = null;
  const update = (next, { meta: nextMeta = meta, pool: nextPool = pool, failure = null } = {}) => {
    const metaItems = [nextMeta?.name, ...(level === 'technical' ? [nextMeta?.mode, nextMeta?.core] : [])].filter(Boolean);
    if (metaItems.length) {
      setText(metaNode, metaItems.join(' · '));
      if (metaNode.parentNode !== header) header.append(metaNode);
    } else if (metaNode.parentNode === header) header.removeChild(metaNode);
    poolView.update(nextPool);
    const pm2 = next?.pm2, down = pm2 == null ? null : pm2.total - pm2.online;
    setText(service, level === 'technical'
      ? `${t('wb.host.pm2')} ${pm2 == null ? t('wb.unknown') : pm2.online + ' / ' + pm2.total} ${t('wb.host.online')}`
      : pm2 == null ? t('wb.unknown') : `${pm2.online} / ${pm2.total}` + (down ? ' · ' + t('wb.host.offline', { count: down }) : ''));
    if (level !== 'technical') {
      service.classList.toggle('wb-txt-warn', Boolean(down));
      for (const [field, node] of values) setText(node, percent(next?.current?.[field]));
    } else {
      const series = next?.series ?? [], labels = series.map(row => formatZoned(row.at, lang, short)), peak = next?.cpuPeak;
      for (const [index, [field, , current]] of fields.entries()) charts[index].update({ current: next?.current?.[current],
        peak: field === 'cpu' ? peak?.value ?? seriesPeak(series, field) : seriesPeak(series, field),
        peakTitle: field === 'cpu' && peak?.at ? formatZoned(peak.at, lang) : '', labels,
        avg: series.map(row => row[field]?.avg ?? null), max: series.map(row => row[field]?.max ?? null) });
      rows = keyedRows(tbody, series.map(row => [row.at, row]), rows, () => {
        const node = element(document, 'tr'), cells = [element(document, 'th'), ...Array.from({ length: 6 }, () => element(document, 'td'))];
        node.append(...cells); return { node, cells };
      }, (item, row) => {
        setText(item.cells[0], formatZoned(row.at, lang));
        let index = 1;
        for (const [field] of fields) for (const statistic of ['avg', 'max']) setText(item.cells[index++], percent(row[field]?.[statistic]));
      });
    }
    if (failure) {
      if (!errorNode) { errorNode = element(document, 'p', undefined, 'wb-detail-error'); root.append(errorNode); }
      setText(errorNode, t('wb.readFailed') + (level === 'technical' ? ' · ' + failure : ''));
    } else if (errorNode) { root.removeChild(errorNode); errorNode = null; }
  };
  update(value);
  return { update, destroy() { charts.forEach(chart => chart.destroy()); } };
}

export function createHostPanel({ root, read, identity = () => '', detail = () => 'plain', meta = () => null, pool = () => null,
  document = root.ownerDocument, t = key => key, onOpen = () => {}, onClose = () => {}, onUsage = () => {}, chartFactory } = {}) {
  let active = false, generation = 0, owner = null, data = null, rendered = null, range = '6h', failure = null, level = null, language = null;
  const draw = ({ reset = false } = {}) => {
    const nextLevel = detail(), nextLanguage = document.documentElement?.lang;
    if (reset || !rendered || level !== nextLevel || language !== nextLanguage) {
      rendered?.destroy(); level = nextLevel; language = nextLanguage;
      rendered = renderHost(root, data, { document, t, level, range, meta: meta(), pool: pool(), onClose: close,
        onUsage: () => { close(); onUsage(); }, onRange: next => { range = next; void refresh({ reset: true }); }, chartFactory });
    }
    rendered.update(data, { meta: meta(), pool: pool(), failure });
    root.hidden = false;
  };
  async function refresh({ reset = false } = {}) {
    if (!active) return;
    const current = ++generation, target = identity();
    reset ||= owner !== target;
    owner = target; failure = null;
    if (reset || data == null) { data = null; draw({ reset }); }
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
    open() { onOpen(); active = true; return refresh({ reset: true }); }, refresh, close,
    setViewDetail() { if (active && owner === identity()) draw(); },
    destroy() { close(); document.removeEventListener('keydown', escape); },
  };
}
