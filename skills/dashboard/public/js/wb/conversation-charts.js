import { element } from './plain-text.js?v=103';

const colors = ['#4f8cf7', '#aa79e8', '#35a998', '#e1a33d', '#e06b83', '#73859f'];
const halfDay = 12 * 60 * 60 * 1000;

/**
 * The calendar day a daily point names, as local midnight. An ISO string is read by its leading YYYY-MM-DD and
 * epoch milliseconds by their UTC date, so a point written as 2026-11-02T00:00:00Z or as its epoch value stays on
 * 2 November in every time zone instead of moving to the previous day west of UTC.
 */
export function chartDay(value) {
  let parts;
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (match) parts = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    const utc = new Date(value);
    parts = [utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate()];
  }
  if (!parts) return value;
  const day = new Date(0);
  day.setFullYear(...parts);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function formatted(value, unit, format, locale) {
  if (value === null) return '';
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

/** Chart kinds are a host presentation choice; protocol data remains unchanged. */
export function conversationChartConfig(block, { text = '#64748b', grid = '#d7dce3', locale } = {}) {
  const data = block.data;
  const tick = unit => value => formatted(value, unit, data.format, locale);
  const axis = (title, unit) => ({ ...(data.format?.style === 'percent' || unit === '%'
    ? { suggestedMax: data.format?.style === 'percent' ? 1 : 100 } : {}), title: { display: !!title, text: title, color: text },
    ticks: { color: text, callback: tick(unit), ...(data.format?.style === 'percent' || unit === '%'
      ? { stepSize: data.format?.style === 'percent' ? 0.25 : 25 } : {}) }, grid: { color: grid }, border: { color: grid } });
  const datasets = [], scales = {};
  let type = 'bar', indexAxis = 'x', labels;
  if (block.type === 'time_series') {
    const units = [...new Set(data.series.map(series => series.unit ?? data.yUnit ?? ''))];
    const category = data.xType === 'category';
    type = category ? 'bar' : 'line';
    // Time-series comparisons do not declare additive parts; only breakdown stacks.
    const stacked = false;
    scales.x = { type: category ? 'category' : data.xType === 'number' ? 'linear' : 'time',
      title: { display: !!data.xLabel, text: data.xLabel, color: text }, ticks: { color: text },
      grid: { color: grid }, border: { color: grid }, stacked };
    if (data.xType === 'date') {
      // Without a unit Chart.js picks one from the pixel width, so a week of days came out as hour ticks.
      // Days tick only on the dates present, labelled in the page language; half a day either side keeps
      // a single point inside the plot instead of a zero-width millisecond range.
      // Data spanning more than one calendar year names the year too, so the same day of different years
      // never shows as the same label.
      const stamps = data.series.flatMap(series => series.points.map(point => chartDay(point.x))).filter(Number.isFinite);
      const years = new Set(stamps.map(stamp => new Date(stamp).getFullYear()));
      const dayLabel = new Intl.DateTimeFormat(locale, { ...(years.size > 1 ? { year: 'numeric' } : {}), month: 'short', day: 'numeric' });
      scales.x.time = { unit: 'day' };
      scales.x.ticks = { color: text, source: 'data', callback: value => dayLabel.format(value) };
      scales.x.afterDataLimits = scale => { scale.min -= halfDay; scale.max += halfDay; };
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
      datasets.push({ label: series.label, data: category ? categoryKeys.map(key => values.has(key) ? values.get(key) : null)
        : series.points.map(point => ({ x: data.xType === 'date' ? chartDay(point.x) : point.x, y: point.y })),
        borderColor: colors[index], backgroundColor: colors[index], borderWidth: category ? 0 : 2,
        borderRadius: category ? 3 : 0, pointRadius: category ? 0 : 2, tension: 0.2, spanGaps: false,
        yAxisID, unit });
    }
  } else if (block.type === 'category_series') {
    indexAxis = 'y'; labels = data.points.map(point => point.label);
    scales.x = { ...axis(data.xLabel, data.unit), beginAtZero: true };
    scales.y = { title: { display: !!data.yLabel, text: data.yLabel, color: text }, ticks: { color: text }, grid: { display: false } };
    datasets.push({ label: data.yLabel ?? data.title ?? '', data: data.points.map(point => point.value),
      backgroundColor: colors[0], borderRadius: 3, unit: data.unit });
    if (data.reference) datasets.push({ type: 'line', label: data.reference.label,
      data: data.points.map((point, index) => ({ x: data.reference.value, y: index })),
      borderColor: text, borderDash: [5, 4], borderWidth: 1, pointRadius: 0, unit: data.unit });
  } else {
    indexAxis = 'y'; labels = [data.title ?? ''];
    scales.x = { ...axis(undefined, data.unit), stacked: true, beginAtZero: true };
    scales.y = { stacked: true, ticks: { display: false }, grid: { display: false } };
    for (const [index, part] of data.parts.entries()) datasets.push({ label: part.label, data: [part.value],
      backgroundColor: colors[index % colors.length], borderWidth: 0, borderRadius: 3, unit: data.unit });
  }
  return { type, data: { ...(labels ? { labels } : {}), datasets }, options: {
    indexAxis, locale, responsive: true, maintainAspectRatio: false, animation: false, color: text,
    scales, plugins: { legend: { display: block.type !== 'category_series' || !!data.reference, onClick: null,
      labels: { color: text, usePointStyle: true, boxWidth: 8, boxHeight: 8 } },
    tooltip: { callbacks: { ...(data.xType === 'date' ? { title(items) {
      return items.length ? new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(items[0].parsed.x) : '';
    } } : {}), label(context) {
      const amount = context.parsed[indexAxis === 'y' ? 'x' : 'y'];
      return `${context.dataset.label}: ${formatted(amount, context.dataset.unit, data.format, locale)}`;
    } } } }
  } };
}

/** The page mounts after attachment and destroys before dropping its message DOM. */
export function conversationChartResource({ document, block, fallback, t = key => key }) {
  const plot = element(document, 'div', undefined, 'conversation-chart-plot');
  const canvas = element(document, 'canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', block.data.title ?? block.data.summary ?? block.fallbackText);
  plot.hidden = true; plot.append(canvas);
  fallback.insertBefore(plot, fallback.querySelector('.chat-chart-series'));
  let chart, appearance, details, detailsSummary, destroyed = false;
  return { node: fallback,
    mount() {
      if (destroyed || canvas.isConnected === false) return;
      const Chart = document.defaultView?.Chart;
      if (typeof Chart !== 'function') return;
      try {
        const style = document.defaultView?.getComputedStyle?.(document.documentElement);
        const palette = { text: style?.getPropertyValue('--text-dim').trim() || undefined,
          grid: style?.getPropertyValue('--border').trim() || undefined, locale: document.documentElement?.lang || undefined };
        const signature = JSON.stringify(palette);
        if (chart) {
          if (signature !== appearance) {
            chart.options = conversationChartConfig(block, palette).options;
            chart.update('none');
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
        appearance = signature;
        details = element(document, 'details', undefined, 'conversation-chart-data');
        detailsSummary = element(document, 'summary', t('chat.chart.data'));
        details.append(detailsSummary);
        const entries = [...fallback.querySelectorAll('.chat-chart-series, .chat-chart-baseline')];
        for (const entry of entries) details.append(entry);
        if (entries.length) fallback.append(details);
        fallback.classList.add('conversation-chart-enhanced');
      } catch {
        try { (chart ?? Chart.getChart?.(canvas))?.destroy(); } catch { /* Keep the static data available. */ }
        chart = undefined; appearance = undefined; plot.hidden = true;
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
