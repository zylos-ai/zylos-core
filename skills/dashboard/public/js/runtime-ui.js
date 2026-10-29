export function runtimeLabels(info, t, effortLabel) {
  if (!info) return [];
  if (info.runtime === 'codex') return [
    t('info.runtime_model', { value: info.model || info.model_id || t('info.unknown') }),
    t('info.runtime_effort', { value: info.effort ? effortLabel(info.effort) : t('info.unknown') }),
  ];
  const labels = [];
  if (info.runtime) labels.push(info.runtime.charAt(0).toUpperCase() + info.runtime.slice(1));
  if (info.model) labels.push(info.model.replace(' context', ''));
  if (info.effort) labels.push(effortLabel(info.effort));
  return labels;
}

export function modelOptionState(meta) {
  const models = (meta.models || []).map(model => ({ value: model.id, label: model.display_name || model.id, selected: model.id === meta.current_model }));
  const currentIsListed = models.some(model => model.selected);
  return {
    options: [...(meta.runtime === 'codex' && !meta.current_model ? [{ value: '', labelKey: 'actions.unset', disabled: true, selected: true }] : []), ...models, { value: '__custom__', labelKey: 'actions.custom' }],
    custom: Boolean(meta.current_model && !currentIsListed),
    customValue: currentIsListed ? '' : meta.current_model || '',
  };
}

export function effortOptionState(meta, modelId, currentEffort = meta.current_effort) {
  const list = meta.efforts_by_model?.[modelId] || meta.efforts_by_model?.['*'] || [];
  const unavailable = meta.runtime === 'codex' && !list.includes(currentEffort);
  return {
    hidden: !list.length && meta.runtime !== 'codex',
    disabled: !list.length,
    options: [
      ...(unavailable ? [{ value: '', labelKey: currentEffort ? 'actions.effort_unavailable' : 'actions.unset', labelParams: currentEffort ? { value: currentEffort } : undefined, disabled: true, selected: true }] : []),
      ...list.map(value => ({ value, selected: value === currentEffort })),
    ],
  };
}

export async function submitSelectAction(select, action, key, execute) {
  if (select._inFlight) return false;
  const previous = select._prevValue ?? select.value;
  const value = select.value;
  if (!value || value === previous) return false;
  select._inFlight = true;
  try {
    const accepted = await execute(action, { [key]: value });
    if (accepted === false) select.value = previous;
    else select._prevValue = value;
    return accepted;
  } finally {
    select._inFlight = false;
  }
}

export function mergeRuntimeInfo(previousState, nextState) {
  const previous = previousState?.runtime_info;
  if (nextState.runtime_info || !previous) return nextState.runtime_info || null;
  const previousSession = previousState?.sessionId ?? previousState?.session?.session_id;
  const previousRun = previousState?.runId ?? previousState?.run_id;
  const nextSession = nextState?.sessionId ?? nextState?.session?.session_id;
  const nextRun = nextState?.runId ?? nextState?.run_id;
  return nextSession !== previousSession || nextRun !== previousRun
    ? { ...previous, runtime: nextState.runtime || 'unknown', model: null, model_id: null, effort: null, service_tier: null }
    : previous;
}
