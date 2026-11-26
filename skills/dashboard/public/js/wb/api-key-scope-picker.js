import { API_KEY_PERMISSIONS, API_KEY_PERMISSION_GROUPS, customScopePermissions, normalizeApiKeyScope } from './api-key-permissions.js';
import { element } from './plain-text.js';

// Static labels carry their i18n key so a language switch retranslates them in place.
const label = (document, tag, t, key, className) => {
  const node = element(document, tag, t(key), className);
  node.dataset.i18n = key;
  return node;
};

const SUMMARY_LIMIT = 3;

/** The on-screen names of a custom scope's permissions, in the order the picker lists them. */
export function customScopeLabels(scope, t = key => key) {
  return customScopePermissions(scope)
    .sort((a, b) => API_KEY_PERMISSIONS.indexOf(a) - API_KEY_PERMISSIONS.indexOf(b))
    .map(name => t('wb.settings.keys.perm.' + name));
}

/** The key table's line under a custom badge: every name up to three, otherwise the first and the count. */
export function customScopeSummary(scope, t = key => key) {
  const labels = customScopeLabels(scope, t);
  if (labels.length <= SUMMARY_LIMIT) return labels.join(t('wb.settings.keys.permSeparator'));
  return t('wb.settings.keys.permMore', { first: labels[0], count: labels.length, more: labels.length - 1 });
}

/**
 * Read / admin / custom, with the custom permissions as checkboxes grouped by asset. The parts are placed by the
 * caller: `seg` (the three choices), `panel` (the checkboxes, shown for custom) and `warning` (shown for admin).
 * `value()` is the scope string to send, or null while custom has nothing ticked.
 */
export function createScopePicker(document, { t = key => key, scope = 'read', onChange = () => {} } = {}) {
  let mode = scope === 'admin' || scope === 'read' ? scope : 'custom';
  const ticked = new Set(customScopePermissions(scope));
  const seg = element(document, 'div', undefined, 'wb-seg2 api-key-scope-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', t('wb.settings.keys.scope'));
  const choices = [['read', 'fleet_manage.scope_read'], ['admin', 'fleet_manage.scope_admin'], ['custom', 'wb.settings.keys.scopeCustom']]
    .map(([value, key]) => {
      const button = label(document, 'button', t, key);
      button.type = 'button';
      button.dataset.scope = value;
      button.addEventListener('click', () => { mode = value; sync(); onChange(); });
      seg.append(button);
      return button;
    });
  const panel = element(document, 'div', undefined, 'api-key-perms');
  for (const { group, permissions } of API_KEY_PERMISSION_GROUPS) {
    const set = element(document, 'fieldset', undefined, 'api-key-perm-group');
    set.append(label(document, 'legend', t, 'wb.settings.keys.permGroup.' + group));
    for (const name of permissions) {
      const row = element(document, 'label', undefined, 'api-key-perm');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = name;
      box.checked = ticked.has(name);
      box.addEventListener('change', () => { if (box.checked) ticked.add(name); else ticked.delete(name); sync(); onChange(); });
      row.append(box, label(document, 'span', t, 'wb.settings.keys.perm.' + name));
      set.append(row);
    }
    panel.append(set);
  }
  const empty = label(document, 'p', t, 'wb.settings.keys.permsRequired', 'wb-note api-key-perms-empty');
  panel.append(empty);
  const warning = element(document, 'p', undefined, 'wb-note wb-txt-err api-key-admin-warning');
  const alert = element(document, 'i', undefined, 'wb-ico wb-ico-alert wb-ico-xs');
  alert.setAttribute('aria-hidden', 'true');
  warning.append(alert, document.createTextNode(' '), label(document, 'span', t, 'fleet_manage.admin_key_warning'));
  function sync() {
    for (const button of choices) button.setAttribute('aria-pressed', String(button.dataset.scope === mode));
    panel.hidden = mode !== 'custom';
    empty.hidden = ticked.size > 0;
    warning.hidden = mode !== 'admin';
  }
  sync();
  return {
    seg, panel, warning,
    value: () => (mode === 'custom' ? normalizeApiKeyScope([...ticked].join(',')) : mode),
    /** Back to read with nothing ticked, as after creating a key. */
    reset() { mode = 'read'; ticked.clear(); for (const box of panel.querySelectorAll('input')) box.checked = false; sync(); },
  };
}

/** The 「修改权限」 dialog: the same picker as key creation. Resolves to the chosen scope, or null when cancelled. */
export function scopeDialog(document, { t = key => key, name, scope }) {
  return new Promise(resolve => {
    const backdrop = element(document, 'div', undefined, 'wb-modal-bg');
    const dialog = element(document, 'div', undefined, 'wb-modal api-key-scope-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const save = element(document, 'button', t('btn.save'), 'wb-btn wb-btn-primary');
    const cancel = element(document, 'button', t('btn.cancel'), 'wb-btn');
    save.type = cancel.type = 'button';
    const picker = createScopePicker(document, { t, scope, onChange: () => { save.disabled = !picker.value(); } });
    save.disabled = !picker.value();
    const title = element(document, 'h3', t('wb.settings.keys.editScopeTitle', { name }));
    title.id = 'api-key-scope-dialog-title';
    dialog.setAttribute('aria-labelledby', title.id);
    const acts = element(document, 'div', undefined, 'wb-modal-acts');
    acts.append(cancel, save);
    dialog.append(title, picker.seg, picker.panel, picker.warning, acts);
    backdrop.append(dialog);
    const previous = document.activeElement;
    const finish = value => {
      document.removeEventListener('keydown', keydown, true);
      backdrop.remove(); previous?.focus?.(); resolve(value);
    };
    const keydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(null); } };
    cancel.addEventListener('click', () => finish(null));
    save.addEventListener('click', () => { const value = picker.value(); if (value) finish(value); });
    backdrop.addEventListener('click', event => { if (event.target === backdrop) finish(null); });
    document.addEventListener('keydown', keydown, true);
    document.body.append(backdrop);
    picker.seg.querySelector('[aria-pressed="true"]')?.focus();
  });
}
