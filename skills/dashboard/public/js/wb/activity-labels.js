export function stepText(step, t = key => key) {
  const label = step.label ?? { key: 'tool' };
  if (label.key === 'described') return label.arg ?? t('chat.activity.label.runCommand');
  const text = t(`chat.activity.label.${label.key}`);
  const base = text.replace('{arg}', () => label.arg ?? '');
  return label.more ? t(`chat.activity.label.more.${label.more}`, { count: label.count, first: base }) : base;
}

const stepDuration = step => step.end == null ? null : Math.max(0, step.end - step.start);

export function mergeActivitySteps(steps, t) {
  const rows = [];
  for (const step of steps) {
    const last = rows.at(-1);
    if (step.kind === 'tool' && last?.kind === 'tool' && step.status !== 'running' &&
        step.status === last.status && step.event?.run_id === last.event?.run_id && stepText(step, t) === stepText(last, t)) {
      last.count = (last.count ?? 1) + 1;
      const prior = last.duration ?? stepDuration(last), current = step.duration ?? stepDuration(step);
      if (prior != null || current != null) last.duration = (prior ?? 0) + (current ?? 0);
    } else rows.push({ ...step });
  }
  return rows;
}
