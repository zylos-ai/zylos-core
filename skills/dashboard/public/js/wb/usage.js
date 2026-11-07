import { element } from './plain-text.js?v=92';

const colors = ['#0d9488', '#6366f1', '#d97706'];
export const usageRanges = ['24h', '7d', '30d', 'month', 'custom'];
const numeric = value => Number.isFinite(Number(value)) ? Number(value) : 0;
export const formatCost = value => value == null ? '—' : '$' + Number(value).toFixed(4);
export const formatUsageCount = (value, t = key => key) => value == null ? t('wb.unknown') : Number(value).toLocaleString();
const defaultChart = (canvas, config) => new globalThis.Chart(canvas, config);

// Both views: every chart has a legend and an expandable, text-only data table.
export function seriesChart(root, { title, labels = [], datasets = [], stacked = false, horizontal = false,
  type = 'bar', document = root.ownerDocument, t = key => key, chartFactory = defaultChart }) {
  const card = element(document, 'section', undefined, 'wb-card wb-usage-chart');
  card.style.minWidth = '0';
  card.append(element(document, 'h3', title));
  const frame = element(document, 'div'); frame.style.height = '240px'; frame.style.position = 'relative'; frame.style.minWidth = '0';
  const canvas = element(document, 'canvas'); canvas.setAttribute('aria-label', title); canvas.setAttribute('role', 'img'); frame.append(canvas); card.append(frame);
  const details = element(document, 'details'); details.append(element(document, 'summary', t('wb.usage.dataTable')));
  const scroll = element(document, 'div'); scroll.style.overflowX = 'auto';
  const table = element(document, 'table'); table.style.width = '100%';
  const head = element(document, 'tr'); head.append(element(document, 'th', t('wb.usage.bucket')));
  for (const dataset of datasets) head.append(element(document, 'th', dataset.label));
  const thead = element(document, 'thead'); thead.append(head); table.append(thead);
  const body = element(document, 'tbody');
  labels.forEach((label, index) => {
    const row = element(document, 'tr'); row.append(element(document, 'th', label));
    datasets.forEach(dataset => row.append(element(document, 'td', dataset.data[index] == null ? '—' : dataset.data[index])));
    body.append(row);
  });
  table.append(body); scroll.append(table); details.append(scroll); card.append(details); root.append(card);
  const style = document.defaultView?.getComputedStyle(root);
  const textColor = style?.getPropertyValue('--text').trim() || '#101827';
  const gridColor = style?.getPropertyValue('--border').trim() || 'rgba(15,118,110,0.16)';
  const chart = chartFactory(canvas, { type, data: { labels, datasets: datasets.map((dataset, index) => ({
    borderColor: colors[index % colors.length], backgroundColor: colors[index % colors.length],
    borderWidth: type === 'line' ? 2 : 0, pointRadius: 0, spanGaps: false, ...dataset,
  })) }, options: { responsive: true, maintainAspectRatio: false, indexAxis: horizontal ? 'y' : 'x',
    plugins: { legend: { display: true, position: 'bottom', labels: { color: textColor } } },
    scales: { x: { stacked, ticks: { color: textColor }, grid: { color: gridColor } }, y: { stacked, beginAtZero: true, ticks: { color: textColor }, grid: { color: gridColor } } } } });
  return { node: card, destroy: () => chart?.destroy() };
}

export function usagePath({ range = '7d', since = '', until = '' } = {}) {
  const params = new URLSearchParams({ range });
  if (range === 'custom') { params.set('since', since); params.set('until', until); }
  return '/api/workbench/usage?' + params;
}

// Both views show costs and messages; all other usage details are technical only.
export function renderUsage(root, value, { document = root.ownerDocument, t = key => key,
  level = 'plain', chartFactory = defaultChart } = {}) {
  root.replaceChildren();
  const charts = [];
  if (!value) return { destroy() {} };
  root.append(element(document, 'p', t('wb.usage.allGroups'), 'wb-usage-scope'));
  if (value.tzFallback) root.append(element(document, 'p', t('wb.usage.utcFallback')));
  const totals = value.totals ?? {}, summary = element(document, 'div', undefined, 'wb-usage-totals');
  summary.style.display = 'flex'; summary.style.flexWrap = 'wrap'; summary.style.gap = '12px';
  const addTotal = (label, amount, kind = 'count') => {
    const box = element(document, 'div', undefined, 'wb-card');
    box.style.display = 'flex'; box.style.alignItems = 'baseline'; box.style.gap = '8px';
    box.append(element(document, 'small', label), element(document, 'strong', amount == null ? t('wb.unknown') : kind === 'cost' ? formatCost(amount) : formatUsageCount(amount, t))); summary.append(box);
  };
  addTotal(t('wb.usage.cost'), totals.cost, 'cost');
  for (const runtime of ['claude', 'codex']) addTotal(runtime === 'claude' ? 'Claude' : 'Codex', totals.costByRuntime?.[runtime], 'cost');
  addTotal(t('wb.usage.received'), totals.messages?.in); addTotal(t('wb.usage.sent'), totals.messages?.out);
  if (level === 'technical') {
    addTotal(t('wb.usage.tokens'), totals.tokens); addTotal(t('wb.usage.rotations'), totals.rotations); addTotal(t('wb.usage.tools'), totals.tools);
  }
  root.append(summary);
  const grid = element(document, 'div', undefined, 'wb-usage-grid');
  grid.style.display = 'grid'; grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))'; grid.style.gap = '16px'; root.append(grid);
  const buckets = value.buckets ?? [];
  const labels = buckets.map(at => new Date(at).toLocaleString(document.documentElement?.lang, { timeZone: value.tz ?? 'UTC', month: 'short', day: 'numeric', ...(value.bucket === 'hour' ? { hour: '2-digit' } : {}) }));
  const runtimeSeries = field => ['claude', 'codex'].map(runtime => { const points = new Map((value[field] ?? []).filter(row => row.runtime === runtime).map(row => [row.at, row.value])); return { label: runtime === 'claude' ? 'Claude' : 'Codex', data: buckets.map(at => numeric(points.get(at))) }; });
  const messages = new Map((value.messages ?? []).map(row => [row.at, row]));
  const rotations = new Map((value.rotations ?? []).map(row => [row.at, row.value]));
  const add = spec => charts.push(seriesChart(grid, { ...spec, document, t, chartFactory }));
  const unknown = (title, reason = null, sampledAt = null) => {
    const card = element(document, 'section', undefined, 'wb-card');
    card.append(element(document, 'h3', title), element(document, 'p', t('wb.unknown')));
    if (level === 'technical' && reason) {
      card.append(element(document, 'p', reason + ' · ' + sampledAt, 'wb-usage-reason'));
    }
    grid.append(card);
  };
  add({ title: t('wb.usage.cost'), labels, datasets: runtimeSeries('costByRuntime'), stacked: true });
  if (value.messagesReason) unknown(t('wb.usage.messages'), value.messagesReason, value.messagesSampledAt);
  else add({ title: t('wb.usage.messages'), labels, datasets: [
    { label: t('wb.usage.received'), data: buckets.map(at => numeric(messages.get(at)?.in)) },
    { label: t('wb.usage.sent'), data: buckets.map(at => -numeric(messages.get(at)?.out)) },
  ], stacked: true });
  if (level === 'technical') {
    add({ title: t('wb.usage.tokens'), labels, datasets: runtimeSeries('tokensByRuntime'), stacked: true });
    if (value.rotations === null) unknown(t('wb.usage.rotations'));
    else add({ title: t('wb.usage.rotations'), labels, datasets: [{ label: t('wb.usage.rotations'), data: buckets.map(at => numeric(rotations.get(at))) }] });
    if (value.tools === null) unknown(t('wb.usage.tools'));
    else add({ title: t('wb.usage.tools'), labels: (value.tools ?? []).map(row => row.name),
      datasets: [{ label: t('wb.usage.calls'), data: (value.tools ?? []).map(row => numeric(row.count)) }], horizontal: true });
    add({ title: t('wb.usage.projects'), labels: (value.projects?.items ?? []).map(row => row.name),
      datasets: [{ label: t('wb.usage.outputTokens'), data: (value.projects?.items ?? []).map(row => numeric(row.outputTokens)) }], horizontal: true });
  }
  return { destroy() { charts.forEach(chart => chart.destroy()); } };
}

export function createUsagePage({ root, read, identity = () => '', detail = () => 'plain',
  document = root.ownerDocument, t = key => key, chartFactory = defaultChart } = {}) {
  let generation = 0, active = false, owner = null, data = null, rendered = null;
  const controls = element(document, 'div', undefined, 'wb-usage-controls');
  controls.style.display = 'flex'; controls.style.flexWrap = 'wrap'; controls.style.gap = '8px';
  const range = element(document, 'select'); range.id = 'wb-usage-range'; range.setAttribute('aria-label', t('wb.usage.range'));
  for (const name of usageRanges) { const option = element(document, 'option', t('wb.usage.range.' + name)); option.value = name; range.append(option); }
  range.value = '7d';
  const since = element(document, 'input'); since.type = 'datetime-local'; since.id = 'wb-usage-since'; since.setAttribute('aria-label', t('wb.usage.since'));
  const until = element(document, 'input'); until.type = 'datetime-local'; until.id = 'wb-usage-until'; until.setAttribute('aria-label', t('wb.usage.until'));
  const apply = element(document, 'button', t('wb.usage.apply')); apply.type = 'button'; apply.id = 'wb-usage-apply';
  controls.append(range, since, until, apply);
  const status = element(document, 'p'); status.id = 'wb-usage-status'; status.setAttribute('role', 'status');
  const body = element(document, 'div'); body.id = 'wb-usage-body'; root.replaceChildren(controls, status, body);
  const updateRange = () => { since.hidden = until.hidden = apply.hidden = range.value !== 'custom'; };
  const draw = () => {
    for (const option of range.children) option.textContent = t('wb.usage.range.' + option.value);
    range.setAttribute('aria-label', t('wb.usage.range'));
    since.setAttribute('aria-label', t('wb.usage.since')); until.setAttribute('aria-label', t('wb.usage.until')); apply.textContent = t('wb.usage.apply');
    rendered?.destroy(); rendered = renderUsage(body, data, { document, t, level: detail(), chartFactory }); };
  const clear = () => { data = null; draw(); };
  async function refresh() {
    if (!active) return;
    const current = ++generation, target = identity(); owner = target;
    clear(); status.textContent = t('wb.usage.loading');
    const custom = range.value === 'custom';
    const start = custom ? new Date(since.value).getTime() : null, end = custom ? new Date(until.value).getTime() : null;
    if (custom && (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 366 * 86400000)) {
      status.textContent = t('wb.usage.invalidRange'); return;
    }
    try {
      const value = await read(usagePath({ range: range.value, since: custom ? new Date(start).toISOString() : '', until: custom ? new Date(end).toISOString() : '' }));
      if (!active || current !== generation || target !== identity()) return;
      data = value; status.textContent = ''; draw();
    } catch (error) {
      if (!active || current !== generation || target !== identity()) return;
      status.textContent = t('wb.readFailed') + (detail() === 'technical' ? ' · ' + error.message : '');
    }
  }
  const change = () => { generation++; clear(); status.textContent = ''; updateRange(); if (range.value !== 'custom') void refresh(); };
  range.addEventListener('change', change); apply.addEventListener('click', refresh); updateRange();
  return {
    open() { active = true; return refresh(); }, refresh,
    close() { active = false; generation++; clear(); status.textContent = ''; },
    setViewDetail() { if (active && owner === identity()) draw(); },
    destroy() { active = false; generation++; rendered?.destroy(); range.removeEventListener('change', change); apply.removeEventListener('click', refresh); root.replaceChildren(); },
  };
}
