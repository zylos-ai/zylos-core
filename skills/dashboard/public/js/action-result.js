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
export function createActionFeedback(status, sync) {
  let timer, activeButton, current, busy = false;
  function clear() {
    clearTimeout(timer);
    status.textContent = '';
  }
  function setBusy(value) {
    busy = value;
    if (value) activeButton.setAttribute('aria-busy', 'true');
    else activeButton?.removeAttribute('aria-busy');
  }
  function unlock() {
    setBusy(false);
    activeButton = null;
  }
  return {
    get busy() { return busy; },
    get pending() { return Boolean(activeButton); },
    start(button) {
      if (activeButton) return null;
      clear();
      activeButton = button;
      setBusy(true);
      sync();
      const feedback = {
        isCurrent: () => current === feedback,
        resume() {
          if (!feedback.isCurrent() || !activeButton) return false;
          setBusy(true);
          sync();
          return true;
        },
        show(text, success, { awaitingConfirmation = false } = {}) {
          if (!feedback.isCurrent()) return;
          clear();
          if (awaitingConfirmation) setBusy(false);
          else unlock();
          status.classList.toggle('wb-status-success', success);
          status.classList.toggle('wb-status-error', !success);
          status.textContent = text;
          sync();
          if (success && !awaitingConfirmation) timer = setTimeout(() => { clear(); sync(); }, 5000);
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
