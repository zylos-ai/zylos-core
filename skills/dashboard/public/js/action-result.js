export function formatActionResult(result, t) {
  let summary = null;
  if (result?.messageKey) {
    const translated = t(result.messageKey, result.messageParams);
    if (translated !== result.messageKey) summary = translated;
  }
  const lines = summary ? [summary] : [];
  for (const [index, step] of (result?.steps || []).entries()) {
    const params = {
      index: index + 1,
      id: Number.isSafeInteger(step.controlId) ? step.controlId : t('value.unknown'),
      submission: t(`actions.submission_${step.submission || 'unknown'}`),
      code: step.rejectionCode || t('value.unknown'),
    };
    lines.push(t(step.submission === 'rejected' ? 'result.control_step_rejected' : 'result.control_step', params));
  }
  return lines.join('\n') || result?.message || null;
}
