export function actionFailureMessage(action, runtimeLabel, error, t) {
  return action === 'upgrade-cc'
    ? t('result.runtime_upgrade_unknown', { runtime: runtimeLabel }) : t('status.failed', { error: error.message });
}

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
  return lines.join('\n') || result?.error?.message || result?.message || null;
}

// One notice and timeout per control. A retry or machine change invalidates the previous feedback.
export function createActionFeedback(status, sync, onSuccessExpired = () => {}) {
  let timer, activeButton, current;
  function clear() {
    clearTimeout(timer);
    status.textContent = '';
  }
  function unlock() {
    activeButton?.removeAttribute('aria-busy');
    activeButton = null;
  }
  return {
    start(button) {
      if (activeButton) return null;
      clear();
      activeButton = button;
      button.setAttribute('aria-busy', 'true');
      sync();
      const feedback = {
        isCurrent: () => current === feedback,
        show(text, success) {
          if (!feedback.isCurrent()) return;
          clear();
          unlock();
          status.classList.toggle('wb-status-success', success);
          status.classList.toggle('wb-status-error', !success);
          status.textContent = text;
          sync();
          if (success) timer = setTimeout(() => {
            clear();
            onSuccessExpired();
            sync();
          }, 5000);
        },
      };
      current = feedback;
      return feedback;
    },
    reset() {
      current = null;
      clear();
      unlock();
    },
  };
}
