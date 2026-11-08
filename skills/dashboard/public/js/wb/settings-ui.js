import { element } from './plain-text.js?v=103';

/** Segmented choice: one pressed button per option; forwards the chosen value. */
function segmented(root, { document, id, label, options, value, onChange }) {
  const group = element(document, 'div', undefined, 'wb-seg2'); group.id = id; group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
  const buttons = options.map(([key, text, i18n]) => {
    const button = element(document, 'button', text); button.type = 'button'; button.dataset.value = key;
    if (i18n) button.dataset.i18n = i18n;
    button.addEventListener('click', () => { set(key); onChange(key); });
    group.append(button); return button;
  });
  function set(next) { group.value = next; for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.value === next)); }
  set(value); root.append(group);
  return Object.assign(group, { set });
}

export function mountThemeControl(root, { document = root.ownerDocument, t = key => key, value = 'light', onChange }) {
  return segmented(root, { document, id: 'settings-theme', label: t('wb.theme'), value, onChange,
    options: ['system', 'light', 'dark'].map(theme => [theme, t('wb.settings.theme.' + theme), 'wb.settings.theme.' + theme]) });
}
/** Language as 中文 / English; each label is written in its own language. */
export function mountLanguageControl(root, { document = root.ownerDocument, t = key => key, value = 'zh', onChange }) {
  const control = segmented(root, { document, id: 'locale-toggle', label: t('wb.settings.pref.lang'), value, onChange, options: [['zh', '中文'], ['en', 'English']] });
  return control;
}
// Technical view only: a failure occupies an empty slot, not a zero millisecond bar.
export function renderLatency(root, samples = [], { document = root.ownerDocument, t = key => key } = {}) {
  const values = samples.slice(-20), max = Math.max(1, ...values.map(sample => Number.isFinite(sample.ms) ? sample.ms : 0));
  const chart = element(document, 'span', undefined, 'wb-lat'); chart.setAttribute('aria-label', t('wb.settings.latency'));
  for (const sample of values) {
    const bar = element(document, 'i'); bar.dataset.latencyMs = sample.ms == null ? '' : String(sample.ms); bar.title = `${sample.at} · ${sample.ms == null ? t('wb.unknown') : sample.ms + ' ms'}`;
    bar.style.height = sample.ms == null ? '0' : `${Math.max(1, sample.ms / max * 12)}px`; chart.append(bar);
  }
  root.append(chart); return chart;
}
