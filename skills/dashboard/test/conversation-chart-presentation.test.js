import test from 'node:test';
import assert from 'node:assert/strict';
import { Chart, registerables } from 'chart.js';
import { conversationChartConfig, conversationChartResource } from '../public/js/wb/conversation-charts.js';
import { createDocument } from './helpers/conversation-dom.js';

Chart.register(...registerables);

// Real Chart.js layout and drawing, with a bounded recorder in place of browser pixels.
// No filesystem, network, PM2, tmux or database operations.
function render(t, block, { width = 700, height = 260, ...palette } = {}) {
  const labels = [], gradients = [], lines = [];
  let from;
  const target = { moveTo(x, y) { from = [x, y]; }, lineTo(x, y) { if (lines.length < 2000) lines.push({ from, to: [x, y], color: target.strokeStyle }); }, measureText: text => ({ width: String(text).length * 6 }),
    fillText(text, x, y) { if (labels.length < 1000) labels.push({ text: String(text), x, y, color: target.fillStyle, align: target.textAlign }); },
    createLinearGradient() { const stops = []; gradients.push(stops); return { addColorStop(offset, color) { stops.push([offset, color]); } }; } };
  const ctx = new Proxy(target, { get: (object, key) => key in object ? object[key] : typeof key === 'string' ? () => {} : undefined,
    set: (object, key, value) => { object[key] = value; return true; } });
  const canvas = { width, height, style: {}, getContext: () => ctx }; target.canvas = canvas;
  const config = conversationChartConfig(block, { locale: 'en-US', ...palette });
  config.options.responsive = false; config.options.devicePixelRatio = 1;
  const chart = new Chart(canvas, config);
  t.after(() => chart.destroy());
  return { chart, config, labels, gradients, lines };
}
const line = values => ({ type: 'time_series', data: { title: 'Traffic', xType: 'number', yUnit: 'req',
  series: [{ label: 'Requests', points: values.map((y, x) => ({ x, y })) }] } });
const category = points => ({ type: 'category_series', data: { title: 'Channels', unit: 'req', points } });
const breakdown = values => ({ type: 'breakdown', data: { title: 'Budget', unit: 'USD',
  parts: values.map((value, index) => ({ label: `Part ${index + 1}`, value })) } });

test('line chart uses monotone interpolation, sparse markers and a fading area for one series', t => {
  const { chart, config, gradients } = render(t, line([2, 3, null, 9, null, 4, 8, null]));
  const dataset = config.data.datasets[0], points = chart.getDatasetMeta(0).data;
  assert.equal(dataset.cubicInterpolationMode, 'monotone');
  assert.equal(dataset.spanGaps, false); assert.equal(dataset.fill, 'origin');
  assert.deepEqual(points.map(point => point.options.radius), [0, 0, 0, 3.5, 0, 0, 3.5, 0]);
  assert.ok(gradients.some(stops => stops.length === 2 && stops[0][0] === 0 && stops[0][1] === '#35a99838' && stops[1][0] === 1 && stops[1][1] === '#35a99800'));
  assert.equal(config.options.interaction.mode, 'index'); assert.equal(config.options.interaction.intersect, false);
  assert.equal(config.options.plugins.tooltip.backgroundColor, '#101827');
  assert.equal(config.options.plugins.tooltip.bodyColor, '#f7faf9');
});

test('hover draws an index crosshair through the plot and enlarges the point', t => {
  const { chart, lines } = render(t, line([2, 8, 3]));
  const point = chart.getDatasetMeta(0).data[1];
  chart.tooltip.setActiveElements([{ datasetIndex: 0, index: 1 }], { x: point.x, y: point.y });
  chart.setActiveElements([{ datasetIndex: 0, index: 1 }]);
  lines.length = 0; chart.draw();
  const x = Math.round(point.x) + 0.5;
  assert.ok(lines.some(segment => segment.color === '#7a879473' && segment.from?.[0] === x && segment.from?.[1] === chart.chartArea.top &&
    segment.to[0] === x && segment.to[1] === chart.chartArea.bottom));
  assert.equal(point.options.radius, 5);
});

test('line labels use the last nonnull value including zero and reserve measured space', t => {
  const { chart, labels } = render(t, line([8, 0, null]));
  assert.ok(labels.some(label => label.text === '0 req' && label.x > chart.getDatasetMeta(0).data[1].x));
  assert.ok(chart.options.layout.padding.right >= '0 req'.length * 6 + 14);
  assert.equal(labels.some(label => label.text === '8 req' && label.color === '#101827'), false, 'interior values have no direct labels');
});

test('all-null lines draw no value labels and several series do not fill', t => {
  const block = line([null, null]);
  block.data.series.push({ label: 'Second', points: [{ x: 0, y: 3 }, { x: 1, y: 7 }] });
  const { config, labels } = render(t, block);
  assert.equal(config.data.datasets[0].fill, false); assert.equal(config.data.datasets[1].fill, false);
  assert.equal(labels.filter(label => label.text === '7 req').length, 1);
  assert.equal(labels.some(label => label.text === 'null req'), false);
});

test('category bars use assessment colors and direct signed or missing values without numeric axes', t => {
  const block = category([
    { label: 'critical', value: 10, assessment: { status: 'critical' } },
    { label: 'negative', value: -3, assessment: { status: 'negative' } },
    { label: 'warning', value: 8, assessment: { status: 'warning' } },
    { label: 'normal', value: 0 }, { label: 'missing', value: null }
  ]);
  block.data.reference = { label: 'Target', value: 12 };
  const { chart, config, labels } = render(t, block, { noValue: 'No data' });
  assert.deepEqual(config.data.datasets[0].backgroundColor, ['#e06b83', '#e06b83', '#e1a33d', '#35a998', '#35a998']);
  assert.deepEqual(chart.getDatasetMeta(0).data.map(bar => bar.options.backgroundColor), ['#e06b83', '#e06b83', '#e1a33d', '#35a998', '#35a998']);
  assert.equal(chart.scales.x.options.display, false); assert.equal(chart.scales.x.options.ticks.display, false);
  assert.equal(chart.scales.x.options.grid.display, false); assert.equal(chart.scales.x.options.border.display, false);
  assert.equal(config.options.plugins.legend.display, false);
  for (const text of ['10 req', '-3 req', '8 req', '0 req', 'No data', 'Target 12 req']) assert.ok(labels.some(label => label.text === text), text);
  const negative = labels.find(label => label.text === '-3 req');
  assert.equal(negative.align, 'right'); assert.ok(negative.x < chart.getDatasetMeta(0).data[1].x);
  assert.ok(negative.x - '-3 req'.length * 6 >= 0, 'negative direct value stays inside the canvas');
  assert.equal(chart.getDatasetMeta(0).data[0].options.borderRadius, 4);
  assert.ok(chart.getDatasetMeta(0).data[0].height <= 20);
  assert.equal(config.options.plugins.tooltip.filter({ dataset: config.data.datasets[1] }), false);
});

test('category labels retain an axis title while all numeric ticks stay hidden', t => {
  const block = category([{ label: 'A', value: 10 }]); block.data.xLabel = 'Requests';
  const { chart } = render(t, block);
  assert.equal(chart.scales.x.options.display, true);
  assert.equal(chart.scales.x.options.title.text, 'Requests');
  assert.equal(chart.scales.x.options.ticks.display, false);
});

test('breakdown ends at the exact total, writes fitting shares and omits narrow shares', t => {
  const { chart, config, labels } = render(t, breakdown([64, 35, 1]));
  assert.equal(chart.scales.x.max, 100);
  assert.equal(chart.scales.x.options.display, false); assert.equal(chart.scales.y.options.display, false);
  assert.equal(config.options.plugins.legend.display, false);
  assert.ok(labels.some(label => label.text === '64%')); assert.ok(labels.some(label => label.text === '35%'));
  assert.equal(labels.some(label => label.text === '1%'), false);
  assert.equal(chart.getDatasetMeta(0).data[0].height, 24);
  assert.equal(config.data.datasets[0].borderRadius, 6);
  assert.ok(labels.find(label => label.text === '64%').color === '#0b1220');
});

test('breakdown zero total draws no shares and its sixth color differs from the first', t => {
  const { labels } = render(t, breakdown([0, 0]));
  assert.equal(labels.some(label => label.text.endsWith('%')), false);
  const config = conversationChartConfig(breakdown([1, 1, 1, 1, 1, 1, 1]));
  assert.equal(new Set(config.data.datasets.slice(0, 6).map(dataset => dataset.backgroundColor)).size, 6);
  assert.equal(config.data.datasets[6].backgroundColor, config.data.datasets[0].backgroundColor);
});

test('real Chart updates value label presentation when theme and language change', t => {
  const { chart, labels } = render(t, line([1.5]), { strong: '#123456' });
  assert.ok(labels.some(label => label.text === '1.5 req' && label.color === '#123456'));
  const next = conversationChartConfig(line([1.5]), { locale: 'de-DE', strong: '#abcdef' });
  next.options.responsive = false; next.options.devicePixelRatio = 1;
  chart.options = next.options; chart.data = next.data; labels.length = 0; chart.update('none');
  assert.ok(labels.some(label => label.text === '1,5 req' && label.color === '#abcdef'));
});

test('resource creates one HTML breakdown legend and updates its formatted values', () => {
  const document = createDocument(), fallback = document.createElement('figure');
  const source = document.createElement('div'); source.className = 'chat-chart-series'; fallback.append(source);
  let creates = 0, destroys = 0;
  document.defaultView = { Chart: class { constructor() { creates++; } resize() {} update() {} destroy() { destroys++; } } };
  const resource = conversationChartResource({ document, fallback, block: breakdown([1234.5, 2]) });
  document.documentElement.lang = 'en-US'; resource.mount(); resource.mount();
  assert.equal(creates, 1); assert.equal(fallback.querySelectorAll('.conversation-chart-legend').length, 1);
  assert.equal(fallback.querySelector('.conversation-chart-legend-value').textContent, '1,234.5 USD');
  document.documentElement.lang = 'de-DE'; resource.mount();
  assert.equal(fallback.querySelectorAll('.conversation-chart-legend').length, 1);
  assert.equal(fallback.querySelector('.conversation-chart-legend-value').textContent, '1.234,5 USD');
  resource.destroy(); assert.equal(destroys, 1);
});

test('category resource height follows row count and reference label space', () => {
  for (const count of [1, 2, 20]) {
    const document = createDocument(), fallback = document.createElement('figure');
    const block = category(Array.from({ length: count }, (_, index) => ({ label: String(index), value: index })));
    block.data.reference = { label: 'Target', value: 1 };
    const resource = conversationChartResource({ document, fallback, block });
    assert.equal(fallback.querySelector('.conversation-chart-plot').style['--chat-plot-h'], `${count * 34 + 18}px`);
    resource.destroy();
  }
});
