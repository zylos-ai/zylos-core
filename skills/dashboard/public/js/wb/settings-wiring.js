import { confirmDialog } from './detail.js?v=112';
import { renderKeyTable } from './settings-access.js?v=103';
import { renderDefaults } from './settings-defaults.js?v=112';

/** The executor the default-settings card gets: it runs an action only when the card says it was confirmed. */
export function confirmedRunner(run) {
  return (action, body, { confirmed = false } = {}) => (confirmed === true ? run(action, body) : Promise.resolve(false));
}

/**
 * What each key-table action sends. Revoking keeps the key listed (it can still be deleted later); deleting removes
 * it for good; rotating replaces it with a new key that is shown once. `status` names the messages for the page.
 */
export function keyActionRequest(action, name) {
  const path = `/api/keys/${encodeURIComponent(name)}`;
  if (action === 'rotate') return { method: 'POST', path: `${path}/rotate`, showsNewKey: true,
    status: { running: 'fleet_manage.rotating_key', failed: 'fleet_manage.rotate_failed', done: 'fleet_manage.key_rotated_status' } };
  if (action === 'revoke') return { method: 'DELETE', path,
    status: { running: 'fleet_manage.revoking_key', failed: 'fleet_manage.revoke_failed', done: 'fleet_manage.key_revoked_status' } };
  if (action === 'delete') return { method: 'DELETE', path: `${path}?permanent=1`,
    status: { running: 'fleet_manage.deleting_key', failed: 'fleet_manage.delete_failed', done: 'fleet_manage.key_deleted_status' } };
  return null;
}

/**
 * Connects the settings page and the key table to the dashboard's own confirmation dialog, and renders them.
 * Every change these components make goes through one of the confirmations built here; the components
 * themselves refuse to act when no confirmation is given, and the page code never passes one in itself.
 *
 * - `runner` is the page's action runner (`createActionRunner`): the default-settings card gets its
 *   `runConfirmed`, and only once the card has confirmed the change, so nothing is asked twice or run unasked.
 * - `keyPage` is how key requests reach the server and the page: `request(method, path)` resolves to
 *   `{ ok, data }`; `renderKeys(data)`, `renderCreated(key | null)` (the new key shown once), `createdKey()`
 *   (the one shown now, or null), `status(text, kind)`, `busy(on)` and `errorText(code, fallback)`. The page
 *   decides nothing about which request an action makes or what its answer shows.
 */
export function wireSettingsConfirmations({ document, t, runner, keyPage, remoteTarget = () => null, setBusy = () => {}, writable, onGroup }) {
  const confirm = (body, { title = t('wb.settings.confirmTitle'), ok = t('btn.confirm'), danger = true } = {}) =>
    confirmDialog(document, { title, body, ok, cancel: t('btn.cancel'), danger });
  // Default-setting changes name the remote machine they act on and keep the page locked while asking.
  async function confirmChange(text) {
    const target = remoteTarget();
    setBusy(true);
    try { return await confirm(target ? `${text}\n${t('confirm.remote_target', { agent: target })}` : text); }
    finally { setBusy(false); }
  }
  const execute = confirmedRunner((action, body) => runner.runConfirmed(action, body));
  // Sends one key request. Rotating shows the new key once, and first asks before replacing a key still shown.
  async function sendKeyRequest(request, name) {
    const shown = keyPage.createdKey()?.name;
    if (request.showsNewKey && shown && !(await confirm(t('fleet_manage.replace_created_key_confirm', { name: shown }), { danger: false }))) return;
    keyPage.busy(true);
    keyPage.status(t(request.status.running), 'running');
    try {
      const { ok, data } = await keyPage.request(request.method, request.path);
      if (!ok) throw new Error(keyPage.errorText(data?.error, t(request.status.failed)));
      keyPage.renderKeys(data);
      if (request.showsNewKey) keyPage.renderCreated({ name: data.key?.name || name, plaintext_key: data.plaintext_key });
      else if (keyPage.createdKey()?.name === name) keyPage.renderCreated(null);
      keyPage.status(t(request.status.done), 'success');
    } catch (err) {
      keyPage.status(err.message, 'error');
    } finally {
      keyPage.busy(false);
    }
  }
  const onAction = (action, name) => {
    const request = keyActionRequest(action, name);
    return request ? sendKeyRequest(request, name) : undefined;
  };
  const keyTableOptions = () => ({ t, confirm, onAction });
  const defaultsOptions = (value, read) => ({ ...value, t, read, writable, onGroup, confirm: confirmChange, execute });
  return {
    confirm,
    /** The key table: rotating, revoking and deleting each ask first. */
    renderKeyTable: (root, keys) => renderKeyTable(root, keys, keyTableOptions()),
    /** The default-settings card: it confirms all of its changes once, then runs them without asking again. */
    renderDefaults: (root, value, read) => renderDefaults(root, defaultsOptions(value, read)),
  };
}
