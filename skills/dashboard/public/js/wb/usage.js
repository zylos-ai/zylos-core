import { element, icon } from './plain-text.js?v=106';
import { money } from './instance-strip.js?v=196';
import { dateField } from './date-field.js?v=106';
import { instantFromInput } from './instance-zone.js?v=100';

const colors = ['#0d9488', '#6366f1', '#d97706'];
export const usageRanges = ['24h', '7d', 'month', '30d', 'custom'];
const numeric = value => Number.isFinite(Number(value)) ? Number(value) : 0;
export const formatCost = value => value == null ? '—' : '$' + Number(value).toFixed(4);
export const formatUsageCount = (value, t = key => key) => value == null ? t('wb.unknown') : Number(value).toLocaleString();
/** Large counts as 215M / 8.4K, the way the summary card shows them; small counts stay exact. */
export function compactCount(value, t = key => key) {
  if (value == null) return t('wb.unknown');
  const number = Number(value);
  if (Math.abs(number) >= 1e6) return `${+(number / 1e6).toFixed(number >= 1e7 ? 0 : 1)}M`;
  if (Math.abs(number) >= 1e4) return `${+(number / 1e3).toFixed(number >= 1e5 ? 0 : 1)}K`;
  return number.toLocaleString();
}
const defaultChart = (canvas, config) => new globalThis.Chart(canvas, config);

function zonedDate(at, tz) {
  const parts = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', { timeZone: tz ?? 'UTC', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(new Date(at))) parts[type] = value;
  return parts;
}

/** Short axis labels: `11-01` per day with today's bucket as `今天`, or `14:00` per hour. */
export function bucketLabels(buckets, { tz = 'UTC', bucket = 'day', now = Date.now(), t = key => key } = {}) {
  const today = zonedDate(now, tz);
  return buckets.map(at => {
    const parts = zonedDate(at, tz);
    if (bucket === 'hour') return `${parts.hour}:00`;
    const same = parts.year === today.year && parts.month === today.month && parts.day === today.day;
    return same ? t('wb.usage.today') : `${parts.month}-${parts.day}`;
  });
}

function cardHead(document, { iconName, title, subtitle, legend = [] }) {
  const head = element(document, 'div', undefined, 'wb-usage-head');
  const name = element(document, 'h3');
  if (iconName) name.append(icon(document, iconName, 'xs'));
  name.append(element(document, 'span', title));
  if (subtitle) name.append(element(document, 'small', subtitle));
  head.append(name);
  if (legend.length) {
    const keys = element(document, 'div', undefined, 'wb-usage-legend');
    for (const item of legend) {
      const key = element(document, 'span', undefined, 'wb-usage-key');
      const swatch = element(document, 'i');
      swatch.style.background = item.color;
      key.append(swatch, element(document, 'span', item.label));
      keys.append(key);
    }
    head.append(keys);
  }
  return head;
}

function dataTable(document, { labels, columns, t }) {
  const details = element(document, 'details', undefined, 'wb-usage-table');
  const summary = element(document, 'summary', undefined, 'wb-link-btn');
  summary.append(element(document, 'span', t('wb.usage.dataTable')), icon(document, 'chev', 'xs'));
  details.append(summary);
  const scroll = element(document, 'div'); scroll.style.overflowX = 'auto';
  const table = element(document, 'table'); table.style.width = '100%';
  const head = element(document, 'tr'); head.append(element(document, 'th', t('wb.usage.bucket')));
  for (const column of columns) head.append(element(document, 'th', column.label));
  const thead = element(document, 'thead'); thead.append(head); table.append(thead);
  const body = element(document, 'tbody');
  labels.forEach((label, index) => {
    const row = element(document, 'tr'); row.append(element(document, 'th', label));
    columns.forEach(column => row.append(element(document, 'td', column.data[index] == null ? '—' : column.data[index])));
    body.append(row);
  });
  table.append(body); scroll.append(table); details.append(scroll);
  return details;
}

// Both views: every chart names its series in the card header and has an expandable, text-only data table.
// A count chart (`counts`) has whole-number ticks; with `emptyText` a chart whose values are all zero says so instead.
export function seriesChart(root, { title, labels = [], datasets = [], stacked = false, horizontal = false,
  type = 'bar', iconName = null, subtitle = '', mirror = false, yFormat = null, counts = false, emptyText = null,
  document = root.ownerDocument, t = key => key, chartFactory = defaultChart }) {
  const card = element(document, 'section', undefined, 'wb-card wb-usage-chart');
  card.style.minWidth = '0';
  if (emptyText && datasets.every(dataset => dataset.data.every(value => value === 0))) {
    card.classList.add('wb-usage-unknown');
    card.append(cardHead(document, { iconName, title, subtitle }), element(document, 'p', emptyText, 'wb-usage-empty'));
    root.append(card);
    return { node: card, destroy() {} };
  }
  const legend = mirror
    ? [{ label: '↑ ' + datasets[0]?.label, color: colors[0] }, { label: '↓ ' + datasets[1]?.label, color: colors[1] }]
    : datasets.length > 1 ? datasets.map((dataset, index) => ({ label: dataset.label, color: colors[index % colors.length] })) : [];
  card.append(cardHead(document, { iconName, title, subtitle, legend }));
  const frame = element(document, 'div', undefined, 'wb-usage-frame'); frame.style.height = '220px'; frame.style.position = 'relative'; frame.style.minWidth = '0';
  const canvas = element(document, 'canvas'); canvas.setAttribute('aria-label', title); canvas.setAttribute('role', 'img'); frame.append(canvas); card.append(frame);
  // The table lists sent messages as positive counts even though the mirrored chart draws them below zero.
  card.append(dataTable(document, { labels, t, columns: datasets.map(dataset => ({ label: dataset.label,
    data: mirror ? dataset.data.map(value => value == null ? null : Math.abs(value)) : dataset.data })) }));
  root.append(card);
  const style = document.defaultView?.getComputedStyle(root);
  const textColor = style?.getPropertyValue('--text-muted').trim() || style?.getPropertyValue('--text').trim() || '#101827';
  const gridColor = style?.getPropertyValue('--border').trim() || 'rgba(15,118,110,0.16)';
  const panel = style?.getPropertyValue('--bg-elevated').trim() || 'transparent';
  const top = datasets.length - 1;
  const chart = chartFactory(canvas, { type, data: { labels, datasets: datasets.map((dataset, index) => ({
    borderColor: type === 'line' ? colors[index % colors.length] : panel,
    backgroundColor: colors[index % colors.length],
    borderWidth: type === 'line' ? 2 : stacked && !mirror && index < top ? { top: 2 } : 0, pointRadius: 0, spanGaps: false,
    ...(type === 'bar' ? { borderRadius: mirror ? 3 : stacked && index < top ? 0 : 4, borderSkipped: mirror ? false : 'start',
      maxBarThickness: 34, categoryPercentage: 0.62 } : {}),
    ...dataset,
  })) }, options: { responsive: true, maintainAspectRatio: false, indexAxis: horizontal ? 'y' : 'x',
    plugins: { legend: { display: false },
      tooltip: mirror ? { callbacks: { label: item => `${item.dataset.label}: ${Math.abs(item.raw)}` } } : {} },
    scales: {
      x: { stacked, ticks: { color: textColor, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }, grid: { display: false } },
      y: { stacked, beginAtZero: true, border: { display: false }, grid: { color: gridColor },
        ticks: { color: textColor, maxTicksLimit: 5, ...(counts ? { precision: 0 } : {}), ...(mirror ? { callback: value => Math.abs(value) } : yFormat ? { callback: yFormat } : {}) } },
    } } });
  return { node: card, destroy: () => chart?.destroy() };
}

/** Ranked counts as labelled bars: name, single-colour bar, value. Long names stay readable. */
export function barList(root, { title, rows = [], valueLabel, iconName = null, subtitle = '', document = root.ownerDocument,
  t = key => key }) {
  const card = element(document, 'section', undefined, 'wb-card wb-usage-chart wb-usage-bars');
  card.append(cardHead(document, { iconName, title, subtitle }));
  const peak = Math.max(1, ...rows.map(row => numeric(row.value)));
  const list = element(document, 'div', undefined, 'wb-usage-bar-list');
  for (const row of rows) {
    const line = element(document, 'div', undefined, 'wb-usage-bar-row');
    const name = element(document, 'span', row.name, 'wb-usage-bar-name');
    name.title = row.name;
    const track = element(document, 'span', undefined, 'wb-usage-bar-track');
    const fill = element(document, 'i');
    fill.style.width = `${numeric(row.value) / peak * 100}%`;
    track.append(fill);
    line.append(name, track, element(document, 'b', compactCount(row.value, t)));
    list.append(line);
  }
  if (!rows.length) list.append(element(document, 'p', t('wb.usage.none'), 'wb-note'));
  card.append(list, dataTable(document, { labels: rows.map(row => row.name), t,
    columns: [{ label: valueLabel, data: rows.map(row => row.value) }] }));
  root.append(card);
  return { node: card, destroy() {} };
}

/** The cache hit rate over the period the usage reply covers. */
export function cachePath({ since, until }) {
  return '/api/metrics/series?' + new URLSearchParams({ metric: 'cache', since, until, bucket: '86400' });
}

export function usagePath({ range = '7d', since = '', until = '' } = {}) {
  const params = new URLSearchParams({ range });
  if (range === 'custom') { params.set('since', since); params.set('until', until); }
  return '/api/workbench/usage?' + params;
}

const sum = rows => rows.reduce((total, value) => total + numeric(value), 0);

// Both views show costs and messages; all other usage details are technical only.
export function renderUsage(root, value, { document = root.ownerDocument, t = key => key,
  level = 'plain', chartFactory = defaultChart, now = Date.now(), cacheRate = null } = {}) {
  root.replaceChildren();
  const charts = [];
  if (!value) return { destroy() {} };
  if (value.tzFallback) root.append(element(document, 'p', t('wb.usage.utcFallback'), 'wb-note'));
  const totals = value.totals ?? {};
  // One summary card. Every number is the total of all groups (v9), said once in the card's caption.
  const card = element(document, 'section', undefined, 'wb-card wb-usage-summary');
  card.append(element(document, 'p', t('wb.usage.allGroups'), 'wb-usage-scope'));
  const summary = element(document, 'div', undefined, 'wb-usage-totals');
  const addTotal = (label, amount, sub = '', exact = null) => {
    const box = element(document, 'div', undefined, 'wb-usage-total');
    const strong = element(document, 'strong', amount);
    // Compact numbers keep the exact count in the tooltip.
    if (exact != null) strong.title = Number(exact).toLocaleString();
    box.append(element(document, 'small', label), strong);
    if (sub) box.append(element(document, 'small', sub, 'wb-usage-sub'));
    summary.append(box);
  };
  const runtimeCost = runtime => `${runtime === 'claude' ? 'Claude' : 'Codex'} ${totals.costByRuntime?.[runtime] == null
    ? t('wb.unknown') : money(totals.costByRuntime[runtime])}`;
  addTotal(t('wb.usage.cost'), totals.cost == null ? t('wb.unknown') : money(totals.cost),
    `${runtimeCost('claude')} · ${runtimeCost('codex')}`);
  addTotal(t('wb.usage.received'), formatUsageCount(totals.messages?.in, t),
    `${t('wb.usage.sent')} ${formatUsageCount(totals.messages?.out, t)}`);
  if (level === 'technical') {
    // The cache hit rate comes from the metrics endpoint: all engines together over the same period.
    addTotal(t('wb.usage.tokens'), compactCount(totals.tokens, t),
      cacheRate == null ? '' : t('wb.usage.cacheHit', { pct: Math.round(cacheRate * 100) }), totals.tokens);
    addTotal(t('wb.usage.rotations'), totals.rotations == null ? t('wb.unknown') : t('wb.usage.times', { count: totals.rotations }),
      t('wb.usage.rotationsHint'));
    addTotal(t('wb.usage.tools'), compactCount(totals.tools, t),
      value.tools?.[0] ? t('wb.usage.topTool', { name: value.tools[0].name }) : '', totals.tools);
  }
  card.append(summary);
  root.append(card);
  const grid = element(document, 'div', undefined, 'wb-usage-grid');
  root.append(grid);
  const buckets = value.buckets ?? [];
  const labels = bucketLabels(buckets, { tz: value.tz ?? 'UTC', bucket: value.bucket, now, t });
  const per = t(value.bucket === 'hour' ? 'wb.usage.perHour' : 'wb.usage.perDay');
  const runtimeSeries = field => ['claude', 'codex'].map(runtime => { const points = new Map((value[field] ?? []).filter(row => row.runtime === runtime).map(row => [row.at, row.value])); return { label: runtime === 'claude' ? 'Claude' : 'Codex', data: buckets.map(at => numeric(points.get(at))) }; });
  const messages = new Map((value.messages ?? []).map(row => [row.at, row]));
  const rotations = new Map((value.rotations ?? []).map(row => [row.at, row.value]));
  const add = spec => {
    const chart = seriesChart(grid, { ...spec, document, t, chartFactory });
    charts.push(chart);
    return chart;
  };
  // An unknown item is a short full-row card, so the charts around it keep their pairs.
  const unknown = (title, iconName, reason = null, sampledAt = null) => {
    const card = element(document, 'section', undefined, 'wb-card wb-usage-chart wb-usage-wide wb-usage-unknown');
    const head = element(document, 'h3');
    head.append(icon(document, iconName, 'xs'), element(document, 'span', title));
    card.append(head, element(document, 'p', t('wb.unknown')));
    if (level === 'technical' && reason) {
      card.append(element(document, 'p', reason + ' · ' + sampledAt, 'wb-usage-reason'));
    }
    grid.append(card);
  };
  const cost = runtimeSeries('costByRuntime');
  add({ title: t('wb.usage.cost'), iconName: 'dollar', labels, datasets: cost, stacked: true, yFormat: amount => '$' + amount,
    subtitle: `${per} · ${t('wb.usage.total')} ${totals.cost == null ? t('wb.unknown') : money(totals.cost)}` });
  if (value.messagesReason) unknown(t('wb.usage.messages'), 'msg', value.messagesReason, value.messagesSampledAt);
  else add({ title: t('wb.usage.messages'), iconName: 'msg', labels, mirror: true, counts: true,
    subtitle: `${t('wb.usage.received')} ${formatUsageCount(totals.messages?.in, t)} · ${t('wb.usage.sent')} ${formatUsageCount(totals.messages?.out, t)}`,
    datasets: [
      { label: t('wb.usage.received'), data: buckets.map(at => numeric(messages.get(at)?.in)) },
      { label: t('wb.usage.sent'), data: buckets.map(at => -numeric(messages.get(at)?.out)) },
    ], stacked: true });
  if (level === 'technical') {
    const tokens = runtimeSeries('tokensByRuntime');
    const tokenChart = add({ title: t('wb.usage.tokens'), iconName: 'layers', labels, datasets: tokens, stacked: true, yFormat: amount => compactCount(amount, t),
      subtitle: `${per} · ${t('wb.usage.total')} ${compactCount(totals.tokens ?? sum(tokens.flatMap(row => row.data)), t)}` });
    // Without its rotations partner the token chart takes the whole row.
    if (value.rotations === null) tokenChart.node.classList.add('wb-usage-wide');
    if (value.rotations === null) unknown(t('wb.usage.rotations'), 'restart');
    else add({ title: t('wb.usage.rotations'), iconName: 'restart', labels, counts: true, emptyText: t('wb.usage.noRotations'),
      subtitle: t('wb.usage.rotationsHint'),
      datasets: [{ label: t('wb.usage.rotations'), data: buckets.map(at => numeric(rotations.get(at))) }] });
    if (value.tools === null) unknown(t('wb.usage.tools'), 'tool');
    else {
      const tools = barList(grid, { title: t('wb.usage.tools'), iconName: 'tool', valueLabel: t('wb.usage.calls'), document, t,
        subtitle: t('wb.usage.topTen'), rows: (value.tools ?? []).map(row => ({ name: row.name, value: row.count })) });
      tools.node.classList.add('wb-usage-wide');
      charts.push(tools);
    }
    const projects = barList(grid, { title: t('wb.usage.projects'), iconName: 'book', valueLabel: t('wb.usage.outputTokens'), document, t,
      subtitle: t('wb.usage.outputTokens'), rows: (value.projects?.items ?? []).map(row => ({ name: row.name, value: row.outputTokens })) });
    projects.node.classList.add('wb-usage-wide');
    charts.push(projects);
  }
  return { destroy() { charts.forEach(chart => chart.destroy()); } };
}

export function createUsagePage({ root, read, identity = () => '', detail = () => 'plain',
  document = root.ownerDocument, t = key => key, chartFactory = defaultChart } = {}) {
  let generation = 0, active = false, owner = null, data = null, rendered = null, range = '7d', cacheRate = null;
  root.classList?.add('wb-usage-page');
  const controls = element(document, 'div', undefined, 'wb-usage-controls');
  // Fixed ranges are a segmented control; the custom dates stay visible and apply on their own.
  const seg = element(document, 'div', undefined, 'wb-seg'); seg.id = 'wb-usage-range';
  seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', t('wb.usage.range'));
  const choices = usageRanges.filter(name => name !== 'custom').map(name => {
    const button = element(document, 'button', t('wb.usage.range.' + name)); button.type = 'button'; button.dataset.range = name;
    button.addEventListener('click', () => choose(name)); seg.append(button); return button;
  });
  const since = element(document, 'input'); since.type = 'datetime-local'; since.id = 'wb-usage-since'; since.setAttribute('aria-label', t('wb.usage.since'));
  const until = element(document, 'input'); until.type = 'datetime-local'; until.id = 'wb-usage-until'; until.setAttribute('aria-label', t('wb.usage.until'));
  const sinceField = dateField(document, since, () => t('wb.usage.since'));
  const untilField = dateField(document, until, () => t('wb.usage.until'));
  const dash = element(document, 'span', '—', 'wb-usage-dash');
  const apply = element(document, 'button', t('wb.usage.apply'), 'wb-btn'); apply.type = 'button'; apply.id = 'wb-usage-apply';
  // Wide screens show the custom dates beside the ranges. Phones fold them behind the last segment and open
  // them on one row; the fold only shows or hides the fields and reads nothing.
  const custom = element(document, 'div', undefined, 'wb-usage-custom'); custom.id = 'wb-usage-custom';
  custom.append(sinceField.field, dash, untilField.field, apply);
  const customToggle = element(document, 'button', t('wb.usage.range.custom'), 'wb-usage-custom-btn'); customToggle.type = 'button';
  customToggle.setAttribute('aria-controls', custom.id);
  let customOpen = false;
  customToggle.addEventListener('click', () => { customOpen = !customOpen; mark(); });
  seg.append(customToggle);
  controls.append(seg, custom);
  const status = element(document, 'p', undefined, 'wb-usage-status'); status.id = 'wb-usage-status'; status.setAttribute('role', 'status');
  const deletionNotice = element(document, 'p', t('wb.usage.deletedConversations'), 'wb-usage-deletion-note');
  const body = element(document, 'div'); body.id = 'wb-usage-body'; root.replaceChildren(controls, deletionNotice, status, body);
  const mark = () => {
    choices.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.range === range)));
    const open = customOpen || range === 'custom';
    customToggle.setAttribute('aria-expanded', String(open)); customToggle.classList.toggle('wb-on', range === 'custom');
    controls.classList.toggle('wb-usage-custom-open', open);
  };
  const draw = () => {
    deletionNotice.textContent = t('wb.usage.deletedConversations');
    for (const button of choices) button.textContent = t('wb.usage.range.' + button.dataset.range);
    customToggle.textContent = t('wb.usage.range.custom');
    seg.setAttribute('aria-label', t('wb.usage.range'));
    since.setAttribute('aria-label', t('wb.usage.since')); until.setAttribute('aria-label', t('wb.usage.until')); apply.textContent = t('wb.usage.apply');
    sinceField.sync(); untilField.sync();
    mark();
    rendered?.destroy(); rendered = renderUsage(body, data, { document, t, level: detail(), chartFactory, cacheRate }); };
  const clear = () => { data = null; cacheRate = null; draw(); };
  async function refresh() {
    if (!active) return;
    const current = ++generation, target = identity(); owner = target;
    clear(); status.textContent = t('wb.usage.loading');
    const custom = range === 'custom';
    // The custom range is entered as wall time in the instance time zone, like every time on this page.
    const start = custom ? instantFromInput(since.value) : null, end = custom ? instantFromInput(until.value) : null;
    if (custom && (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 366 * 86400000)) {
      status.textContent = t('wb.usage.invalidRange'); return;
    }
    try {
      const value = await read(usagePath({ range, since: custom ? new Date(start).toISOString() : '', until: custom ? new Date(end).toISOString() : '' }));
      if (!active || current !== generation || target !== identity()) return;
      data = value; status.textContent = ''; draw();
    } catch (error) {
      if (!active || current !== generation || target !== identity()) return;
      status.textContent = t('wb.readFailed') + (detail() === 'technical' ? ' · ' + error.message : '');
      return;
    }
    await readCache(current, target);
  }
  // The hit rate is an extra line under the technical token total; when it cannot be read the line is left out.
  async function readCache(current = generation, target = identity()) {
    if (detail() !== 'technical' || cacheRate != null || !data?.since || !data?.until) return;
    try {
      const cache = await read(cachePath(data));
      if (!active || current !== generation || target !== identity()) return;
      cacheRate = Number.isFinite(cache?.total) ? cache.total : null;
      if (cacheRate != null) draw();
    } catch {}
  }
  function choose(name) {
    if (range === name) return;
    range = name; generation++; clear(); status.textContent = ''; void refresh();
  }
  const applyCustom = () => { range = 'custom'; mark(); return refresh(); };
  apply.addEventListener('click', applyCustom); mark();
  return {
    open() { active = true; return refresh(); }, refresh,
    close() { active = false; generation++; clear(); status.textContent = ''; },
    setViewDetail() { if (active && owner === identity()) { draw(); void readCache(); } },
    destroy() { active = false; generation++; rendered?.destroy(); apply.removeEventListener('click', applyCustom); root.replaceChildren(); },
  };
}
