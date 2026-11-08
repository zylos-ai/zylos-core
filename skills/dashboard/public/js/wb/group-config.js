import { element, runtimeName } from './plain-text.js?v=104';

export function responseError(value, fallback = 'request_failed') {
  const error = value?.error;
  return typeof error === 'string' ? error : [error?.code, error?.message].filter(Boolean).join(' · ') || fallback;
}

export async function fetchJson(fetch, path, options = {}) {
  const response = await fetch(path, options);
  let value;
  try { value = await response.json(); }
  catch { throw Object.assign(new Error('non_json'), { unknown: true }); }
  if (!response.ok) throw Object.assign(new Error(responseError(value)), { body: value, status: response.status });
  return value;
}

export function runningText(data, kind, t = key => key) {
  if (data?.running == null && data?.sessionMode === 'single') return t('wb.config.single');
  if (data?.running == null && kind === 'model' && data?.runtime !== data?.resolved?.runtime) return t('wb.config.otherRuntime');
  const running = data?.running;
  if (running?.status === 'unknown') return t('wb.config.unknown', { reason: running.reason ?? '' });
  return t('wb.config.' + ({ not_running: 'nextStart', pending: 'pending', applied: 'applied' }[running?.status] ?? 'resultUnknown'));
}

export function validConfigChange(change) {
  return change?.kind === 'runtime' ? ['inherit', 'claude', 'codex'].includes(change.value)
    : change?.kind === 'model' && ['claude', 'codex'].includes(change.runtime) &&
      (change.reset === true || (typeof change.model === 'string' && change.model.trim() !== '' &&
        typeof change.effort === 'string' && change.effort.trim() !== ''));
}

export function createGroupConfig({ key, request, onChange = () => {}, t = key => key, active = () => true }) {
  const state = { value: null, result: '', error: null, busy: false, meta: {} };
  const publish = () => { if (active()) onChange(state); };
  const thresholdRequests = new Set();
  async function loadThreshold(runtime, model) {
    if (!model || !['claude', 'codex'].includes(runtime) || Number.isFinite(state.meta[runtime]?.model_thresholds?.[model])) return;
    const id = runtime + ':' + model;
    if (thresholdRequests.has(id)) return;
    thresholdRequests.add(id);
    try {
      const value = await request('/api/actions/meta?' + new URLSearchParams({ runtime, model }));
      if (!active() || !value?.model_thresholds) return;
      state.meta[runtime] = { ...state.meta[runtime], ...value, model_thresholds: { ...state.meta[runtime]?.model_thresholds, ...value.model_thresholds } };
      publish();
    } catch { /* Keep the threshold explicitly unknown until the editor is opened again. */ }
  }
  // Model and effort choices per engine; without them the editor falls back to free text.
  async function loadMeta(runtime) {
    if (!['claude', 'codex'].includes(runtime) || runtime in state.meta) return state.meta[runtime];
    state.meta[runtime] = undefined;
    let value = null;
    try { value = await request('/api/actions/meta?runtime=' + runtime); } catch {}
    if (!active()) return null;
    state.meta[runtime] = Array.isArray(value?.models) ? value : null;
    publish();
    return state.meta[runtime];
  }
  async function load() {
    const value = await request(`/api/workbench/groups/${encodeURIComponent(key)}/config`);
    if (active()) {
      state.value = value;
      state.error = value.runtime?.ok === false ? responseError(value.runtime) : value.model?.ok === false ? responseError(value.model) : null;
      publish();
    }
    return value;
  }
  return {
    state, load, loadMeta, loadThreshold, redraw: publish,
    async save(change) {
      if (state.busy) return;
      if (!validConfigChange(change)) {
        state.error = t('wb.config.pairRequired');
        publish();
        return { ok: false, error: { code: 'MODEL_PAIR_REQUIRED' } };
      }
      state.busy = true;
      state.error = null;
      publish();
      try {
        let result;
        try {
          result = await request(`/api/workbench/groups/${encodeURIComponent(key)}/config`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change),
          });
        } catch (error) {
          if (error.name === 'AbortError' || !active()) return;
          result = error.body ?? { ok: false, unknown: true };
        }
        if (!active()) return;
        if (typeof result?.ok !== 'boolean') result = { ok: false, unknown: true };
        if (result?.unknown === true) {
          state.result = t('wb.config.resultUnknown');
          // A lost response is queried once, never submitted again.
          try { await load(); } catch { state.error = t('wb.readFailed'); }
        } else if (result.ok === false) {
          state.error = responseError(result);
        } else {
          state.result = runningText(result.data ?? result, change.kind, t);
          // Preserve the authoritative submitted result; the next explicit read
          // refreshes the complete runtime/model configuration.
          state.value = { ...state.value, [change.kind]: result };
        }
        return result;
      } finally {
        if (active()) { state.busy = false; publish(); }
      }
    },
  };
}

export function configSummary(value) {
  const runtime = value?.runtime?.data?.resolved;
  if (!runtime) return '';
  return [runtime.runtime, runtime.model, runtime.effort].filter(Boolean).join(' · ');
}

/** Model choices for an engine: the catalog plus the saved value when the catalog does not list it. */
export function modelChoices(meta, current) {
  if (!meta) return null;
  const list = meta.models.map(item => ({ value: item.id, label: item.display_name ?? item.id }));
  if (current && !list.some(item => item.value === current)) list.unshift({ value: current, label: current });
  return list;
}
export function effortChoices(meta, model, current) {
  const listed = meta?.efforts_by_model?.[model] ?? meta?.efforts_by_model?.['*'];
  const list = listed?.length ? [...listed] : ['low', 'medium', 'high'];
  if (current && !list.includes(current)) list.push(current);
  return list;
}

/**
 * The pair the editor starts from for one engine: the group's own setting, else what this group is running,
 * else what it would launch with. Never another group's or the machine's model; empty means "not chosen yet".
 */
export function startingPair(value, runtime) {
  const data = value?.model?.data;
  const candidates = [data?.desired?.mode === 'override' ? data.desired : null, data?.running?.launchConfig, data?.resolved];
  const pair = candidates.find(item => item?.runtime === runtime && typeof item.model === 'string' && item.model);
  return pair ? { model: pair.model, effort: typeof pair.effort === 'string' ? pair.effort : '' } : { model: '', effort: '' };
}

// Edit form: engine, model and effort as one pair with save and cancel. The per-group engine
// switch and the reset to the default model stay on a second, quieter line.
export function renderGroupConfig(root, controller, { document = root.ownerDocument, t = key => key, writable = true, rotationThreshold = null, onCancel = () => {} } = {}) {
  const { state } = controller;
  state.draft ??= {};
  const locked = !writable || state.busy;
  const option = (value, label = value) => { const node = element(document, 'option', label); node.value = value; return node; };
  const select = (label, choices, value, placeholder) => {
    const node = element(document, 'select'); node.setAttribute('aria-label', label);
    if (placeholder) node.append(option('', placeholder));
    for (const item of choices) node.append(option(item.value ?? item, item.label ?? item));
    node.value = value; node.disabled = locked; return node;
  };
  const resolved = state.value?.runtime?.data?.resolved?.runtime ?? 'claude';
  const target = select(t('wb.config.targetRuntime'), ['claude', 'codex'].map(value => ({ value, label: runtimeName(value) })), state.draft.target ?? resolved);
  const meta = state.meta?.[target.value];
  const start = startingPair(state.value, target.value);
  const modelValue = state.draft.model ?? start.model;
  const choices = modelChoices(meta, modelValue);
  const model = choices?.length ? select(t('wb.config.model'), choices, modelValue, t('wb.config.pickModel')) : element(document, 'input');
  if (!choices?.length) {
    model.value = modelValue; model.placeholder = t('wb.config.model'); model.setAttribute('aria-label', t('wb.config.model')); model.disabled = locked;
  }
  const effortValue = state.draft.effort ?? start.effort;
  const threshold = element(document, 'p', '', 'wb-note wb-cfg-threshold');
  threshold.setAttribute('aria-live', 'polite');
  const showThreshold = () => {
    const selected = model.value.trim() || state.meta?.[target.value]?.current_model;
    const value = selected ? state.meta?.[target.value]?.model_thresholds?.[selected] : target.value === resolved ? rotationThreshold : null;
    threshold.textContent = Number.isFinite(value) ? t('wb.config.modelThreshold', { value }) : t('wb.config.modelThresholdUnknown');
    if (selected && !Number.isFinite(value) && meta) void controller.loadThreshold?.(target.value, selected);
  };
  showThreshold();
  const effort = select(t('wb.term.effort'), effortChoices(meta, model.value, effortValue), effortValue, t('wb.config.pickEffort'));
  target.addEventListener('change', () => {
    state.draft = { ...state.draft, target: target.value, model: undefined, effort: undefined };
    void controller.loadMeta?.(target.value);
    controller.redraw?.();
  });
  const save = element(document, 'button', t('wb.config.save'), 'wb-btn wb-btn-primary wb-btn-sm'); save.type = 'button';
  // Saving writes this group's own pair, so both halves must be chosen on purpose.
  const syncSave = () => { save.disabled = locked || !model.value.trim() || !effort.value; };
  model.addEventListener(choices?.length ? 'change' : 'input', () => {
    state.draft.model = model.value;
    const kept = effort.value;
    const options = effortChoices(meta, model.value, kept);
    effort.replaceChildren(option('', t('wb.config.pickEffort')), ...options.map(value => option(value)));
    effort.value = options.includes(kept) ? kept : '';
    state.draft.effort = effort.value;
    showThreshold(); syncSave();
  });
  effort.addEventListener('change', () => { state.draft.effort = effort.value; syncSave(); });
  syncSave();
  save.addEventListener('click', () => controller.save({ kind: 'model', runtime: target.value, model: model.value, effort: effort.value }));
  const cancel = element(document, 'button', t('wb.cancel'), 'wb-btn wb-btn-sm'); cancel.type = 'button';
  cancel.addEventListener('click', () => { state.draft = {}; onCancel(); });
  const form = element(document, 'div', undefined, 'wb-cfg-edit');
  const pair = element(document, 'div', undefined, 'wb-cfg-controls');
  pair.append(target, model, effort, save, cancel);
  form.append(pair, threshold, element(document, 'p', t('wb.config.pairNote'), 'wb-note'));
  // Less common: which engine this group runs on, and dropping its own model pair.
  const runtime = select(t('wb.term.runtime'), ['inherit', 'claude', 'codex'].map(value => ({ value, label: value === 'inherit' ? t('wb.term.inherit') : runtimeName(value) })),
    state.draft.runtime ?? state.value?.runtime?.data?.desired?.runtime ?? 'inherit');
  runtime.addEventListener('change', () => { state.draft.runtime = runtime.value; });
  const saveRuntime = element(document, 'button', t('wb.config.saveRuntime'), 'wb-btn wb-btn-sm'); saveRuntime.type = 'button'; saveRuntime.disabled = locked;
  saveRuntime.addEventListener('click', () => controller.save({ kind: 'runtime', value: runtime.value }));
  const reset = element(document, 'button', t('wb.config.resetModel'), 'wb-link-btn'); reset.type = 'button'; reset.disabled = locked;
  reset.addEventListener('click', () => controller.save({ kind: 'model', runtime: target.value, reset: true }));
  const more = element(document, 'div', undefined, 'wb-cfg-more');
  more.append(element(document, 'span', t('wb.term.runtime'), 'wb-cfg-label'), runtime, saveRuntime, reset);
  form.append(more);
  root.append(form);
  if (!writable) root.append(element(document, 'p', t('wb.readOnly'), 'wb-note'));
  if (state.result) root.append(element(document, 'p', state.result, 'wb-config-result'));
  if (state.error) root.append(element(document, 'p', state.error, 'wb-config-error'));
}
