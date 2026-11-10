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
  const config = conversationChartConfig({ type: 'category_series', data: { title: 'Change', unit: 'USD',
    points: [{ label: 'A', value: -5 }, { label: 'B', value: null }], reference: { label: 'Target', value: 1 } } });
  assert.equal(config.options.indexAxis, 'y'); assert.equal(config.data.datasets[0].data[0], -5);
  assert.equal(config.data.datasets[0].data[1], null); assert.equal(config.data.datasets[1].label, 'Target');
  assert.equal(config.data.datasets[1].data[1].x, 1); assert.equal(config.data.datasets[1].data[1].y, 1);
});

test('breakdown uses one nonnegative stack with part legends and value formatting', () => {
  const config = conversationChartConfig({ type: 'breakdown', data: { title: 'Budget', format: { style: 'percent' },
    parts: [{ label: 'A', value: 0.3 }, { label: 'B', value: 0.7 }] } });
  assert.equal(config.options.indexAxis, 'y'); assert.equal(config.options.scales.x.stacked, true);
  assert.equal(config.data.datasets.length, 2); assert.equal(config.data.datasets[1].label, 'B');
  assert.equal(config.options.scales.x.display, false);
  assert.equal(config.options.plugins.conversationValues.format(0.3), '30%');
});

function chartRoot(Chart) {
  const document = createDocument(); document.defaultView = { Chart };
  const envelope = { version: 1, kind: 'message', messageId: 'chart-message', fallbackText: 'Traffic', blocks: [seriesBlock()] };
  const content = renderConversationContent({ document, row: row(envelope), t });
  return { document, content };
}

test('Chart.js initializes only after mount and repeated mounts resize without duplicates', () => {
  const calls = [];
  class Chart { constructor(canvas, config) { calls.push(['create', canvas, config]); } resize() { calls.push(['resize']); } destroy() { calls.push(['destroy']); } }
  const { content } = chartRoot(Chart);
  assert.equal(calls.length, 0); assert.ok(content.textContent.includes('4,200 req'));
  content.mount(); content.mount();
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'resize').length, 1);
  assert.equal(content.querySelector('.conversation-chart-plot').hidden, false);
  assert.equal(content.querySelector('.conversation-chart-data').querySelectorAll('table').length, 2);
  content.destroy(); content.destroy(); content.mount();
  assert.equal(calls.filter(([kind]) => kind === 'destroy').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
});

test('missing Chart.js preserves readable static data without loading code', () => {
  const { content } = chartRoot(undefined); content.mount(); content.destroy();
  assert.equal(content.querySelector('.conversation-chart-plot').hidden, true);
  assert.ok(content.textContent.includes('RequestsTime · RequestsA')); assert.ok(content.textContent.includes('6,100 req'));
  assert.equal(content.querySelector('details'), null);
});

test('constructor failure disposes partial instance while retaining fallback', () => {
  let disposed = 0;
  class Chart { constructor() { throw new Error('Canvas unavailable'); } static getChart() { return { destroy() { disposed++; } }; } }
  const { content } = chartRoot(Chart); content.mount(); content.destroy(); content.destroy();
  assert.equal(disposed, 1); assert.equal(content.querySelector('.conversation-chart-plot').hidden, true);
  assert.ok(content.textContent.includes('4,200 req')); assert.equal(content.querySelector('details'), null);
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
