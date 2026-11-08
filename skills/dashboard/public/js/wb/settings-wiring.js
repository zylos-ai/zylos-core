import { confirmDialog } from './detail.js?v=99';

/**
 * Connects the settings page and the key table to the dashboard's own confirmation dialog.
 * Every change these components make goes through one of the confirmations built here;
 * the components themselves refuse to act when no confirmation is given.
 */
export function wireSettingsConfirmations({ document, t, execute, remoteTarget = () => null, setBusy = () => {}, keyActions, writable, onGroup }) {
  const confirm = (body, { title = t('wb.settings.confirmTitle'), ok = t('btn.confirm'), danger = true } = {}) =>
    confirmDialog(document, { title, body, ok, cancel: t('btn.cancel'), danger });
  // Default-setting changes name the remote machine they act on and keep the page locked while asking.
  async function confirmChange(text) {
    const target = remoteTarget();
    setBusy(true);
    try { return await confirm(target ? `${text}\n${t('confirm.remote_target', { agent: target })}` : text); }
    finally { setBusy(false); }
  }
  return {
    confirm,
    /** Options for the default-settings card: it confirms all of its changes once, then runs them without asking again. */
    defaults: (value, read) => ({ ...value, t, read, writable, onGroup, confirm: confirmChange,
      execute: (action, body, { confirmed = false } = {}) => execute(action, body, { confirmed }) }),
    /** Options for the key table: rotating, revoking and deleting each ask first. */
    keyTable: () => ({ t, confirm, onAction: (action, name) => keyActions[action](name) }),
  };
}
