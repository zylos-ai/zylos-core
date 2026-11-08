/** Dashboard actions that change the running agent, so the page asks before running them. */
export const CONFIRM_ACTIONS = new Set(['switch-mode', 'restart-session', 'switch-runtime', 'switch-model', 'switch-effort', 'upgrade-zylos', 'upgrade-cc']);

/**
 * The page's action runner.
 * - `exec(action, body)` asks first for the actions above, naming the remote machine when one is being viewed,
 *   and sends nothing when the answer is no.
 * - `runConfirmed(action, body)` is for changes a card has already confirmed itself; it never asks.
 * Neither sends anything while the viewed machine was reached with a read-only key (or the page has not said).
 */
export function createActionRunner({ t, send, confirm, confirmText, readOnly = () => true, remoteTarget = () => null, prepare = (_action, body) => body }) {
  async function runConfirmed(action, body) {
    if (readOnly()) return false;
    return send(action, body);
  }
  async function exec(action, body) {
    if (readOnly()) return false;
    body = prepare(action, body);
    if (CONFIRM_ACTIONS.has(action)) {
      const text = confirmText(action, body), target = remoteTarget();
      if (!(await confirm(target ? `${text}\n${t('confirm.remote_target', { agent: target })}` : text))) return false;
    }
    return runConfirmed(action, body);
  }
  return { exec, runConfirmed };
}
