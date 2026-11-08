import test from 'node:test';
import assert from 'node:assert/strict';
import { Chart, registerables } from 'chart.js';
import 'chartjs-adapter-date-fns';
import { conversationChartConfig } from '../public/js/wb/conversation-charts.js';

Chart.register(...registerables);

// Chart.js lays out ticks without a DOM through its basic platform; a 2d context stub only has to measure
// text (6px per character) and swallow drawing calls.
function canvas(width, height = 260) {
  const target = { measureText: text => ({ width: String(text).length * 6 }) };
  const context = new Proxy(target, {
    get: (object, key) => key in object ? object[key] : typeof key === 'string' ? () => ({ addColorStop() {} }) : undefined,
    set: (object, key, value) => { object[key] = value; return true; }
  });
  const element = { width, height, style: {}, getContext: () => context };
  target.canvas = element;
  return element;
}

const days = count => Array.from({ length: count }, (_, index) =>
  new Date(Date.UTC(2026, 10, 2 + index)).toISOString().slice(0, 10));
const hours = count => Array.from({ length: count }, (_, index) =>
  new Date(Date.UTC(2026, 10, 2, index)).toISOString());
const block = (xType, xs) => ({ id: 'usage', type: 'time_series', schemaVersion: 1, fallbackText: 'Usage table',
  data: { xType, title: 'Usage', series: [{ key: 'a', label: 'A', points: xs.map((x, index) => ({ x, y: 10 + index })) },
    { key: 'b', label: 'B', points: xs.map((x, index) => ({ x, y: 5 + index })) }] } });

function render(config, width) {
  config.options.responsive = false; config.options.devicePixelRatio = 1;
  const chart = new Chart(canvas(width), config);
  const x = chart.scales.x;
  const result = { unit: x._unit, labels: x.getLabelItems().map(item => item.label), values: x.ticks.map(tick => tick.value),
    left: x.left, right: x.right, pixels: chart.getDatasetMeta(0).data.map(point => point.x) };
  chart.destroy();
  return result;
}
// Local midnight of each listed date, the same reading the date adapter gives date-only strings.
const midnights = xs => new Set(xs.map(x => new Date(`${x}T00:00:00`).getTime()));
const zhDay = /^\d{1,2}月\d{1,2}日$/, enDay = /^[A-Z][a-z]{2} \d{1,2}$/;

for (const [count, width] of [[1, 900], [7, 900], [7, 330], [31, 900], [31, 330]]) {
  test(`daily data with ${count} point(s) at ${width}px ticks only on its own dates in the page language`, () => {
    const xs = days(count), dates = midnights(xs);
    for (const [locale, pattern] of [['zh-CN', zhDay], ['en', enDay]]) {
      const axis = render(conversationChartConfig(block('date', xs), { locale }), width);
      assert.equal(axis.unit, 'day');
      assert.ok(axis.labels.length >= 1 && axis.labels.length <= count, `${axis.labels.length} ticks for ${count} days`);
      assert.equal(new Set(axis.labels).size, axis.labels.length, 'no repeated date label');
      for (const value of axis.values) assert.ok(dates.has(value), `tick ${new Date(value).toISOString()} is not one of the dates`);
      for (const label of axis.labels) assert.match(label, pattern);
      for (const pixel of axis.pixels) assert.ok(pixel > axis.left && pixel < axis.right, 'point sits inside the plot');
      if (count <= 7 && width === 900) assert.equal(axis.labels.length, count, 'every day is labelled when there is room');
    }
  });
}

test('a single day is centred and labelled with its date', () => {
  const axis = render(conversationChartConfig(block('date', ['2026-11-02']), { locale: 'zh-CN' }), 900);
  assert.deepEqual(axis.labels, ['11月2日']);
  assert.ok(Math.abs(axis.pixels[0] - (axis.left + axis.right) / 2) < 1, `point at ${axis.pixels[0]} in ${axis.left}..${axis.right}`);
});

test('daily tooltip titles show the date without a clock time', () => {
  const at = new Date('2026-11-02T00:00:00').getTime();
  const zh = conversationChartConfig(block('date', days(7)), { locale: 'zh-CN' }).options.plugins.tooltip.callbacks;
  const en = conversationChartConfig(block('date', days(7)), { locale: 'en' }).options.plugins.tooltip.callbacks;
  assert.equal(zh.title([{ parsed: { x: at } }]), '2026年11月2日');
  assert.equal(en.title([{ parsed: { x: at } }]), 'Nov 2, 2026');
});

test('hourly data keeps the automatic time axis and default tooltip', () => {
  const config = conversationChartConfig(block('datetime', hours(12)), { locale: 'en' });
  assert.equal(config.options.scales.x.type, 'time');
  assert.equal(config.options.scales.x.time, undefined);
  assert.equal(config.options.scales.x.ticks.source, undefined);
  assert.equal(config.options.scales.x.ticks.callback, undefined);
  assert.equal(config.options.scales.x.afterDataLimits, undefined);
  assert.equal(config.options.plugins.tooltip.callbacks.title, undefined);
  const axis = render(config, 900);
  assert.ok(['hour', 'minute'].includes(axis.unit), `unit ${axis.unit}`);
  assert.ok(axis.labels.length > 1);
  for (const label of axis.labels) assert.match(label, /^\d{1,2}(:\d\d)?\s?[ap]\.?m\.?$/i);
});
