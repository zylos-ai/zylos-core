import { element } from './plain-text.js?v=106';
import { formatZoned, instanceZone, zonedInputValue } from './instance-zone.js?v=100';
import { formatDuration } from './duration-format.js?v=1';

const colors = ['#35a998', '#e1a33d', '#4f8cf7', '#e06b83', '#aa79e8', '#73859f'];
const halfDay = 12 * 60 * 60 * 1000;

const dayFormats = new Map();

/**
 * Year, month (0-based) and day of an instant in a time zone; an unknown or missing zone reads UTC. An instant outside
 * the Date range (for example nanoseconds written as milliseconds) has no day, so only that point is left out.
 */
function zoneDay(epoch, timeZone) {
  if (!Number.isFinite(new Date(epoch).getTime())) return [NaN, NaN, NaN];
  const zone = timeZone || 'UTC';
  let format = dayFormats.get(zone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' });
    } catch {
      return zone === 'UTC' ? undefined : zoneDay(epoch, 'UTC');
    }
    dayFormats.set(zone, format);
  }
  const parts = {};
  for (const { type, value } of format.formatToParts(new Date(epoch))) parts[type] = Number(value);
  return [parts.year, parts.month - 1, parts.day];
}

/**
 * The calendar day a daily point names, as local midnight for the day axis. A plain YYYY-MM-DD, or a date-time
 * without an offset, is read by the date it writes. Epoch milliseconds and date-times with Z or an offset (±hh:mm or
 * ±hhmm) name an instant, so they are read as the calendar day in the instance time zone (`timeZone`, the TZ the agent
 * runs in), not in the browser's zone or UTC; without a known instance zone they fall back to UTC. A date that does not exist
 * (2026-02-30, 2026-13-01) gives NaN, so Chart.js leaves the point out instead of drawing it on another day.
 */
export function chartDay(value, timeZone) {
  let parts;
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?=$|T)/.exec(value);
    if (match) {
      parts = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
      const written = new Date(Date.UTC(2000, parts[1], parts[2]));
      written.setUTCFullYear(parts[0]);
      if (written.getUTCFullYear() !== parts[0] || written.getUTCMonth() !== parts[1] || written.getUTCDate() !== parts[2]) return NaN;
      if (/T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
        // ±hhmm gets its colon first: not every browser parses the short form.
        const instant = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
        parts = Number.isFinite(instant) ? zoneDay(instant, timeZone) : undefined;
        if (!parts) return NaN;
      }
    }
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    parts = zoneDay(value, timeZone);
  }
  if (!parts) return value;
  const day = new Date(0);
  day.setFullYear(...parts);
  day.setHours(0, 0, 0, 0);
  return day.getFullYear() === parts[0] && day.getMonth() === parts[1] && day.getDate() === parts[2] ? day.getTime() : NaN;
}

function formatted(value, unit, format, locale) {
  if (value === null) return '';
  if (format?.style === 'duration') return formatDuration(value, format.maximumFractionDigits, locale);
  let amount = value;
  const options = { maximumFractionDigits: format?.maximumFractionDigits ?? 6 };
  if (format?.style === 'integer') options.maximumFractionDigits = 0;
  if (format?.style === 'percent') options.style = 'percent';
  if (format?.style === 'currency' && format.currency) {
    options.style = 'currency'; options.currency = format.currency;
    if (format.minorUnits) amount /= 10 ** new Intl.NumberFormat(locale, options).resolvedOptions().maximumFractionDigits;
  }
  return new Intl.NumberFormat(locale, options).format(amount) + (unit ? ` ${unit}` : '');
}

function durationLimits(scale) {
  // Aim for four intervals, keeping tick boundaries on whole time units.
  const target = (scale.max - scale.min) / 4;
  let step = [1, 5, 10, 15, 30, 60, 300, 600, 900, 1800].find(value => value >= target);
  if (step === undefined) {
    const hours = target / 3600, magnitude = 10 ** Math.floor(Math.log10(hours));
    step = [1, 2, 5, 10].find(value => value * magnitude >= hours) * magnitude * 3600;
  }
  scale.min = Math.floor(scale.min / step) * step;
  scale.max = Math.ceil(scale.max / step) * step;
  scale.options.ticks.stepSize = step;
}

const assessmentColors = { critical: colors[3], negative: colors[3], warning: colors[1] };
const alpha = (hex, opacity) => hex + Math.round(opacity * 255).toString(16).padStart(2, '0');

function markInk(hex) {
  const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const darkLuminance = 0.00546; // #0b1220, compared with white by relative luminance.
  return (luminance + 0.05) / (darkLuminance + 0.05) >= 1.05 / (luminance + 0.05) ? '#0b1220' : '#ffffff';
}

function lastPoint(dataset) {
  for (let index = dataset.data.length - 1; index >= 0; index--) {
    const point = dataset.data[index];
    if (Number.isFinite(point?.y) && (typeof point.x !== 'number' || Number.isFinite(point.x))) return index;
  }
  return -1;
}

// Plugin options are presentation functions, not scriptable chart options. Keeping them in the config
// lets theme, language and instance-zone updates replace every label and colour on the existing chart.
const valueMarks = {
  id: 'conversationValues',
  descriptors: { _scriptable: false, _indexable: false },
  beforeUpdate(chart, args, presentation) {
    const { kind, format, noValue, font } = presentation;
    const { ctx } = chart;
    if (!kind || !ctx?.measureText) return;
    ctx.save();
    ctx.font = `600 12px ${font}`;
    let right = 0, left = 0;
    if (kind === 'line') for (const dataset of chart.data.datasets) {
      const index = lastPoint(dataset);
      if (index >= 0) right = Math.max(right, ctx.measureText(format(dataset.data[index].y, dataset.unit)).width + 14);
    }
    if (kind === 'category') for (const value of chart.data.datasets[0].data) {
      const width = ctx.measureText(value === null ? noValue : format(value, chart.data.datasets[0].unit)).width + 10;
      if (value !== null && value < 0) left = Math.max(left, width);
      else right = Math.max(right, width);
    }
    ctx.restore();
    chart.options.layout.padding.right = Math.ceil(right);
    chart.options.layout.padding.left = Math.ceil(left);
  },
  afterDatasetsDraw(chart, args, presentation) {
    const { kind, format, percent, noValue, font, text, strong, crosshair, reference } = presentation;
    if (!kind) return;
    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.textBaseline = 'middle';
    if (kind === 'line') {
      const active = chart.tooltip?.getActiveElements?.() ?? [];
      if (active.length && Number.isFinite(active[0].element.x)) {
        const x = Math.round(active[0].element.x) + 0.5;
        ctx.strokeStyle = crosshair; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
      }
      ctx.font = `600 12px ${font}`; ctx.textAlign = 'left'; ctx.fillStyle = strong;
      chart.data.datasets.forEach((dataset, datasetIndex) => {
        const index = lastPoint(dataset), point = chart.getDatasetMeta(datasetIndex).data[index];
        if (!point || point.skip || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
        ctx.fillText(format(dataset.data[index].y, dataset.unit), point.x + 9, point.y);
      });
    } else if (kind === 'category') {
      const dataset = chart.data.datasets[0];
      ctx.font = `500 12px ${font}`; ctx.fillStyle = text;
      chart.getDatasetMeta(0).data.forEach((bar, index) => {
        const value = dataset.data[index];
        if (!Number.isFinite(bar.y)) return;
        const negative = value !== null && value < 0;
        ctx.textAlign = negative ? 'right' : 'left';
        const x = value === null ? chart.scales.x.getPixelForValue(0) + 6 : bar.x + (negative ? -6 : 6);
        ctx.fillText(value === null ? noValue : format(value, dataset.unit), x, bar.y);
      });
      if (reference) {
        ctx.font = `500 11.5px ${font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        const width = ctx.measureText(reference.text).width;
        const x = Math.max(chartArea.left + width / 2, Math.min(chartArea.right - width / 2, chart.scales.x.getPixelForValue(reference.value)));
        ctx.fillText(reference.text, x, chartArea.top - 4);
      }
    } else if (kind === 'breakdown') {
      const total = chart.data.datasets.reduce((sum, dataset) => sum + dataset.data[0], 0);
      ctx.font = `600 12px ${font}`; ctx.textAlign = 'center';
      if (total > 0) chart.data.datasets.forEach((dataset, index) => {
        const bar = chart.getDatasetMeta(index).data[0];
        if (!bar) return;
        const label = percent(dataset.data[0] / total);
        if (ctx.measureText(label).width + 16 > Math.abs(bar.x - bar.base)) return;
        ctx.fillStyle = markInk(dataset.backgroundColor);
        ctx.fillText(label, (bar.x + bar.base) / 2, bar.y + 0.5);
      });
    }
    ctx.restore();
  }
};

/** Chart kinds are a host presentation choice; protocol data remains unchanged. */
export function conversationChartConfig(block, { text = '#526170', muted = '#7a8794', strong = '#101827', grid = '#7a879424',
  surface = '#ffffff', tooltipBg = '#101827', tooltipText = '#f7faf9', font = 'Inter, system-ui, sans-serif',
  noValue = '—', locale, timeZone } = {}) {
  const data = block.data;
  // An unknown instance zone reads UTC, as daily points do.
  const zone = instanceZone(timeZone ?? null);
  const tickFont = { family: font, size: 11.5 };
  const format = (value, unit) => formatted(value, unit, data.format, locale);
  const tick = unit => value => formatted(value, unit, data.format, locale);
  const axis = (title, unit) => ({ ...(data.format?.style === 'percent' || unit === '%'
    ? { suggestedMax: data.format?.style === 'percent' ? 1 : 100 } : {}), title: { display: !!title, text: title, color: text, font: tickFont },
    ticks: { color: text, font: tickFont, padding: 8, maxTicksLimit: 6, callback: tick(unit), ...(data.format?.style === 'percent' || unit === '%'
      ? { stepSize: data.format?.style === 'percent' ? 0.25 : 25 } : {}) }, grid: { color: grid, drawTicks: false }, border: { display: false },
    ...(data.format?.style === 'duration' ? { afterDataLimits: durationLimits } : {}) });
  const datasets = [], scales = {};
  let type = 'bar', indexAxis = 'x', labels, marks;
  if (block.type === 'time_series') {
    const units = [...new Set(data.series.map(series => series.unit ?? data.yUnit ?? ''))];
    const category = data.xType === 'category';
    type = category ? 'bar' : 'line';
    // Time-series comparisons do not declare additive parts; only breakdown stacks.
    const stacked = false;
    const xTicks = { color: text, font: tickFont, padding: 8, maxRotation: 0, autoSkipPadding: 16 };
    scales.x = { type: category ? 'category' : data.xType === 'number' ? 'linear' : 'time',
      title: { display: !!data.xLabel, text: data.xLabel, color: text, font: tickFont }, ticks: xTicks,
      grid: { display: false }, border: { color: grid }, stacked };
    if (data.xType === 'date') {
      // Without a unit Chart.js picks one from the pixel width, so a week of days came out as hour ticks.
      // Days tick only on the dates present, labelled in the page language; half a day either side keeps
      // a single point inside the plot instead of a zero-width millisecond range.
      // Data spanning more than one calendar year names the year too, so the same day of different years
      // never shows as the same label.
      const stamps = data.series.flatMap(series => series.points.map(point => chartDay(point.x, timeZone))).filter(Number.isFinite);
      const years = new Set(stamps.map(stamp => new Date(stamp).getFullYear()));
      const dayLabel = new Intl.DateTimeFormat(locale, { ...(years.size > 1 ? { year: 'numeric' } : {}), month: 'short', day: 'numeric' });
      scales.x.time = { unit: 'day' };
      scales.x.ticks = { ...xTicks, source: 'data', callback: value => dayLabel.format(value) };
      scales.x.afterDataLimits = scale => { scale.min -= halfDay; scale.max += halfDay; };
    } else if (data.xType === 'datetime') {
      // Date-times are labelled in the instance time zone (UTC while it is unknown), never the browser's: a tick at
      // the zone's midnight names the day, other ticks the clock time.
      scales.x.ticks = { ...xTicks, callback: value => formatZoned(value, locale,
        zonedInputValue(value, zone).endsWith('T00:00') ? { month: 'short', day: 'numeric' } : { hour: '2-digit', minute: '2-digit' }, zone) };
    }
    const categoryKeys = [], categoryLabels = new Map();
    const points = data.series.map(series => {
      const counts = new Map();
      return series.points.map(point => {
        const count = counts.get(point.x) ?? 0; counts.set(point.x, count + 1);
        const key = JSON.stringify([point.x, count]);
        if (category && !categoryLabels.has(key)) { categoryKeys.push(key); categoryLabels.set(key, point.x); }
        return { ...point, categoryKey: key };
      });
    });
    if (category) labels = categoryKeys.map(key => categoryLabels.get(key));
    for (const [index, series] of data.series.entries()) {
      const unit = series.unit ?? data.yUnit ?? '', unitIndex = units.indexOf(unit), yAxisID = unitIndex ? 'y' + unitIndex : 'y';
      if (!scales[yAxisID]) {
        scales[yAxisID] = { ...axis(units.length > 1 ? [data.yLabel, unit].filter(Boolean).join(' · ') : data.yLabel, unit),
          position: unitIndex % 2 ? 'right' : 'left', stacked, beginAtZero: true };
        if (unitIndex) scales[yAxisID].grid.drawOnChartArea = false;
      }
      const values = new Map(points[index].map(point => [point.categoryKey, point.y]));
      const color = colors[index % colors.length];
      const rows = category ? categoryKeys.map(key => values.has(key) ? values.get(key) : null)
        : series.points.map(point => ({ x: data.xType === 'date' ? chartDay(point.x, timeZone) : point.x, y: point.y }));
      const present = index => Number.isFinite(rows[index]?.y) && (typeof rows[index].x !== 'number' || Number.isFinite(rows[index].x));
      const last = category ? -1 : lastPoint({ data: rows });
      const single = data.series.length === 1;
      datasets.push({ label: series.label, data: rows, borderColor: color, borderWidth: category ? 0 : 2,
        backgroundColor: category || !single ? color : context => {
          const { chartArea, ctx } = context.chart;
          if (!chartArea) return alpha(color, 0.12);
          const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          gradient.addColorStop(0, alpha(color, 0.22)); gradient.addColorStop(1, alpha(color, 0));
          return gradient;
        },
        fill: !category && single ? 'origin' : false,
        borderRadius: category ? 4 : 0, maxBarThickness: 28, cubicInterpolationMode: 'monotone', spanGaps: false,
        pointRadius: category ? 0 : context => present(context.dataIndex) && (context.dataIndex === last ||
          (!present(context.dataIndex - 1) && !present(context.dataIndex + 1))) ? 3.5 : 0,
        pointHoverRadius: category ? 0 : 5, pointBackgroundColor: color, pointBorderColor: surface,
        pointBorderWidth: 2, pointHoverBorderWidth: 2, yAxisID, unit });
    }
    if (!category) marks = { kind: 'line' };
  } else if (block.type === 'category_series') {
    indexAxis = 'y'; labels = data.points.map(point => point.label);
    scales.x = { ...axis(data.yLabel, data.unit), beginAtZero: true, display: !!data.yLabel,
      // The optional title owns exactly 32px: a 16px line and 8px above/below.
      title: { display: !!data.yLabel, text: data.yLabel, color: text, font: { ...tickFont, lineHeight: '16px' }, padding: 8 },
      ticks: { display: false }, grid: { display: false, drawTicks: false }, border: { display: false } };
    scales.y = { title: { display: false },
      ticks: { color: text, font: { family: font, size: 12 }, padding: 12, crossAlign: 'far', autoSkip: false },
      grid: { display: false }, border: { display: false },
      // Offset category rows already leave half a row around the first/last label.
      // Extra scale padding would subtract that space from the fixed row pitch.
      afterFit(scale) { scale.paddingTop = 0; scale.paddingBottom = 0; } };
    datasets.push({ label: data.yLabel ?? data.title ?? '', data: data.points.map(point => point.value),
      backgroundColor: data.points.map(point => assessmentColors[point.assessment?.status] ?? colors[0]),
      borderRadius: 4, borderSkipped: 'start', barThickness: 20, categoryPercentage: 1, unit: data.unit });
    if (data.reference) datasets.push({ type: 'line', label: data.reference.label,
      data: data.points.map((point, index) => ({ x: data.reference.value, y: index })),
      borderColor: muted, borderDash: [4, 4], borderWidth: 1.25, pointRadius: 0, pointHoverRadius: 0, unit: data.unit });
    marks = { kind: 'category', reference: data.reference ? { value: data.reference.value,
      text: `${data.reference.label} ${format(data.reference.value, data.unit)}` } : null };
  } else {
    indexAxis = 'y'; labels = [data.title ?? ''];
    scales.x = { stacked: true, beginAtZero: true, display: false, min: 0,
      max: data.parts.reduce((sum, part) => sum + part.value, 0) || undefined };
    scales.y = { stacked: true, display: false };
    for (const [index, part] of data.parts.entries()) datasets.push({ label: part.label, data: [part.value],
      backgroundColor: colors[index % colors.length], borderColor: surface,
      borderWidth: { top: 0, bottom: 0, left: 1.5, right: 1.5 }, borderSkipped: false, borderRadius: 6,
      barThickness: 24, categoryPercentage: 1, barPercentage: 1, unit: data.unit });
    marks = { kind: 'breakdown' };
  }
  if (marks) Object.assign(marks, { font, text, strong, crosshair: alpha(muted, 0.45), noValue, format,
    percent: share => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(share) });
  const multi = block.type === 'time_series' && datasets.length > 1;
  return { type, data: { ...(labels ? { labels } : {}), datasets }, plugins: [valueMarks], options: {
    indexAxis, locale, responsive: true, maintainAspectRatio: false, animation: false, color: text,
    font: { family: font }, layout: { autoPadding: block.type === 'time_series',
      padding: { top: block.type === 'category_series' ? (data.reference ? 18 : 0) : block.type === 'breakdown' ? 0 : 6, right: 0, bottom: 0, left: 0 } },
    interaction: type === 'line' ? { mode: 'index', intersect: false } : { mode: 'nearest', intersect: true },
    scales, plugins: { conversationValues: marks ?? false,
    legend: { display: block.type === 'time_series' && (multi || !data.title), align: 'start', onClick: null,
      labels: { color: text, usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 8, boxHeight: 8, padding: 16, font: { family: font, size: 12 } } },
    tooltip: { backgroundColor: tooltipBg, titleColor: tooltipText, bodyColor: tooltipText, borderWidth: 0, cornerRadius: 8,
      padding: { x: 10, y: 8 }, caretPadding: 8, titleMarginBottom: 4, usePointStyle: true,
      displayColors: multi || block.type === 'breakdown', titleFont: { family: font, size: 12, weight: '600' }, bodyFont: { family: font, size: 12 },
      filter: item => block.type !== 'category_series' || item.dataset.type !== 'line', callbacks: { ...(data.xType === 'date' ? { title(items) {
      return items.length ? new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(items[0].parsed.x) : '';
    } } : data.xType === 'datetime' ? { title(items) {
      return items.length ? formatZoned(items[0].parsed.x, locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }, zone) : '';
    } } : block.type === 'breakdown' ? { title: () => '' } : {}), label(context) {
      const amount = context.parsed[indexAxis === 'y' ? 'x' : 'y'];
      return `${context.dataset.label}: ${formatted(amount, context.dataset.unit, data.format, locale)}`;
    } } } }
  } };
}

function breakdownLegend(document, block, locale) {
  const list = element(document, 'ul', undefined, 'conversation-chart-legend');
  for (const [index, part] of block.data.parts.entries()) {
    const item = element(document, 'li');
    const swatch = element(document, 'span', undefined, 'conversation-chart-swatch');
    swatch.style.background = colors[index % colors.length]; swatch.setAttribute('aria-hidden', 'true');
    item.append(swatch, element(document, 'span', part.label, 'conversation-chart-legend-label'),
      element(document, 'span', formatted(part.value, block.data.unit, block.data.format, locale), 'conversation-chart-legend-value'));
    list.append(item);
  }
  return list;
}

/**
 * The page mounts after attachment and destroys before dropping its message DOM. `timeZone` returns the instance
 * time zone daily points are read in; each mount re-reads it, so a changed zone redraws the chart.
 */
export function conversationChartResource({ document, block, fallback, t = key => key, timeZone = () => null }) {
  const plot = element(document, 'div', undefined, 'conversation-chart-plot');
  const canvas = element(document, 'canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', block.data.title ?? block.data.summary ?? block.fallbackText);
  plot.hidden = true; plot.append(canvas);
  if (block.type === 'category_series') plot.style.setProperty('--chat-plot-h',
    `${block.data.points.length * 34 + (block.data.reference ? 18 : 0) + (block.data.yLabel ? 32 : 0)}px`);
  fallback.insertBefore(plot, fallback.querySelector('.chat-chart-series'));
  const axes = fallback.querySelector('.chat-chart-axes'), axisDescription = axes?.textContent;
  let chart, appearance, details, detailsSummary, legend, destroyed = false;
  return { node: fallback,
    mount() {
      if (destroyed || canvas.isConnected === false) return;
      const Chart = document.defaultView?.Chart;
      if (typeof Chart !== 'function') return;
      try {
        const style = document.defaultView?.getComputedStyle?.(document.documentElement);
        const read = name => style?.getPropertyValue(name)?.trim() || undefined;
        const muted = /^#[0-9a-f]{6}$/i.test(read('--text-muted') ?? '') ? read('--text-muted') : undefined;
        const palette = { text: read('--text-dim'), strong: read('--text'), muted,
          grid: muted ? alpha(muted, 0.14) : undefined, surface: read('--bg-elevated'),
          tooltipBg: read('--text'), tooltipText: read('--bg'), font: read('font-family'),
          noValue: t('chat.block.noValue'), locale: document.documentElement?.lang || undefined, timeZone: timeZone() || undefined };
        const signature = JSON.stringify(palette);
        if (chart) {
          if (signature !== appearance) {
            // A new instance time zone can move daily points to other days, so the data is rebuilt with the options.
            const next = conversationChartConfig(block, palette);
            chart.options = next.options;
            chart.data = next.data;
            chart.update('none');
            if (legend) {
              const nextLegend = breakdownLegend(document, block, palette.locale);
              legend.replaceWith(nextLegend); legend = nextLegend;
            }
            appearance = signature;
          }
          if (detailsSummary) detailsSummary.textContent = t('chat.chart.data');
          chart.resize();
          return;
        }
        const config = conversationChartConfig(block, palette);
        plot.hidden = false;
        chart = new Chart(canvas, config);
        if ('ctx' in chart && !chart.ctx) throw new Error('Canvas context unavailable');
        if (block.type === 'breakdown') {
          legend = breakdownLegend(document, block, palette.locale);
          fallback.insertBefore(legend, plot.nextSibling ?? fallback.querySelector('.chat-chart-series'));
        }
        appearance = signature;
        details = element(document, 'details', undefined, 'conversation-chart-data');
        detailsSummary = element(document, 'summary', t('chat.chart.data'));
        details.append(detailsSummary);
        const entries = [...fallback.querySelectorAll('.chat-chart-series, .chat-chart-baseline')];
        for (const entry of entries) details.append(entry);
        if (entries.length) fallback.append(details);
        if (axes) {
          if (block.type === 'category_series') axes.textContent = block.data.xLabel ?? '';
          axes.hidden = block.type !== 'category_series' || !block.data.xLabel;
        }
        fallback.classList.add('conversation-chart-enhanced');
      } catch {
        try { (chart ?? Chart.getChart?.(canvas))?.destroy(); } catch { /* Keep the static data available. */ }
        chart = undefined; appearance = undefined; plot.hidden = true;
        if (axes) { axes.textContent = axisDescription; axes.hidden = false; }
        legend?.remove(); legend = undefined;
        if (details) {
          for (const entry of [...details.querySelectorAll('.chat-chart-series, .chat-chart-baseline')]) fallback.insertBefore(entry, plot);
          details.remove(); details = undefined; detailsSummary = undefined;
        }
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try { chart?.destroy(); } catch { /* Disposal must not prevent other message resources from closing. */ }
      chart = undefined;
    }
  };
}
