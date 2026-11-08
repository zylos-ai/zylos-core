import { confirmDialog } from './detail.js?v=100';
import { renderKeyTable } from './settings-access.js?v=99';
import { renderDefaults } from './settings-defaults.js?v=99';

/** The executor the default-settings card gets: it runs an action only when the card says it was confirmed. */
export function confirmedRunner(run) {
  return (action, body, { confirmed = false } = {}) => (confirmed === true ? run(action, body) : Promise.resolve(false));
}

/**
 * Connects the settings page and the key table to the dashboard's own confirmation dialog, and renders them.
 * Every change these components make goes through one of the confirmations built here; the components
 * themselves refuse to act when no confirmation is given, and the page code never passes one in itself.
 *
 * `run(action, body)` performs a dashboard action without asking: it is called only after the
 * default-settings card has confirmed the change, so nothing is ever asked twice or run unasked.
 */
export function wireSettingsConfirmations({ document, t, run, remoteTarget = () => null, setBusy = () => {}, keyActions, writable, onGroup }) {
  const confirm = (body, { title = t('wb.settings.confirmTitle'), ok = t('btn.confirm'), danger = true } = {}) =>
    confirmDialog(document, { title, body, ok, cancel: t('btn.cancel'), danger });
  // Default-setting changes name the remote machine they act on and keep the page locked while asking.
  async function confirmChange(text) {
    const target = remoteTarget();
    setBusy(true);
    try { return await confirm(target ? `${text}\n${t('confirm.remote_target', { agent: target })}` : text); }
    finally { setBusy(false); }
  }
  const execute = confirmedRunner(run);
  const keyTableOptions = () => ({ t, confirm, onAction: (action, name) => keyActions[action](name) });
  const defaultsOptions = (value, read) => ({ ...value, t, read, writable, onGroup, confirm: confirmChange, execute });
  return {
    confirm,
    /** The key table: rotating, revoking and deleting each ask first. */
    renderKeyTable: (root, keys) => renderKeyTable(root, keys, keyTableOptions()),
    /** The default-settings card: it confirms all of its changes once, then runs them without asking again. */
    renderDefaults: (root, value, read) => renderDefaults(root, defaultsOptions(value, read)),
  };
}
