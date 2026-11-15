export function modelOptionState(meta) {
  const models = (meta.models || []).map(model => ({ value: model.id, label: model.display_name || model.id, selected: model.id === meta.current_model }));
  const currentIsListed = models.some(model => model.selected);
  return {
    options: [...(meta.runtime === 'codex' && !meta.current_model ? [{ value: '', labelKey: 'actions.unset', disabled: true, selected: true }] : []), ...models, { value: '__custom__', labelKey: 'actions.custom' }],
    custom: Boolean(meta.current_model && !currentIsListed),
    customValue: currentIsListed ? '' : meta.current_model || '',
  };
}

export function effortOptionState(meta, modelId, currentEffort = meta.current_effort, effortLabel = value => value) {
  const list = meta.efforts_by_model?.[modelId] || meta.efforts_by_model?.['*'] || [];
  const unavailable = meta.runtime === 'codex' && !list.includes(currentEffort);
  return {
    hidden: !list.length && meta.runtime !== 'codex',
    disabled: !list.length,
    options: [
      ...(unavailable ? [{ value: '', labelKey: currentEffort ? 'actions.effort_unavailable' : 'actions.unset', labelParams: currentEffort ? { value: effortLabel(currentEffort) } : undefined, disabled: true, selected: true }] : []),
      ...list.map(value => ({ value, selected: value === currentEffort })),
    ],
  };
}
