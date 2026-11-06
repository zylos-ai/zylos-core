import { element } from './plain-text.js?v=85';

export function mountThemeControl(root, { document = root.ownerDocument, t = key => key, value = 'light', onChange }) {
  const label = element(document, 'label');
  const text = element(document, 'span', t('wb.theme')); text.dataset.i18n = 'wb.theme'; label.append(text);
  const select = element(document, 'select'); select.id = 'settings-theme'; select.className = 'action-select';
  for (const theme of ['light', 'dark', 'system']) { const option = element(document, 'option', t('wb.settings.theme.' + theme)); option.dataset.i18n = 'wb.settings.theme.' + theme; option.value = theme; select.append(option); }
  select.value = value; select.addEventListener('change', () => onChange(select.value)); label.append(select); root.append(label); return select;
}
// Technical view only: a failure occupies an empty slot, not a zero millisecond bar.
export function renderLatency(root, samples = [], { document = root.ownerDocument, t = key => key } = {}) {
  const values = samples.slice(-20), max = Math.max(1, ...values.map(sample => Number.isFinite(sample.ms) ? sample.ms : 0));
  const chart = element(document, 'div'); chart.style.display = 'flex'; chart.style.alignItems = 'end'; chart.style.gap = '2px'; chart.style.height = '32px'; chart.setAttribute('aria-label', t('wb.settings.latency'));
  for (const sample of values) {
    const bar = element(document, 'span'); bar.dataset.latencyMs = sample.ms == null ? '' : String(sample.ms); bar.title = `${sample.at} · ${sample.ms == null ? t('wb.unknown') : sample.ms + ' ms'}`;
    bar.style.width = '6px'; bar.style.height = sample.ms == null ? '0' : `${Math.max(1, sample.ms / max * 30)}px`; bar.style.background = 'currentColor'; chart.append(bar);
  }
  root.append(chart); return chart;
}
