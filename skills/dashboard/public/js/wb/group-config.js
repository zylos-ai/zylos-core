import { element } from './plain-text.js?v=85';

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
  const state = { value: null, result: '', error: null, busy: false };
  const publish = () => { if (active()) onChange(state); };
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
    state, load,
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

export function renderGroupConfig(root, controller, { document = root.ownerDocument, t = key => key, writable = true } = {}) {
  root.replaceChildren();
  const { state } = controller;
  state.draft ??= {};
  const runtime = element(document, 'select');
  for (const value of ['inherit', 'claude', 'codex']) {
    const option = element(document, 'option', value === 'inherit' ? t('wb.term.inherit') : value);
    option.value = value;
    runtime.append(option);
  }
  runtime.value = state.draft.runtime ?? state.value?.runtime?.data?.desired?.runtime ?? 'inherit';
  runtime.addEventListener('change', () => { state.draft.runtime = runtime.value; });
  runtime.disabled = !writable || state.busy;
  const saveRuntime = element(document, 'button', t('wb.config.saveRuntime'));
  saveRuntime.type = 'button';
  saveRuntime.disabled = runtime.disabled;
  saveRuntime.addEventListener('click', () => controller.save({ kind: 'runtime', value: runtime.value }));
  const target = element(document, 'select');
  for (const value of ['claude', 'codex']) {
    const option = element(document, 'option', value); option.value = value; target.append(option);
  }
  target.value = state.draft.target ?? state.value?.runtime?.data?.resolved?.runtime ?? 'claude';
  target.addEventListener('change', () => { state.draft.target = target.value; });
  const model = element(document, 'input'), effort = element(document, 'input');
  model.placeholder = t('wb.config.model'); effort.placeholder = t('wb.term.effort');
  model.setAttribute('aria-label', t('wb.config.model')); effort.setAttribute('aria-label', t('wb.term.effort'));
  const desired = state.value?.model?.data?.desired;
  model.value = state.draft.model ?? desired?.model ?? ''; effort.value = state.draft.effort ?? desired?.effort ?? '';
  model.addEventListener('input', () => { state.draft.model = model.value; });
  effort.addEventListener('input', () => { state.draft.effort = effort.value; });
  const saveModel = element(document, 'button', t('wb.config.saveModel'));
  saveModel.type = 'button';
  const reset = element(document, 'button', t('wb.config.resetModel')); reset.type = 'button';
  for (const node of [target, model, effort, saveModel, reset]) node.disabled = !writable || state.busy;
  saveModel.addEventListener('click', () => controller.save({ kind: 'model', runtime: target.value, model: model.value, effort: effort.value }));
  reset.addEventListener('click', () => controller.save({ kind: 'model', runtime: target.value, reset: true }));
  root.append(element(document, 'p', t('wb.config.oneAtATime')), runtime, saveRuntime, target, model, effort, saveModel, reset);
  if (!writable) root.append(element(document, 'p', t('wb.readOnly')));
  if (state.result) root.append(element(document, 'p', state.result, 'wb-config-result'));
  if (state.error) root.append(element(document, 'p', state.error, 'wb-config-error'));
}
