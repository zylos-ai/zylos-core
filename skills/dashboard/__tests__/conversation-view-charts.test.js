import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { createDocument, allNodes } from './helpers/conversation-dom.js';
import { CONTENT_PREFIX, parseC4Content } from '../../comm-bridge/scripts/c4-content-schema.js';
import { applyChatView } from '../public/js/wb/chat-view.js';
import { conversationChartConfig, conversationChartResource } from '../public/js/wb/conversation-charts.js';
import { formatDuration } from '../public/js/wb/duration-format.js';
const shared = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname.endsWith('/public/chat-schema.js')) return next(shared, context);
  return next(specifier, context);
} });
const { renderConversationContent } = await import('../public/js/wb/conversation-content.js');
const { renderChatContent } = await import('../public/js/wb/chat-blocks.js');
const fixtures = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/view-and-form.json', import.meta.url), 'utf8'));
const t = key => key;
const row = envelope => ({ id: 7, content: CONTENT_PREFIX + JSON.stringify(envelope) });

test('duration formatting handles fractions signs zero and rounding into larger units', () => {
  for (const [seconds, digits, expected] of [
    [0, 6, '0s'], [-0, 6, '0s'], [-0.0001, 0, '0s'],
    [1.25, 2, '1.25s'], [61.25, 2, '1m 1.25s'], [-61.25, 2, '-1m 1.25s'],
    [59.9999, 0, '1m'], [3599.9999, 0, '1h'],
    [-3599.9999, 0, '-1h'], [5400, 6, '1h 30m'], [-5400, 6, '-1h 30m'],
  ]) assert.equal(formatDuration(seconds, digits, 'en-US'), expected, `${seconds} seconds rounded to ${digits} fractional digits`);
});

test('invalid envelope fallback bypasses composed Markdown rendering and all question controls', () => {
  const document = createDocument();
  let markdownCalls = 0;
  document.defaultView = { markdownit: () => ({
    use() { return this; }, renderer: { rules: {} }, utils: { escapeHtml: value => value },
    render() { markdownCalls++; assert.fail('invalid fallback must remain plain text'); },
  }) };
  const envelope = structuredClone(fixtures.message);
  envelope.fallbackText = '**Notice** <script>evil()</script> [link](https://example.test)';
  envelope.blocks.push({ id: 'unknown', type: 'future_block', schemaVersion: 1, fallbackText: 'Block fallback', data: {} });
  const content = renderConversationContent({ document, row: row(envelope), t,
    renderQuestion() { assert.fail('invalid envelope cannot offer an answer'); } });
  assert.equal(markdownCalls, 0);
  assert.equal(content.querySelector('.chat-invalid-fallback').textContent, envelope.fallbackText);
  assert.equal(content.querySelector('.conversation-markdown'), null);
  assert.equal(content.textContent, envelope.fallbackText + 'chat.partialContentchat.block.reference 7');
  assert.equal(allNodes(content).some(node => node.dataset.blockId || ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SCRIPT', 'A'].includes(node.tagName)), false);
  content.destroy();
});

for (const name of ['balanced_columns', 'sidebar_columns', 'section_slots']) test(`validated ${name} moves complete blocks and preserves one question control`, () => {
  const document = createDocument(), envelope = structuredClone(fixtures.message);
  envelope.metadata = { view: fixtures.views.find(view => view.name === name).view };
  assert.equal(parseC4Content(row(envelope).content).view?.schemaVersion, 1);
  const control = document.createElement('button'); control.textContent = 'Answer';
  let calls = 0, originals;
  const content = renderChatContent({ document, row: row(envelope), t,
    renderQuestion() { calls++; return control; }, layout(root, view, blockNodes) {
      originals = [...blockNodes.values()]; applyChatView(document, root, view, blockNodes);
    } });
  assert.equal(calls, 1);
  assert.equal(allNodes(content).filter(node => node === control).length, 1);
  for (const node of originals) assert.equal(allNodes(content).filter(current => current === node).length, 1);
  assert.equal(allNodes(content).filter(node => node.dataset.blockId).length, 3);
  assert.ok(content.textContent.indexOf('Plan A') < content.textContent.indexOf('Plan B'));
  if (name === 'section_slots') {
    assert.equal(content.querySelector('.conversation-view-actions').querySelector('button'), control);
  } else {
    assert.equal(content.lastElementChild.dataset.blockId, 'question');
    assert.equal(content.firstElementChild.dataset.layout, name === 'sidebar_columns' ? 'sidebar' : 'balanced');
  }
});

test('stack gap and section slots are presentation only while unreferenced content appends in order', () => {
  const document = createDocument(), envelope = structuredClone(fixtures.message);
  envelope.metadata = { view: { schemaVersion: 1, root: 'root', nodes: [
    { id: 'root', type: 'stack', gap: 'compact', children: ['second', 'first'] },
    { id: 'first', type: 'block', blockId: 'plan_a' }, { id: 'second', type: 'block', blockId: 'plan_b' }
  ] } };
  const content = renderConversationContent({ document, row: row(envelope), t });
  assert.equal(content.firstElementChild.dataset.gap, 'compact');
  assert.equal(content.firstElementChild.firstElementChild.dataset.blockId, 'plan_b');
  assert.equal(content.lastElementChild.dataset.blockId, 'question');
  assert.equal(allNodes(content).some(node => ['SCRIPT', 'A', 'STYLE'].includes(node.tagName)), false);
});

test('invalid views fall back to original Content order without duplicate actions', () => {
  for (const view of [
    { schemaVersion: 99, root: 'root', nodes: [] },
    { schemaVersion: 1, root: 'root', nodes: [{ id: 'root', type: 'stack', children: ['a', 'b'] },
      { id: 'a', type: 'block', blockId: 'question' }, { id: 'b', type: 'block', blockId: 'question' }] }
  ]) {
    const document = createDocument(), envelope = structuredClone(fixtures.message); envelope.metadata = { view };
    const parsed = parseC4Content(row(envelope).content);
    assert.equal(parsed.kind, 'envelope'); assert.equal(parsed.view, null); assert.ok(parsed.viewError);
    let calls = 0;
    const content = renderConversationContent({ document, row: row(envelope), t, renderQuestion() {
      calls++; return document.createElement('button');
    } });
    assert.equal(calls, 1); assert.equal(content.children.length, 3);
    assert.equal(content.firstElementChild.dataset.blockId, 'plan_a');
    assert.equal(content.lastElementChild.dataset.blockId, 'question');
    assert.equal(allNodes(content).filter(node => node.tagName === 'BUTTON').length, 1);
  }
});

const seriesBlock = (xType = 'category') => ({ id: 'traffic', type: 'time_series', schemaVersion: 1,
  fallbackText: 'Traffic table', data: { title: 'Requests', xType, xLabel: 'Time', yLabel: 'Requests', yUnit: 'req',
    series: [{ key: 'a', label: 'A', points: [{ x: xType === 'category' ? 'p50' : 0, y: 4200 }, { x: xType === 'category' ? 'p99' : 5, y: null }] },
      { key: 'b', label: 'B', points: [{ x: xType === 'category' ? 'p50' : 0, y: 6100 }] }], summary: 'Replay' } });

test('categorical time series uses aligned grouped bars with titles axes legends and missing gaps', () => {
  const config = conversationChartConfig(seriesBlock());
  assert.equal(config.type, 'bar'); assert.equal(config.options.scales.x.stacked, false);
  assert.equal(config.options.scales.y.stacked, false); assert.equal(config.options.plugins.legend.display, true);
  assert.equal(config.options.scales.x.title.text, 'Time'); assert.equal(config.options.scales.y.title.text, 'Requests');
  assert.equal(config.data.labels.join(','), 'p50,p99');
  assert.equal(config.data.datasets[1].data[0], 6100); assert.equal(config.data.datasets[1].data[1], null);
  assert.equal(config.options.plugins.tooltip.callbacks.label({ parsed: { y: 4200 }, dataset: config.data.datasets[0] }), 'A: 4,200 req');
});

test('duration axis ticks and tooltips use the same readable seconds as the chart table', () => {
  const block = seriesBlock(); block.data.format = { style: 'duration' };
  block.data.series = [{ key: 'latency', label: 'Latency', points: [
    { x: 'Short', y: 59 }, { x: 'Hour', y: 3600 }, { x: 'Long', y: 5400 },
  ] }];
  const config = conversationChartConfig(block);
  for (const [seconds, expected] of [[59, '59s'], [3600, '1h'], [5400, '1h 30m']]) {
    assert.equal(config.options.scales.y.ticks.callback(seconds), expected);
    assert.equal(config.options.plugins.tooltip.callbacks.label({ parsed: { y: seconds }, dataset: config.data.datasets[0] }), `Latency: ${expected}`);
  }
  assert.deepEqual(config.data.datasets[0].data, [59, 3600, 5400]);
  const document = createDocument();
  const envelope = { version: 1, kind: 'message', messageId: 'durations', fallbackText: 'Durations', blocks: [block] };
  const content = renderConversationContent({ document, row: row(envelope), t });
  assert.deepEqual(allNodes(content).filter(node => node.className === 'chat-chart-value').map(node => node.textContent), ['59s', '1h', '1h 30m']);
  content.destroy();
});

test('mixed units have separate scales and are never summed in a stack', () => {
  const block = seriesBlock(); block.data.series[1].unit = 'bytes';
  const config = conversationChartConfig(block);
  assert.equal(config.options.scales.x.stacked, false); assert.equal(config.options.scales.y.stacked, false);
  assert.equal(config.data.datasets[0].yAxisID, 'y'); assert.equal(config.data.datasets[1].yAxisID, 'y1');
  assert.equal(config.options.scales.y1.title.text, 'Requests · bytes');
});

for (const xType of ['number', 'date', 'datetime']) test(`${xType} time series ${xType === 'date' ? 'reads x as its calendar day' : 'keeps native x values'} and line null gaps`, () => {
  const block = seriesBlock(xType);
  if (xType !== 'number') block.data.series[0].points = [{ x: xType === 'date' ? '2026-01-01' : '2026-01-01T00:00:00Z', y: null }];
  const config = conversationChartConfig(block);
  assert.equal(config.type, 'line'); assert.equal(config.options.scales.x.type, xType === 'number' ? 'linear' : 'time');
  assert.equal(config.data.datasets[0].data[0].x, xType === 'date' ? new Date(2026, 0, 1).getTime() : block.data.series[0].points[0].x);
  assert.equal(config.data.datasets[0].spanGaps, false);
});

test('category series shows horizontal signed bars and a labeled reference', () => {
  const config = conversationChartConfig({ type: 'category_series', data: { title: 'Change', unit: 'USD', xLabel: 'Category', yLabel: 'Amount',
    points: [{ label: 'A', value: -5 }, { label: 'B', value: null }], reference: { label: 'Target', value: 1 } } });
  assert.equal(config.options.indexAxis, 'y'); assert.equal(config.data.datasets[0].data[0], -5);
  assert.equal(config.data.datasets[0].data[1], null); assert.equal(config.data.datasets[1].label, 'Target');
  assert.equal(config.data.datasets[1].data[1].x, 1); assert.equal(config.data.datasets[1].data[1].y, 1);
  assert.equal(config.options.scales.x.title.text, 'Amount');
  assert.equal(config.options.scales.x.title.display, true);
  assert.equal(config.options.scales.y.title.display, false);
});

test('breakdown uses one nonnegative stack with part legends and value formatting', () => {
  const config = conversationChartConfig({ type: 'breakdown', data: { title: 'Budget', format: { style: 'percent' },
    parts: [{ label: 'A', value: 0.3 }, { label: 'B', value: 0.7 }] } });
  assert.equal(config.options.indexAxis, 'y'); assert.equal(config.options.scales.x.stacked, true);
  assert.equal(config.data.datasets.length, 2); assert.equal(config.data.datasets[1].label, 'B');
  assert.equal(config.options.scales.x.display, false);
  assert.equal(config.options.plugins.conversationValues.format(0.3), '30%');
});

function chartRoot(Chart, block = seriesBlock(), options = {}) {
  const document = createDocument(); document.defaultView = { Chart };
  const envelope = { version: 1, kind: 'message', messageId: 'chart-message', fallbackText: 'Traffic', blocks: [block] };
  const content = renderConversationContent({ document, row: row(envelope), t, ...options });
  return { document, content };
}

for (const locale of ['en-US', 'de-DE']) for (const [style, values] of [
  [undefined, [1234.5, null, -2]], ['percent', [0.125, null, 0]], ['duration', [61.25, null, 5400]],
]) test(`enhanced time data matches tooltip values and keeps null gaps for ${style ?? 'decimal'} in ${locale}`, t => {
  const block = seriesBlock('number');
  if (style) block.data.format = { style };
  block.data.series[0].points = values.map((y, x) => ({ x, y }));
  block.data.series[1].points = [{ x: 0, y: style === 'percent' ? 0.5 : 2048 }];
  block.data.series[1].unit = 'bytes';
  let config;
  const { document, content } = chartRoot(class { constructor(canvas, value) { config = value; } resize() {} destroy() {} }, block);
  t.after(() => content.destroy());
  document.documentElement.lang = locale;
  content.mount();
  const details = content.querySelector('details.conversation-chart-data');
  const tables = details.querySelectorAll('table.conversation-chart-table');
  assert.equal(tables.length, 2, 'each series keeps its independent x sequence');
  assert.equal(details.querySelector('.chat-chart-bar'), null);
  assert.equal(details.querySelector('.chat-chart-graphic'), null);
  const canvas = content.querySelector('canvas'), accessible = canvas.getAttribute('aria-label');
  assert.equal(canvas.getAttribute('role'), 'img');
  assert.ok(accessible.includes('Requests'));
  for (const [index, series] of block.data.series.entries()) {
    const table = tables[index], headers = table.querySelectorAll('thead th');
    assert.ok(headers.length >= 2 && headers.every(header => header.getAttribute('scope') === 'col'));
    assert.ok(table.textContent.includes(series.label));
    const rows = table.querySelectorAll('tbody tr');
    assert.equal(rows.length, series.points.length, 'missing entries stay in their original positions');
    for (const [pointIndex, point] of series.points.entries()) {
      const row = rows[pointIndex];
      assert.equal(row.querySelector('th').getAttribute('scope'), 'row');
      assert.equal(row.querySelector('th').textContent, String(point.x));
      const value = row.querySelector('td.conversation-chart-value').textContent;
      if (point.y === null) assert.equal(value, 'chat.block.noValue');
      else assert.equal(config.options.plugins.tooltip.callbacks.label({ parsed: { y: point.y }, dataset: config.data.datasets[index] }), `${series.label}: ${value}`);
      assert.ok(accessible.includes(series.label));
      assert.ok(accessible.includes(value), `${series.label} ${pointIndex}: every formatted value is accessible`);
    }
  }
});

test('enhanced category charts omit disclosures while exposing all values and the reference to assistive technology', t => {
  const block = { id: 'channels', type: 'category_series', schemaVersion: 1, fallbackText: 'Channel data',
    data: { title: 'Channels', unit: 'req', points: [{ key: 'a', label: 'Web', value: -1234.5 },
      { key: 'b', label: 'API', value: null }, { key: 'c', label: 'Worker', value: 0 }], reference: { label: 'Target', value: 12 } } };
  const { content } = chartRoot(class { resize() {} destroy() {} }, block);
  t.after(() => content.destroy());
  const original = content.querySelector('.chat-chart-series'), baseline = content.querySelector('.chat-chart-baseline');
  content.mount(); content.mount();
  assert.equal(content.querySelector('details'), null);
  assert.equal(content.querySelector('.chat-chart-series'), original);
  assert.equal(content.querySelector('.chat-chart-baseline'), baseline);
  assert.equal(original.hidden, true); assert.equal(baseline.hidden, true);
  const canvas = content.querySelector('canvas'), accessible = canvas.getAttribute('aria-label');
  assert.equal(canvas.getAttribute('role'), 'img');
  for (const text of ['Channels', 'Web', '-1,234.5 req', 'API', 'chat.block.noValue', 'Worker', '0 req', 'Target', '12 req']) {
    assert.ok(accessible.includes(text), text);
  }
});

test('breakdown numeric tables contain values and shares and refresh with the existing chart locale', t => {
  const block = { id: 'budget', type: 'breakdown', schemaVersion: 1, fallbackText: 'Budget data', data: {
    title: 'Budget', unit: 'USD', parts: [{ key: 'a', label: 'Product', value: 1234.5 }, { key: 'b', label: 'Operations', value: 2 }]
  } };
  let creates = 0, updates = 0, instance;
  const { document, content } = chartRoot(class {
    constructor(canvas, config) { creates++; this.options = config.options; this.data = config.data; instance = this; }
    update() { updates++; } resize() {} destroy() {}
  }, block);
  t.after(() => content.destroy());
  for (const locale of ['en-US', 'de-DE']) {
    document.documentElement.lang = locale; content.mount(); content.mount();
    const details = content.querySelector('details.conversation-chart-data');
    assert.equal(content.querySelectorAll('details.conversation-chart-data').length, 1);
    const table = details.querySelector('table.conversation-chart-table');
    assert.equal(table.querySelectorAll('thead th').length, 3);
    assert.equal(details.querySelector('.chat-chart-bar'), null);
    const rows = table.querySelectorAll('tbody tr'), accessible = content.querySelector('canvas').getAttribute('aria-label');
    assert.equal(rows.length, 2);
    for (const [index, part] of block.data.parts.entries()) {
      const row = rows[index], value = row.querySelector('.conversation-chart-value').textContent;
      const share = row.querySelector('.conversation-chart-share').textContent;
      assert.equal(row.querySelector('th').textContent, part.label);
      assert.equal(instance.options.plugins.tooltip.callbacks.label({ parsed: { x: part.value }, dataset: instance.data.datasets[index] }), `${part.label}: ${value}`);
      assert.equal(share, new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(part.value / 1236.5));
      assert.ok(accessible.includes(value)); assert.ok(accessible.includes(share));
    }
    assert.equal(rows[0].querySelector('.conversation-chart-value').textContent, locale === 'en-US' ? '1,234.5 USD' : '1.234,5 USD');
  }
  assert.equal(creates, 1); assert.equal(updates, 1);
});

test('time table labels follow the tooltip instance zone and use UTC when their zone becomes unknown', async t => {
  const { setInstanceZone } = await import('../public/js/wb/instance-zone.js?v=100');
  setInstanceZone('Asia/Shanghai');
  t.after(() => setInstanceZone(null));
  const block = seriesBlock('datetime'), instant = '2026-11-01T16:30:00Z';
  block.data.series = [{ key: 'requests', label: 'Requests', points: [{ x: instant, y: 12 }] }];
  let zone = 'Asia/Shanghai', creates = 0, instance;
  const { content, document } = chartRoot(class {
    constructor(canvas, config) { creates++; this.options = config.options; this.data = config.data; instance = this; }
    update() {} resize() {} destroy() {}
  }, block, { chartTimeZone: () => zone });
  t.after(() => content.destroy());
  document.documentElement.lang = 'en-US';
  let previous;
  for (const nextZone of ['Asia/Shanghai', 'UTC', null]) {
    zone = nextZone; content.mount();
    const label = content.querySelector('details tbody th').textContent;
    const tooltip = instance.options.plugins.tooltip.callbacks.title([{ parsed: { x: Date.parse(instant) } }]);
    assert.equal(label, tooltip, 'table time uses the same zone and precision as the hovered point');
    assert.ok(content.querySelector('canvas').getAttribute('aria-label').includes(label));
    if (previous && nextZone !== null) assert.notEqual(label, previous, 'a zone refresh changes the data description');
    if (nextZone === null) {
      assert.equal(label, new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short',
        day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(Date.parse(instant)),
      'an unknown chart zone does not inherit the shared Dashboard zone');
    }
    previous = label;
  }
  assert.equal(creates, 1);
});

for (const type of ['time_series', 'breakdown']) test(`existing ${type} data headers refresh when the same language pack becomes available`, t => {
  const block = type === 'time_series' ? seriesBlock('datetime') : { id: 'budget', type: 'breakdown', schemaVersion: 1,
    fallbackText: 'Budget data', data: { title: 'Budget', parts: [{ key: 'a', label: 'Product', value: 30 }, { key: 'b', label: 'Operations', value: 70 }] } };
  delete block.data.xLabel;
  let ready = false, creates = 0, updates = 0;
  const labels = { 'chat.chart.category': 'Category', 'chat.chart.time': 'Time', 'chat.chart.value': 'Value',
    'chat.chart.share': 'Share', 'chat.chart.data': 'Chart data' };
  const translate = key => ready ? labels[key] ?? key : key;
  const { document, content } = chartRoot(class {
    constructor() { creates++; } update() { updates++; } resize() {} destroy() {}
  }, block, { t: translate });
  t.after(() => content.destroy());
  document.documentElement.lang = 'en-US'; content.mount();
  const originalDetails = content.querySelector('details');
  assert.equal(originalDetails.querySelector('thead th').textContent, type === 'time_series' ? 'chat.chart.time' : 'chat.chart.category');
  const originalValues = originalDetails.querySelectorAll('.conversation-chart-value').map(cell => cell.textContent);
  ready = true; content.mount(); content.mount();
  assert.equal(document.documentElement.lang, 'en-US');
  assert.equal(content.querySelector('details'), originalDetails);
  assert.equal(content.querySelectorAll('details').length, 1);
  for (const table of originalDetails.querySelectorAll('table')) {
    assert.deepEqual(table.querySelectorAll('thead th').map(cell => cell.textContent),
      type === 'time_series' ? ['Time', 'Value'] : ['Category', 'Value', 'Share']);
  }
  assert.deepEqual(originalDetails.querySelectorAll('.conversation-chart-value').map(cell => cell.textContent), originalValues);
  assert.equal(creates, 1); assert.equal(updates, 1);
});

test('breakdown update failure restores original fallback and a later mount recovers without duplicate disclosures', t => {
  const block = { id: 'budget', type: 'breakdown', schemaVersion: 1, fallbackText: 'Budget data', data: {
    title: 'Budget', unit: 'USD', parts: [{ key: 'a', label: 'Product', value: 30 }, { key: 'b', label: 'Operations', value: 70 }]
  } };
  let fail = false, creates = 0, destroys = 0;
  const { document, content } = chartRoot(class {
    constructor() { creates++; } update() { if (fail) throw new Error('Chart refresh unavailable'); }
    resize() {} destroy() { destroys++; }
  }, block);
  t.after(() => content.destroy());
  const original = content.querySelector('.chat-chart-series'), bars = original.querySelectorAll('.chat-chart-bar');
  document.documentElement.lang = 'en-US'; content.mount();
  assert.equal(original.hidden, true); assert.ok(content.querySelector('details'));
  fail = true; document.documentElement.lang = 'de-DE'; content.mount();
  assert.equal(content.querySelector('.conversation-chart-plot').hidden, true);
  assert.equal(content.querySelector('details'), null); assert.equal(content.querySelector('.conversation-chart-legend'), null);
  assert.equal(content.querySelector('.chat-chart-series'), original); assert.equal(original.hidden, false);
  assert.equal(original.querySelectorAll('.chat-chart-bar').length, bars.length);
  for (const bar of bars) assert.ok(allNodes(original).includes(bar), 'original static bars remain intact');
  assert.equal(content.querySelector('.conversation-chart-enhanced'), null); assert.equal(destroys, 1);
  fail = false; content.mount(); content.mount();
  assert.equal(content.querySelector('.conversation-chart-plot').hidden, false); assert.equal(original.hidden, true);
  assert.equal(content.querySelectorAll('details').length, 1); assert.equal(content.querySelectorAll('.conversation-chart-legend').length, 1);
  assert.equal(creates, 2); assert.equal(destroys, 1);
});

test('Chart.js initializes only after mount and repeated mounts resize without duplicates', () => {
  const calls = [];
  class Chart { constructor(canvas, config) { calls.push(['create', canvas, config]); } resize() { calls.push(['resize']); } destroy() { calls.push(['destroy']); } }
  const { content } = chartRoot(Chart);
  assert.equal(calls.length, 0); assert.ok(content.textContent.includes('4,200 req'));
  content.mount(); content.mount();
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'resize').length, 1);
  assert.equal(content.querySelector('.conversation-chart-plot').hidden, false);
  const details = content.querySelector('.conversation-chart-data');
  assert.equal(details.querySelectorAll('table').length, 2);
  assert.equal(details.querySelector('.chat-chart-bar'), null, 'enhanced data is a numeric table without fallback bars');
  assert.equal(details.querySelector('.chat-chart-graphic'), null);
  assert.ok(content.querySelectorAll('.chat-chart-series').every(section => section.hidden), 'original fallback is retained but hidden');
  assert.equal(content.querySelector('.chat-chart-axes').hidden, true, 'rendered charts omit the repeated axis description');
  content.destroy(); content.destroy(); content.mount();
  assert.equal(calls.filter(([kind]) => kind === 'destroy').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
});

test('missing Chart.js preserves readable static data without loading code', () => {
  const { content } = chartRoot(undefined); content.mount(); content.destroy();
  assert.equal(content.querySelector('.conversation-chart-plot').hidden, true);
  assert.ok(content.textContent.includes('RequestsTime · RequestsA')); assert.ok(content.textContent.includes('6,100 req'));
  assert.equal(content.querySelector('details'), null);
  assert.notEqual(content.querySelector('.chat-chart-axes').hidden, true, 'plain fallback keeps axis descriptions');
});

test('constructor failure disposes partial instance while retaining fallback', () => {
  let disposed = 0;
  class Chart { constructor() { throw new Error('Canvas unavailable'); } static getChart() { return { destroy() { disposed++; } }; } }
  const { content } = chartRoot(Chart); content.mount(); content.destroy(); content.destroy();
  assert.notEqual(content.querySelector('.chat-chart-axes').hidden, true, 'failed chart rendering keeps axis descriptions');
  assert.equal(disposed, 1); assert.equal(content.querySelector('.conversation-chart-plot').hidden, true);
  assert.ok(content.textContent.includes('4,200 req')); assert.equal(content.querySelector('details'), null);
});

for (const [name, labels, description] of [
  ['category title only', { xLabel: 'Channel' }, 'Channel'],
  ['numeric title only', { yLabel: 'Requests' }, 'Requests'],
  ['both axis titles', { xLabel: 'Channel', yLabel: 'Requests' }, 'Channel · Requests']
]) test(`enhanced category charts retain the category description with ${name}`, t => {
  const block = { id: 'channels', type: 'category_series', schemaVersion: 1, fallbackText: 'Channel data',
    data: { ...labels, points: [{ key: 'web', label: 'Web', value: 10 }] } };
  const { content } = chartRoot(class { resize() {} destroy() {} }, block);
  t.after(() => content.destroy());
  const axes = content.querySelector('.chat-chart-axes');
  assert.equal(axes.textContent, description, 'the unenhanced fallback retains every axis title');
  content.mount();
  assert.equal(content.querySelector('.conversation-chart-plot').hidden, false);
  assert.equal(content.querySelector('details'), null, 'category direct values need no duplicate data disclosure');
  assert.ok(content.querySelectorAll('.chat-chart-series').every(section => section.hidden));
  assert.equal(axes.textContent, labels.xLabel ?? '');
  assert.equal(axes.hidden, !labels.xLabel, 'only the repeated numeric title is omitted');
});

test('a resize failure after a successful render restores the static axis description and data', t => {
  let disposed = 0;
  class Chart { resize() { throw new Error('Canvas resize unavailable'); } destroy() { disposed++; } }
  const { content } = chartRoot(Chart);
  t.after(() => content.destroy());
  const axes = content.querySelector('.chat-chart-axes');
  content.mount();
  assert.equal(axes.hidden, true);
  assert.equal(content.querySelector('.conversation-chart-plot').hidden, false);
  content.mount();
  assert.equal(axes.hidden, false);
  assert.equal(axes.textContent, 'Time · Requests');
  assert.equal(content.querySelector('.conversation-chart-plot').hidden, true);
  assert.equal(content.querySelector('details'), null);
  assert.equal(content.querySelectorAll('table').length, 2);
  assert.ok(content.querySelectorAll('.chat-chart-series').every(section => !section.hidden), 'complete fallback is restored');
  assert.ok(content.textContent.includes('4,200 req'));
  assert.equal(disposed, 1);
});

test('a category chart update failure restores both original axis titles', t => {
  let disposed = 0;
  class Chart { resize() {} update() { throw new Error('Canvas update unavailable'); } destroy() { disposed++; } }
  const block = { id: 'channels', type: 'category_series', schemaVersion: 1, fallbackText: 'Channel data',
    data: { xLabel: 'Channel', yLabel: 'Requests', points: [{ key: 'web', label: 'Web', value: 10 }] } };
  const { document, content } = chartRoot(Chart, block);
  t.after(() => content.destroy());
  const axes = content.querySelector('.chat-chart-axes');
  document.documentElement.lang = 'en'; content.mount();
  assert.equal(axes.textContent, 'Channel'); assert.equal(axes.hidden, false);
  document.documentElement.lang = 'zh'; content.mount();
  assert.equal(axes.textContent, 'Channel · Requests'); assert.equal(axes.hidden, false);
  assert.equal(content.querySelector('.conversation-chart-plot').hidden, true);
  assert.equal(content.querySelector('details'), null);
  assert.equal(content.querySelectorAll('table').length, 1);
  assert.ok(content.querySelectorAll('.chat-chart-series').every(section => !section.hidden));
  assert.equal(disposed, 1);
});

test('detached resources defer initialization and teardown survives a throwing Chart destroy', () => {
  const document = createDocument(), fallback = document.createElement('figure');
  const table = document.createElement('div'); table.className = 'chat-chart-series'; fallback.append(table);
  let creates = 0;
  document.defaultView = { Chart: class { constructor() { creates++; } resize() {} destroy() { throw new Error('already gone'); } } };
  const resource = conversationChartResource({ document, block: seriesBlock(), fallback, t });
  const canvas = fallback.querySelector('canvas'); canvas.isConnected = false; resource.mount(); assert.equal(creates, 0);
  canvas.isConnected = true; resource.mount(); assert.equal(creates, 1);
  assert.doesNotThrow(() => resource.destroy()); resource.destroy();
});

test('theme and language changes update the existing chart without recreating it', () => {
  const calls = [];
  class Chart {
    constructor(canvas, config) { this.options = config.options; calls.push(['create', this]); }
    resize() { calls.push(['resize']); }
    update(mode) { calls.push(['update', mode, this.options]); }
    destroy() { calls.push(['destroy']); }
  }
  const { document, content } = chartRoot(Chart);
  let text = '#123456';
  document.defaultView.getComputedStyle = () => ({ getPropertyValue: key => key === '--text-dim' ? text : '#aaaaaa' });
  document.documentElement.lang = 'en'; content.mount(); content.mount();
  assert.equal(calls.filter(([kind]) => kind === 'update').length, 0);
  text = '#abcdef'; document.documentElement.lang = 'zh'; content.mount();
  const updates = calls.filter(([kind]) => kind === 'update');
  assert.equal(updates.length, 1); assert.equal(updates[0][1], 'none');
  assert.equal(updates[0][2].scales.x.ticks.color, '#abcdef'); assert.equal(updates[0][2].locale, 'zh');
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
  content.destroy();
});

test('a Chart.js instance with no canvas context leaves the complete static chart visible', () => {
  let disposed = 0;
  class Chart { constructor() { this.ctx = null; } destroy() { disposed++; } }
  const { content } = chartRoot(Chart); content.mount(); content.destroy();
  assert.equal(disposed, 1); assert.equal(content.querySelector('.conversation-chart-plot').hidden, true);
  assert.equal(content.querySelectorAll('table').length, 2); assert.equal(content.querySelector('details'), null);
});

test('percentage lines retain the full comparison range and quarter-grid ticks', () => {
  const block = seriesBlock('number'); block.data.yUnit = '%';
  block.data.series = [{ key: 'hit', label: 'Hit rate', points: [{ x: 0, y: 61 }, { x: 30, y: 90 }] }];
  const units = conversationChartConfig(block);
  assert.equal(units.options.scales.y.beginAtZero, true);
  assert.equal(units.options.scales.y.suggestedMax, 100);
  assert.equal(units.options.scales.y.ticks.stepSize, 25);
  assert.equal(units.options.scales.y.ticks.callback(75), '75 %');
  assert.equal(units.data.datasets[0].data[1].y, 90);
  delete block.data.yUnit; block.data.format = { style: 'percent' };
  block.data.series[0].points = [{ x: 0, y: 0.61 }, { x: 30, y: 0.9 }];
  const ratios = conversationChartConfig(block);
  assert.equal(ratios.options.scales.y.suggestedMax, 1);
  assert.equal(ratios.options.scales.y.ticks.stepSize, 0.25);
  assert.equal(ratios.options.scales.y.ticks.callback(0.75), '75%');
  assert.equal(ratios.data.datasets[0].data[1].y, 0.9);
  delete block.data.format;
  const ordinary = conversationChartConfig(block);
  assert.equal(ordinary.options.scales.y.suggestedMax, undefined);
  assert.equal(ordinary.options.scales.y.ticks.stepSize, undefined);
});

test('same-unit percentage comparisons remain separate bars without adding their values', () => {
  const block = seriesBlock(); block.data.yUnit = '%';
  block.data.series = [
    { key: 'first', label: 'First', points: [{ x: 'hit', y: 87 }] },
    { key: 'second', label: 'Second', points: [{ x: 'hit', y: 90 }] }
  ];
  const config = conversationChartConfig(block);
  assert.equal(config.type, 'bar');
  assert.equal(config.options.scales.x.stacked, false);
  assert.equal(config.options.scales.y.stacked, false);
  assert.equal(config.data.datasets.length, 2);
  assert.equal(config.data.datasets[0].data[0], 87);
  assert.equal(config.data.datasets[1].data[0], 90);
  assert.equal(config.options.scales.y.suggestedMax, 100);
  assert.equal(config.options.scales.y.ticks.stepSize, 25);
  assert.equal(config.options.plugins.legend.display, true);
  assert.equal(config.options.plugins.legend.onClick, null);
});

test('chart legends are noninteractive labels while breakdown alone remains stacked', () => {
  const cases = [seriesBlock(), seriesBlock('number'),
    { type: 'category_series', data: { points: [{ label: 'A', value: 1 }], reference: { label: 'Target', value: 1 } } },
    { type: 'breakdown', data: { parts: [{ label: 'A', value: 30 }, { label: 'B', value: 70 }] } }];
  for (const block of cases) {
    const config = conversationChartConfig(block);
    assert.equal(config.options.plugins.legend.onClick, null);
    assert.equal(config.options.plugins.legend.onHover, undefined);
    assert.equal(config.options.plugins.legend.onLeave, undefined);
  }
  const breakdown = conversationChartConfig(cases[3]);
  assert.equal(breakdown.options.scales.x.stacked, true);
  assert.equal(breakdown.options.scales.y.stacked, true);
});
