import { element, icon, runtimeName } from './plain-text.js';

export function responseError(value, fallback = 'request_failed') {
  const error = value?.error;
  return typeof error === 'string' ? error : [...new Set([error?.code, error?.message].filter(Boolean))].join(' · ') || fallback;
}

export async function fetchJson(fetch, path, options = {}) {
  const response = await fetch(path, options);
  let value;
  try { value = await response.json(); }
  catch { throw Object.assign(new Error('non_json'), { unknown: true }); }
  if (!response.ok) throw Object.assign(new Error(responseError(value)), { body: value, status: response.status });
  return value;
}

// running is null without a comparison: a pre-migration instance (sessionMode null) uses its
// baseline; a model pair for another runtime is kept; in native single only Origin runs, so
// other groups show the configuration they will use after switching back to multi.
export function runningText(data, kind, t = key => key) {
  if (data?.running == null && data?.sessionMode === null) return t('wb.config.single');
  if (data?.running == null && kind === 'model' && data?.runtime !== data?.resolved?.runtime) return t('wb.config.otherRuntime');
  if (data?.running == null && data?.sessionMode === 'single' && data?.sessionGroup !== 'origin') {
    const resolved = data?.resolved;
    const config = [runtimeName(resolved?.runtime), resolved?.model, resolved?.effort].filter(Boolean).join(' · ');
    return t('wb.config.afterMulti', { config });
  }
  const running = data?.running;
  if (running?.status === 'unknown') return t('wb.config.unknown', { reason: running.reason ?? '' });
  return t('wb.config.' + ({ not_running: 'nextStart', pending: 'pending', applied: 'applied' }[running?.status] ?? 'resultUnknown'));
}

function restartText(restart, t) {
  if (restart.status === 'accepted') return t('wb.actions.accepted');
  const key = restart.status === 'unknown' ? 'wb.actions.unknown' : 'wb.actions.notSubmitted';
  return t(key) + (restart.reason ? ' · ' + restart.reason : '');
}

export function validConfigChange(change) {
  return change?.kind === 'runtime' ? ['inherit', 'claude', 'codex', 'agy'].includes(change.value)
    : change?.kind === 'model' && ['claude', 'codex'].includes(change.runtime) &&
      (change.reset === true || (typeof change.model === 'string' && change.model.trim() !== '' &&
        typeof change.effort === 'string' && change.effort.trim() !== ''));
}

export function createGroupConfig({ key, request, onChange = () => {}, t = key => key, active = () => true }) {
  const state = { value: null, result: '', restartResult: '', error: null, busy: false, meta: {} };
  const publish = () => { if (active()) onChange(state); };
  const thresholdRequests = new Set();
  let confirming = false;
  async function loadThreshold(runtime, model) {
    if (!model || !['claude', 'codex', 'agy'].includes(runtime) || Number.isFinite(state.meta[runtime]?.model_thresholds?.[model])) return;
    const id = runtime + ':' + model;
    if (thresholdRequests.has(id)) return;
    thresholdRequests.add(id);
    try {
      const value = await request('/api/instance/runtime-options?' + new URLSearchParams({ runtime, model }));
      if (!active() || !value?.model_thresholds) return;
      state.meta[runtime] = { ...state.meta[runtime], ...value, model_thresholds: { ...state.meta[runtime]?.model_thresholds, ...value.model_thresholds } };
      publish();
    } catch { /* Keep the threshold explicitly unknown until the editor is opened again. */ }
  }
  // The editor accepts a typed model when the catalog is unavailable.
  async function loadMeta(runtime) {
    if (!['claude', 'codex', 'agy'].includes(runtime) || runtime in state.meta) return state.meta[runtime];
    state.meta[runtime] = undefined;
    let value = null;
    try { value = await request('/api/instance/runtime-options?runtime=' + runtime); } catch {}
    if (!active()) return null;
    state.meta[runtime] = Array.isArray(value?.models) ? value : null;
    publish();
    return state.meta[runtime];
  }
  async function load(detail) {
    detail ??= await request('/api/groups/' + encodeURIComponent(key));
    const value = detail.config;
    if (active()) {
      state.value = value;
      state.error = detail.configError ? responseError({ error: detail.configError }) : value == null ? t('wb.readFailed')
        : value.runtime?.ok === false ? responseError(value.runtime) : value.model?.ok === false ? responseError(value.model) : null;
      publish();
    }
    return value;
  }
  return {
    state, load, loadMeta, loadThreshold, redraw: publish,
    async save(changes, { confirm } = {}) {
      if (!active() || confirming || state.busy || !changes.length) return;
      if (!changes.every(validConfigChange)) {
        state.error = t('wb.config.pairRequired');
        publish();
        return;
      }
      if (confirm) {
        confirming = true;
        try {
          if (!await confirm() || !active()) return;
        } finally { confirming = false; }
      }
      state.busy = true;
      state.error = null;
      state.result = '';
      state.restartResult = '';
      publish();
      try {
        let last;
        for (const change of changes) {
          let result;
          try {
            result = await request(`/api/groups/${encodeURIComponent(key)}/config`, {
              method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(confirm ? { ...change, confirmed: true } : change),
            });
          } catch (error) {
            if (error.name === 'AbortError' || !active()) return;
            result = error.body ?? { unknown: true };
          }
          if (!active()) return;
          const setting = t(change.kind === 'runtime' ? 'wb.term.runtime' : 'wb.config.model');
          const unknown = result?.unknown === true || typeof result?.ok !== 'boolean';
          if (unknown) {
            // Check the saved settings once after a lost reply, with no second write.
            try { await load(); } catch { /* Keep the previously confirmed settings visible. */ }
            if (active()) state.error = t('wb.config.saveUncertain', { setting });
            return;
          }
          if (result.ok !== true) {
            state.error = t('wb.config.saveFailed', { setting, reason: responseError(result) });
            return;
          }

          const data = result.data ?? result;
          if (data.restart) state.restartResult = restartText(data.restart, t);
          last = { data, kind: change.kind };
          rememberWrite(state, change, result);
          state.result = t(change.kind === 'model' ? 'wb.config.modelSaved'
            : change.value === 'inherit' ? 'wb.config.followGlobalSaved' : 'wb.config.runtimeSaved');
          // If the effective engine changed elsewhere, Core may report a
          // restart on the first write. Leave the remaining draft for review.
          if (data.restart && change !== changes.at(-1)) return;
        }

        const followsGlobal = changes.some(change => change.kind === 'runtime' && change.value === 'inherit');
        const saved = t(followsGlobal ? 'wb.config.followGlobalSaved' : 'wb.config.saved');
        state.result = saved;
        if (!state.restartResult) state.result += ' · ' + runningText(last.data, last.kind, t);
      } finally {
        if (active()) { state.busy = false; publish(); }
      }
    },
  };
}

// Keep each successful write as the editor's baseline, including when the next write fails.
function rememberWrite(state, change, result) {
  const desired = result.data?.desired ?? (change.kind === 'runtime'
    ? { runtime: change.value }
    : { runtime: change.runtime, mode: change.reset ? 'default' : 'override', model: change.model, effort: change.effort });
  const envelope = { ...result, data: { ...result.data, desired } };
  state.value = { ...state.value, [change.kind]: envelope };
  if (change.kind === 'model' && Array.isArray(state.value.modelOverrides)) {
    const overrides = state.value.modelOverrides.filter(item => item.runtime !== change.runtime);
    if (desired.mode === 'override') overrides.push(desired);
    state.value.modelOverrides = overrides;
  }
}

export function configSummary(value) {
  const runtime = value?.runtime?.data?.resolved;
  if (!runtime) return '';
  return [runtime.runtime, runtime.model, runtime.effort].filter(Boolean).join(' · ');
}

function modelChoices(meta, current) {
  const list = (meta?.models ?? []).map(item => ({ value: item.id, label: item.display_name ?? item.id }));
  if (current && !list.some(item => item.value === current)) list.unshift({ value: current, label: current });
  return list;
}
export function effortChoices(meta, model, current) {
  const listed = meta?.efforts_by_model?.[model] ?? meta?.efforts_by_model?.['*'];
  const list = listed?.length ? [...listed] : ['low', 'medium', 'high'];
  if (current && !list.includes(current)) list.push(current);
  return list;
}

function savedPair(value, runtime) {
  if (runtime === 'agy') return { model: '', effort: '' };
  const envelope = value?.model;
  const data = envelope?.data;
  const hasCurrentPair = envelope?.ok !== false && (data?.runtime ?? data?.desired?.runtime) === runtime && Boolean(runtime);
  const pair = hasCurrentPair ? (data.desired?.mode === 'override' ? data.desired : null)
    : value?.modelOverrides?.find(item => item.runtime === runtime);
  if (!hasCurrentPair && !Array.isArray(value?.modelOverrides)) return null;
  return { model: pair?.model ?? '', effort: pair?.effort ?? '' };
}

export function renderGroupConfig(root, controller, { document = root.ownerDocument, t = key => key, writable = true,
  defaultRuntime, rotationThreshold = null, onSave = controller.save, onCancel = () => {} } = {}) {
  const { state } = controller;
  state.draft ??= {};
  const engine = state.value?.runtime;
  const ready = Boolean(engine?.data && engine.ok !== false);
  const locked = !writable || state.busy || !ready;
  const option = (value, label = value) => { const node = element(document, 'option', label); node.value = value; return node; };
  const select = (label, choices, value) => {
    const node = element(document, 'select', undefined, 'wb-input wb-select');
    node.setAttribute('aria-label', label);
    for (const item of choices) node.append(option(item.value ?? item, item.label ?? item));
    node.value = value;
    return node;
  };
  const field = (label, control) => {
    const wrapper = element(document, 'label', undefined, 'wb-cfg-field');
    wrapper.append(element(document, 'span', label, 'wb-cfg-label'));
    if (control.tagName === 'SELECT') {
      const selectWrap = element(document, 'span', undefined, 'wb-select-wrap');
      selectWrap.append(control, icon(document, 'chev', 'xs'));
      wrapper.append(selectWrap);
    } else {
      wrapper.append(control);
    }
    return wrapper;
  };
  const savedRuntime = engine?.data?.desired?.runtime ?? 'inherit';
  const runtimeLabel = t('wb.term.runtime');
  const runtime = select(runtimeLabel, ['inherit', 'claude', 'codex', 'agy'].map(value => ({
    value, label: value === 'inherit' ? t('wb.config.followGlobal') : runtimeName(value),
  })), state.draft.runtime ?? savedRuntime);
  runtime.disabled = locked;
  const resolved = engine?.data?.resolved?.runtime;
  const target = runtime.value === 'inherit' ? defaultRuntime ?? (savedRuntime === 'inherit' ? resolved : null) : runtime.value;
  const start = savedPair(state.value, target);
  const meta = state.meta[target];
  const modelLabel = t('wb.config.model');
  const effortLabel = t('wb.term.effort');
  const pairLocked = locked || target === 'agy' || start == null;
  const draft = state.draft.modelRuntime === target ? state.draft : {};
  const manualModel = start != null && target !== 'agy' && !meta?.models?.length;
  const modelValue = draft.model ?? start?.model ?? '';
  const model = manualModel ? element(document, 'input') : select(modelLabel, [
    { value: '', label: t(start == null ? 'wb.unknown' : 'wb.config.followGlobal') },
    ...modelChoices(target === 'agy' ? null : meta, modelValue),
  ], modelValue);
  if (manualModel) {
    model.type = 'text';
    model.value = modelValue;
    model.placeholder = t('wb.config.followGlobal');
    model.setAttribute('aria-label', modelLabel);
  }
  model.disabled = pairLocked;
  const modelId = () => model.value.trim() ? model.value : '';
  const effortOptions = (modelId, current) => [
    option('', t('wb.config.pickEffort')),
    ...(modelId ? effortChoices(meta, modelId, current).map(value => option(value)) : []),
  ];
  const effort = select(effortLabel, [], '');
  const setEffort = value => {
    effort.replaceChildren(...effortOptions(modelId(), value));
    effort.value = value;
    effort.disabled = pairLocked || !modelId();
  };
  setEffort(draft.effort ?? start?.effort ?? '');
  if (ready && target !== 'agy') void controller.loadMeta(target);

  const threshold = element(document, 'p', '', 'wb-note wb-cfg-threshold');
  threshold.setAttribute('aria-live', 'polite');
  const showThreshold = () => {
    const selected = modelId() || meta?.current_model;
    const value = selected ? state.meta[target]?.model_thresholds?.[selected] : target === resolved ? rotationThreshold : null;
    threshold.textContent = Number.isFinite(value) ? t('wb.config.modelThreshold', { value }) : t('wb.config.modelThresholdUnknown');
    if (selected && !Number.isFinite(value) && meta) void controller.loadThreshold(target, selected);
  };
  if (target !== 'agy') showThreshold();

  const changes = () => {
    const edits = [];
    const selected = modelId();
    if (runtime.value !== savedRuntime) edits.push({ kind: 'runtime', value: runtime.value });
    if (!pairLocked && (selected !== start.model || (selected && effort.value !== start.effort))) {
      edits.push(selected ? { kind: 'model', runtime: target, model: selected, effort: effort.value }
        : { kind: 'model', runtime: target, reset: true });
    }
    // Save the setting that can restart the group last. A model for an inactive
    // engine is staged first, while an engine preference with the same effective
    // engine can be saved before updating that engine's model.
    return edits.length === 2 && target !== resolved ? edits.reverse() : edits;
  };
  const save = element(document, 'button', t('wb.config.save'), 'wb-btn wb-btn-primary wb-btn-sm');
  save.type = 'button';
  const syncSave = () => {
    const edits = changes();
    save.disabled = locked || edits.length === 0 || !edits.every(validConfigChange);
  };
  const rememberPair = () => { Object.assign(state.draft, { modelRuntime: target, model: modelId(), effort: effort.value }); };
  runtime.addEventListener('change', () => {
    state.draft = { runtime: runtime.value };
    controller.redraw();
  });
  model.addEventListener(manualModel ? 'input' : 'change', () => {
    const selected = modelId();
    const kept = selected && effortChoices(meta, selected).includes(effort.value) ? effort.value : '';
    setEffort(kept);
    rememberPair(); showThreshold(); syncSave();
  });
  effort.addEventListener('change', () => { rememberPair(); syncSave(); });
  syncSave();
  save.addEventListener('click', () => { if (!save.disabled) void onSave(changes()); });
  const cancel = element(document, 'button', t('wb.cancel'), 'wb-btn wb-btn-sm');
  cancel.type = 'button';
  cancel.disabled = state.busy;
  cancel.addEventListener('click', () => { state.draft = {}; onCancel(); });

  const form = element(document, 'div', undefined, 'wb-cfg-edit');
  const engineRow = element(document, 'div', undefined, 'wb-cfg-controls wb-cfg-engine');
  engineRow.append(field(runtimeLabel, runtime));
  const modelRow = element(document, 'div', undefined, 'wb-cfg-controls wb-cfg-model');
  modelRow.append(field(modelLabel, model), field(effortLabel, effort));
  const actions = element(document, 'div', undefined, 'wb-cfg-controls wb-cfg-actions');
  actions.append(save, cancel);
  form.append(engineRow, modelRow, target === 'agy'
    ? element(document, 'p', t('wb.config.modelUnavailable'), 'wb-note') : threshold, actions);
  root.append(form);
  if (!writable) root.append(element(document, 'p', t('wb.readOnly'), 'wb-note'));
  const feedback = element(document, 'div');
  feedback.setAttribute('role', 'status');
  if (state.result) feedback.append(element(document, 'p', state.result, 'wb-config-result'));
  if (state.restartResult) feedback.append(element(document, 'p', state.restartResult, 'wb-config-result'));
  root.append(feedback);
  if (state.error) root.append(element(document, 'p', state.error, 'wb-config-error'));
}
