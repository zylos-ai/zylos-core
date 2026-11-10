import test from 'node:test';
import assert from 'node:assert/strict';
import { Chart, registerables } from 'chart.js';
import 'chartjs-adapter-date-fns';
import { chartDay, conversationChartConfig } from '../public/js/wb/conversation-charts.js';

Chart.register(...registerables);

const durationBlock = values => ({ type: 'time_series', data: { xType: 'number', format: { style: 'duration' },
  series: [{ label: 'Duration', points: values.map((y, x) => ({ x, y })) }] } });

function numericAxis(config, width, name = 'y') {
  config.options.responsive = false; config.options.devicePixelRatio = 1;
  const chart = new Chart(canvas(width), config);
  try {
    const scale = chart.scales[name];
    return { values: scale.ticks.map(tick => tick.value), labels: scale.ticks.map(tick => tick.label) };
  } finally { chart.destroy(); }
}

test('duration axes generate whole half-hour ticks at desktop and mobile widths', () => {
  for (const width of [900, 330]) {
    const axis = numericAxis(conversationChartConfig(durationBlock([59, 3600, 5400]), { locale: 'en' }), width);
    assert.deepEqual(axis.values, [0, 1800, 3600, 5400], `${width}px`);
    assert.deepEqual(axis.labels, ['0s', '30m', '1h', '1h 30m'], `${width}px`);
  }
});

test('duration axes choose whole seconds, minutes and hours for their data range', () => {
  for (const [values, expected] of [
    [[1, 3], [0, 1, 2, 3]], [[0, 0.5], [0, 1]], [[0, 59], [0, 15, 30, 45, 60]],
    [[0, 600], [0, 300, 600]], [[0, 7200], [0, 1800, 3600, 5400, 7200]],
    [[0, 28800], [0, 7200, 14400, 21600, 28800]],
    [[-59, 59], [-60, -30, 0, 30, 60]], [[0, 0], [0, 1]]
  ]) {
    const axis = numericAxis(conversationChartConfig(durationBlock(values), { locale: 'en' }), 900);
    assert.deepEqual(axis.values, expected, String(values));
  }
});

test('duration values retain their units on direct labels and separate unit axes', () => {
  const category = { type: 'category_series', data: { format: { style: 'duration' },
    points: [59, 3600, 5400].map(value => ({ label: String(value), value })) } };
  const breakdown = { type: 'breakdown', data: { format: { style: 'duration' },
    parts: [{ label: 'First', value: 1800 }, { label: 'Second', value: 3600 }] } };
  for (const block of [category, breakdown]) {
    const config = conversationChartConfig(block, { locale: 'en' });
    assert.equal(config.options.scales.x.display, false);
    assert.equal(config.options.plugins.conversationValues.format(5400), '1h 30m');
  }
  const block = durationBlock([59, 3600, 5400]);
  block.data.series[0].unit = 'first';
  block.data.series.push({ label: 'Second', unit: 'second', points: [{ x: 0, y: 30 }, { x: 1, y: 60 }] });
  const config = conversationChartConfig(block, { locale: 'en' });
  assert.deepEqual(config.data.datasets[0].data, [{ x: 0, y: 59 }, { x: 1, y: 3600 }, { x: 2, y: 5400 }]);
  assert.deepEqual(numericAxis(config, 900, 'y1').values, [0, 15, 30, 45, 60]);
});

test('ordinary numeric axes use sparse ticks while percent axes retain quarter steps', () => {
  const ordinary = durationBlock([59, 3600, 5400]);
  delete ordinary.data.format;
  const normal = conversationChartConfig(ordinary, { locale: 'en' });
  assert.equal(normal.options.scales.y.afterDataLimits, undefined);
  assert.deepEqual(numericAxis(normal, 900).values, [0, 2000, 4000, 6000]);
  const percent = durationBlock([0, 0.5, 1]);
  percent.data.format.style = 'percent';
  const config = conversationChartConfig(percent, { locale: 'en' });
  assert.equal(config.options.scales.y.afterDataLimits, undefined);
  assert.deepEqual(numericAxis(config, 900).values, [0, 0.25, 0.5, 0.75, 1]);
});

test('duration axis and tooltip preserve fractional seconds with the default precision', () => {
  const config = conversationChartConfig(durationBlock([90.5]), { locale: 'en' });
  assert.equal(config.options.scales.y.ticks.callback(90.5), '1m 30.5s');
  assert.equal(config.options.plugins.tooltip.callbacks.label({ parsed: { y: 90.5 }, dataset: config.data.datasets[0] }),
    'Duration: 1m 30.5s');
});

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

const zhYearDay = /^\d{4}年\d{1,2}月\d{1,2}日$/, enYearDay = /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/;
const months = count => Array.from({ length: count }, (_, index) =>
  new Date(Date.UTC(2025, index, 1)).toISOString().slice(0, 10));

test('daily data across years names the year so the same day of different years is never repeated', () => {
  const cases = [['2024-11-02', '2025-11-02', '2026-11-02'],
    ['2025-12-27', '2025-12-28', '2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02'], months(24)];
  for (const xs of cases) {
    const dates = midnights(xs);
    for (const [locale, pattern] of [['zh-CN', zhYearDay], ['en', enYearDay]]) {
      for (const width of [900, 330]) {
        const axis = render(conversationChartConfig(block('date', xs), { locale }), width);
        assert.ok(axis.labels.length >= 1, `${xs[0]}..: no tick`);
        assert.equal(new Set(axis.labels).size, axis.labels.length, `${xs[0]}.. ${locale} ${width}px: repeated date label`);
        for (const value of axis.values) assert.ok(dates.has(value), `tick ${new Date(value).toISOString()} is not one of the dates`);
        for (const label of axis.labels) assert.match(label, pattern);
      }
    }
  }
  const sameDay = render(conversationChartConfig(block('date', ['2024-11-02', '2025-11-02', '2026-11-02']), { locale: 'zh-CN' }), 900);
  assert.deepEqual(sameDay.labels, ['2024年11月2日', '2025年11月2日', '2026年11月2日']);
});

test('daily data within one year leaves the year out of the tick labels', () => {
  const axis = render(conversationChartConfig(block('date', ['2026-01-01', '2026-06-30', '2026-12-31']), { locale: 'en' }), 900);
  assert.deepEqual(axis.labels, ['Jan 1', 'Jun 30', 'Dec 31']);
});

test('weekly points tick exactly on their own dates, not on the days between them', () => {
  const xs = ['2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'];
  const axis = render(conversationChartConfig(block('date', xs), { locale: 'zh-CN' }), 900);
  assert.deepEqual(axis.values, [...midnights(xs)]);
  assert.deepEqual(axis.labels, ['10月12日', '10月19日', '10月26日', '11月2日']);
});

test('date tick labels use the page text colour', () => {
  const config = conversationChartConfig(block('date', days(7)), { locale: 'en', text: '#123456', grid: '#abcdef' });
  assert.equal(config.options.scales.x.ticks.color, '#123456');
  assert.equal(config.options.scales.x.grid.display, false);
});

test('without an instance time zone a daily point keeps its calendar day west and east of UTC', t => {
  const saved = process.env.TZ;
  t.after(() => { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; });
  const day = (y, m, d) => [y, m, d];
  for (const zone of ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
    process.env.TZ = zone;
    for (const value of ['2026-11-02', '2026-11-02T00:00:00Z', '2026-11-02T23:30:00', Date.UTC(2026, 10, 2), Date.UTC(2026, 10, 2, 23, 59)]) {
      const local = new Date(chartDay(value));
      assert.deepEqual(day(local.getFullYear(), local.getMonth() + 1, local.getDate()), [2026, 11, 2], `${zone} ${value}`);
      assert.deepEqual([local.getHours(), local.getMinutes()], [0, 0], `${zone} ${value} is local midnight`);
    }
    const xs = ['2026-11-02T00:00:00Z', Date.UTC(2026, 10, 3), '2026-11-04'];
    const config = conversationChartConfig(block('date', xs), { locale: 'zh-CN' });
    const axis = render(config, 900);
    assert.deepEqual(axis.labels, ['11月2日', '11月3日', '11月4日'], zone);
    const first = config.data.datasets[0].data[0].x;
    assert.equal(config.options.plugins.tooltip.callbacks.title([{ parsed: { x: first } }]), '2026年11月2日', zone);
  }
});

// One set of points, each naming an instant or a written date, and the day it falls on in each instance time zone.
// 2026-11-01T16:00Z is midnight of 2 November in Shanghai and 1 November in Los Angeles (PST after 1 November).
const ZONED = [
  [Date.UTC(2026, 10, 1, 16), { 'Asia/Shanghai': 2, 'America/Los_Angeles': 1, UTC: 1 }],
  [Date.UTC(2026, 10, 2, 7, 30), { 'Asia/Shanghai': 2, 'America/Los_Angeles': 1, UTC: 2 }],
  [Date.UTC(2026, 10, 2, 23, 30), { 'Asia/Shanghai': 3, 'America/Los_Angeles': 2, UTC: 2 }],
  ['2026-11-02T00:00:00+08:00', { 'Asia/Shanghai': 2, 'America/Los_Angeles': 1, UTC: 1 }],
  ['2026-11-01T20:00:00-08:00', { 'Asia/Shanghai': 2, 'America/Los_Angeles': 1, UTC: 2 }],
  ['2026-11-02T00:00:00+0800', { 'Asia/Shanghai': 2, 'America/Los_Angeles': 1, UTC: 1 }],
  ['2026-11-01T20:00:00-0800', { 'Asia/Shanghai': 2, 'America/Los_Angeles': 1, UTC: 2 }],
  ['2026-11-02T23:30:00Z', { 'Asia/Shanghai': 3, 'America/Los_Angeles': 2, UTC: 2 }],
  ['2026-11-02T23:30:00.250Z', { 'Asia/Shanghai': 3, 'America/Los_Angeles': 2, UTC: 2 }],
  ['2026-11-02', { 'Asia/Shanghai': 2, 'America/Los_Angeles': 2, UTC: 2 }],
  ['2026-11-02T23:30:00', { 'Asia/Shanghai': 2, 'America/Los_Angeles': 2, UTC: 2 }],
];

test('daily points fall on their calendar day in the instance time zone, whatever the browser zone', t => {
  const saved = process.env.TZ;
  t.after(() => { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; });
  for (const browser of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Shanghai']) {
    process.env.TZ = browser;
    for (const instance of ['Asia/Shanghai', 'America/Los_Angeles', 'UTC']) {
      for (const [value, expected] of ZONED) {
        const local = new Date(chartDay(value, instance));
        assert.deepEqual([local.getFullYear(), local.getMonth() + 1, local.getDate(), local.getHours(), local.getMinutes()],
          [2026, 11, expected[instance], 0, 0], `browser ${browser}, instance ${instance}, ${value}`);
      }
    }
  }
});

test('without a usable instance time zone instants are read in UTC', () => {
  for (const zone of [undefined, null, '', 'Not/AZone']) {
    for (const [value, expected] of ZONED) {
      const local = new Date(chartDay(value, zone));
      assert.equal(local.getDate(), expected.UTC, `${zone} ${value}`);
    }
  }
});

test('the daily axis labels, points and tooltip follow the instance time zone', t => {
  const saved = process.env.TZ;
  t.after(() => { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; });
  process.env.TZ = 'America/Los_Angeles';
  const xs = [Date.UTC(2026, 10, 1, 16), Date.UTC(2026, 10, 2, 16), Date.UTC(2026, 10, 3, 16)];
  const shanghai = conversationChartConfig(block('date', xs), { locale: 'zh-CN', timeZone: 'Asia/Shanghai' });
  assert.deepEqual(render(shanghai, 900).labels, ['11月2日', '11月3日', '11月4日']);
  const first = shanghai.data.datasets[0].data[0].x;
  assert.equal(shanghai.options.plugins.tooltip.callbacks.title([{ parsed: { x: first } }]), '2026年11月2日');
  const losAngeles = conversationChartConfig(block('date', xs), { locale: 'zh-CN', timeZone: 'America/Los_Angeles' });
  assert.deepEqual(render(losAngeles, 900).labels, ['11月1日', '11月2日', '11月3日']);
  const hourly = conversationChartConfig(block('datetime', xs), { locale: 'zh-CN', timeZone: 'Asia/Shanghai' });
  assert.deepEqual(hourly.data.datasets[0].data.map(point => point.x), xs, 'date-time axes keep their native values');
});

test('dates that do not exist are left out without moving the axis', () => {
  for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10']) assert.ok(Number.isNaN(chartDay(bad)), bad);
  for (const bad of ['2026-02-30T10:00:00Z', '2026-02-30T10:00:00+08:00', '2026-13-01T00:00:00-0800']) {
    for (const zone of ['Asia/Shanghai', 'America/Los_Angeles', undefined]) assert.ok(Number.isNaN(chartDay(bad, zone)), `${bad} ${zone}`);
  }
  assert.equal(chartDay('2024-02-29'), new Date(2024, 1, 29).getTime(), 'a real leap day stays');
  const xs = ['2026-02-27', '2026-02-30', '2026-02-28', '2026-13-01', '2026-02-28garbage', '2026-03-01'];
  const config = conversationChartConfig(block('date', xs), { locale: 'zh-CN' });
  config.options.responsive = false; config.options.devicePixelRatio = 1;
  const chart = new Chart(canvas(900), config);
  try {
    assert.deepEqual(chart.scales.x.getLabelItems().map(item => item.label), ['2月27日', '2月28日', '3月1日'], 'no year and no tick for the invalid dates');
    const drawn = chart.getDatasetMeta(0).data.map(point => !point.skip && Number.isFinite(point.x));
    assert.deepEqual(drawn, [true, false, true, false, false, true]);
  } finally { chart.destroy(); }
});

test('hourly data keeps the automatic time axis and labels its ticks and tooltip in the instance time zone', () => {
  const config = conversationChartConfig(block('datetime', hours(12)), { locale: 'en', timeZone: 'Asia/Shanghai' });
  assert.equal(config.options.scales.x.type, 'time');
  assert.equal(config.options.scales.x.time, undefined, 'Chart.js still picks the unit');
  assert.equal(config.options.scales.x.ticks.source, undefined);
  assert.equal(config.options.scales.x.afterDataLimits, undefined);
  const axis = render(config, 900);
  assert.ok(['hour', 'minute'].includes(axis.unit), `unit ${axis.unit}`);
  assert.ok(axis.labels.length > 1);
  for (const label of axis.labels) assert.match(label, /^(\d{2}:\d{2}(\s?[AP]M)?|[A-Z][a-z]{2} \d{1,2})$/, label);
  const callback = config.options.scales.x.ticks.callback;
  const instant = Date.UTC(2026, 10, 2, 1, 30);
  assert.equal(callback(instant), new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' }).format(instant));
  assert.equal(callback(Date.UTC(2026, 10, 1, 16)), 'Nov 2', 'midnight in the instance zone names the day');
  const title = config.options.plugins.tooltip.callbacks.title([{ parsed: { x: instant } }]);
  assert.equal(title, new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' }).format(instant));
  const unknown = conversationChartConfig(block('datetime', hours(12)), { locale: 'en' });
  assert.equal(unknown.options.scales.x.ticks.callback(Date.UTC(2026, 10, 2, 0)), 'Nov 2', 'an unknown zone reads UTC');
});

test('an instant outside the date range leaves out only its own point', () => {
  const huge = 1_793_584_800_000_000_000; // nanoseconds written where milliseconds belong
  for (const zone of ['Asia/Shanghai', undefined]) assert.ok(Number.isNaN(chartDay(huge, zone)), String(zone));
  const config = conversationChartConfig(block('date', ['2026-11-01', huge, '2026-11-03']), { locale: 'zh-CN', timeZone: 'Asia/Shanghai' });
  config.options.responsive = false; config.options.devicePixelRatio = 1;
  const chart = new Chart(canvas(900), config);
  try {
    assert.deepEqual(chart.scales.x.getLabelItems().map(item => item.label), ['11月1日', '11月3日']);
    assert.deepEqual(chart.getDatasetMeta(0).data.map(point => !point.skip && Number.isFinite(point.x)), [true, false, true]);
  } finally { chart.destroy(); }
});
