import { createActionRunner } from './action-runner.js?v=1';

/** The question the page asks before an action that changes the running agent. */
export function actionConfirmText(action, body, { t, runtime = null, effortLabel = value => value }) {
  const labels = {
    'switch-mode': () => t('confirm.switch_mode', { mode: body?.mode }),
    'restart-session': () => t('confirm.restart'),
    'switch-runtime': () => body?.runtime === 'codex' ? t('confirm.switch_runtime_codex') : t('confirm.switch_runtime', { value: body?.runtime }),
    'switch-model': () => t('confirm.switch_model', { value: body?.model }),
    'switch-effort': () => t('confirm.switch_effort', { value: effortLabel(body?.effort) }),
    'upgrade-zylos': () => t('confirm.upgrade_zylos'),
    'upgrade-cc': () => runtime === 'codex' ? t('confirm.upgrade_codex') : t('confirm.upgrade_cc'),
  };
  return labels[action]?.() || t('confirm.fallback', { action });
}

/**
 * A manual restart names the session the page is showing (group, run and session), so Core refuses it when
 * that session has changed in the meantime. Other actions are sent as they are.
 */
export function prepareAction(action, body, shown) {
  if (action !== 'restart-session') return body;
  return { ...body, sessionGroup: shown?.sessionGroup, runId: shown?.runId, sessionId: shown?.sessionId };
}

/**
 * The page's actions, built on the action runner: `exec` asks first for actions that change the running agent
 * (with the question above, naming the remote machine when one is viewed) and prepares a manual restart with the
 * session shown at that moment; `runConfirmed` is for changes a card has already confirmed. `send` is the only
 * thing that reaches the server, and only these two call it.
 */
export function createPageActions({ t, send, confirm, readOnly, remoteTarget, shownSession, runtime = () => null, effortLabel }) {
  return createActionRunner({
    t, send, confirm, readOnly, remoteTarget,
    confirmText: (action, body) => actionConfirmText(action, body, { t, runtime: runtime(), effortLabel }),
    prepare: (action, body) => prepareAction(action, body, shownSession()),
  });
}

/**
 * Connects the session controls (mode and CLI upgrade) to the page actions. Every change goes
 * through `actions.exec`, so the ones that change the running agent are asked first.
 * - `onModeSettled()` runs after a mode change finished or was cancelled (a cancelled change restores the mode).
 */
export function bindActionControls(root, actions, { onModeSettled = () => {} } = {}) {
  root.querySelector('[data-action="upgrade-cc"]').addEventListener('click', () => actions.exec('upgrade-cc'));

  const modeSelect = root.querySelector('#action-mode');
  async function changeMode(mode) {
    const previous = modeSelect._current ?? null;
    if (await actions.exec('switch-mode', { mode }) === false && previous) modeSelect.value = previous;
    await onModeSettled();
  }
  modeSelect.addEventListener('change', event => changeMode(event.target.value));
  // The segmented buttons set the original select, which stays the one place the mode is read from.
  root.querySelectorAll('#action-mode-seg button').forEach(button => button.addEventListener('click', () => {
    if (button.disabled || modeSelect.value === button.dataset.mode) return undefined;
    modeSelect.value = button.dataset.mode;
    return changeMode(button.dataset.mode);
  }));


}
