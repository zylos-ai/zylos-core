import { formatZoned } from './instance-zone.js';
import { element, icon } from './plain-text.js';
import { customScopeLabels, customScopeSummary } from './api-key-scope-picker.js';

const keyStatus = key => key.status || (key.revoked_at ? 'revoked' : 'active');
const dateText = (value, t) => value ? formatZoned(value) : t('wb.settings.keys.never');

/** What each key action asks before it runs: rotating and revoking break machines using the key, deleting is permanent. */
export function keyActionConfirmation(action, name, t = key => key) {
  if (!['rotate', 'revoke', 'delete'].includes(action)) return null;
  const base = 'wb.settings.keys.confirm.' + action;
  return { title: t(base + '.title', { name }), text: t(base + '.body', { name }), ok: t('wb.settings.keys.' + action), danger: action !== 'rotate' };
}

/** The scope cell: a read / admin / custom badge; a custom key also lists its permissions, shortened when long. */
function scopeCell(document, scope, t) {
  const cell = element(document, 'td', undefined, 'api-key-scope-cell');
  if (scope === 'admin' || scope === 'read') {
    cell.append(element(document, 'span', t(scope === 'admin' ? 'fleet_manage.scope_admin' : 'fleet_manage.scope_read'), 'wb-scope-b' + (scope === 'admin' ? ' admin' : '')));
    return cell;
  }
  cell.append(element(document, 'span', t('wb.settings.keys.scopeCustom'), 'wb-scope-b custom'));
  const perms = element(document, 'div', customScopeSummary(scope, t), 'api-key-perm-summary');
  perms.title = customScopeLabels(scope, t).join(t('wb.settings.keys.permSeparator'));
  cell.append(perms);
  return cell;
}

/**
 * API keys as a table: name, scope badge, status, created, last used and text actions. Rotating, revoking and
 * deleting confirm first; 「修改权限」 opens `editScope(key)`, which resolves to the new scope or null.
 */
export function renderKeyTable(root, keys = [], { document = root.ownerDocument, t = key => key, confirm = async () => false, editScope = async () => null, onAction = () => {} } = {}) {
  // Without a confirmation dialog nothing runs: revoking and deleting cannot be undone.
  if (!keys.length) { root.replaceChildren(element(document, 'p', t('fleet_manage.keys_empty'), 'wb-note')); return; }
  const table = element(document, 'table', undefined, 'wb-ktable');
  const head = element(document, 'tr');
  for (const key of ['name', 'scope', 'status', 'created', 'lastUsed', '']) head.append(element(document, 'th', key ? t('wb.settings.keys.col.' + key) : ''));
  const thead = element(document, 'thead'); thead.append(head);
  const body = element(document, 'tbody');
  // The server orders the keys: active before revoked, newest first.
  for (const key of keys) {
    const status = keyStatus(key), row = element(document, 'tr', undefined, 'api-key-row' + (status === 'revoked' ? ' revoked' : ''));
    row.dataset.search = key.name;
    const name = element(document, 'td'), label = element(document, 'b', key.name); label.title = key.name; name.append(label);
    const scope = scopeCell(document, key.scope, t);
    const state = element(document, 'td');
    if (status === 'active') state.append(element(document, 'span', undefined, 'wb-hdot'), element(document, 'span', ' ' + t('fleet_manage.key_active')));
    else state.append(element(document, 'span', t('fleet_manage.key_' + status)));
    const acts = element(document, 'td'), box = element(document, 'div', undefined, 'wb-k-acts');
    const action = (name, label, className) => {
      const button = element(document, 'button', t(label), 'wb-btn wb-btn-sm api-key-' + name + (className ? ' ' + className : '')); button.type = 'button';
      button.addEventListener('click', async () => {
        const ask = keyActionConfirmation(name, key.name, t);
        if (ask && !(await confirm(ask.text, { title: ask.title, ok: ask.ok, danger: ask.danger }))) return;
        onAction(name, key.name);
      });
      box.append(button);
    };
    if (status === 'active') {
      const edit = element(document, 'button', t('wb.settings.keys.editScope'), 'wb-btn wb-btn-sm api-key-scope'); edit.type = 'button';
      edit.addEventListener('click', async () => {
        const next = await editScope(key);
        if (next && next !== key.scope) onAction('scope', key.name, next);
      });
      box.append(edit);
      action('rotate', 'wb.settings.keys.rotate'); action('revoke', 'wb.settings.keys.revoke', 'wb-btn-danger-text');
    }
    else action('delete', 'wb.settings.keys.delete', 'wb-btn-danger-text');
    acts.append(box);
    row.append(name, scope, state, element(document, 'td', dateText(key.created_at, t)), element(document, 'td', key.last_used_at ? dateText(key.last_used_at, t) : t('wb.settings.keys.never')), acts);
    body.append(row);
  }
  table.append(thead, body); root.replaceChildren(table);
}

/** One-time plaintext panel after creating or rotating a key. */
export function renderCreatedKey(panel, created, { document = panel.ownerDocument, t = key => key, onCopy = () => {}, onDismiss = () => {} } = {}) {
  panel.replaceChildren(); panel.hidden = !created;
  if (!created) return;
  const title = element(document, 'p'); title.append(element(document, 'b', t('wb.settings.keys.copyNow', { name: created.name })), element(document, 'span', ' ' + t('fleet_manage.key_once_hint')));
  const code = element(document, 'code', created.plaintext_key || '', 'api-key-plaintext');
  const acts = element(document, 'div', undefined, 'wb-set-inline');
  const copy = element(document, 'button', undefined, 'wb-btn api-key-copy'); copy.type = 'button'; copy.append(icon(document, 'copy', 'xs'), element(document, 'span', t('wb.settings.keys.copyKey')));
  const done = element(document, 'button', t('wb.settings.keys.saved'), 'wb-btn api-key-dismiss'); done.type = 'button';
  copy.addEventListener('click', onCopy); done.addEventListener('click', onDismiss);
  acts.append(copy, done); panel.append(title, code, acts);
}

/** Configured remote machines: name, address, connection state, technical latency bars and remove. */
export function renderRemoteAgents(root, agents = [], { document = root.ownerDocument, t = key => key, technical = false, latency, onRemove = () => {} } = {}) {
  if (!agents.length) { root.replaceChildren(element(document, 'p', t('fleet_manage.empty'), 'wb-note')); return; }
  root.replaceChildren(...agents.map(agent => {
    const status = agent.connection;
    const row = element(document, 'div', undefined, 'wb-agent-row'); row.dataset.agent = agent.name;
    const name = element(document, 'b', agent.name); name.title = agent.key_masked ? `${agent.key_masked} · ${agent.access || 'read'}` : '';
    const url = element(document, 'span', agent.base_url || '', 'wb-agent-url wb-mono'); url.title = agent.base_url || '';
    const state = element(document, 'span', undefined, 'wb-agent-st' + (['auth', 'down', 'version'].includes(status.kind) ? ' bad' : ''));
    const access = t(agent.access === 'admin' ? 'fleet_manage.scope_admin' : 'fleet_manage.scope_read');
    if (status.kind === 'ok') state.append(element(document, 'span', undefined, 'wb-hdot'), element(document, 'span', [t('wb.settings.fleet.reachable'), access, status.latency == null ? null : status.latency + 'ms'].filter(Boolean).join(' · ')));
    else if (status.kind === 'pending' || status.kind === 'unknown') state.append(icon(document, 'clock', 'xs'), element(document, 'span', t('wb.settings.fleet.' + status.kind) + ' · ' + access));
    else state.append(icon(document, 'alert', 'xs'), element(document, 'span', t('wb.settings.fleet.' + status.kind)));
    if (technical && agent.latency?.samples?.length && latency) { const chart = latency(state, agent.latency.samples); chart.dataset.settingsLatency = ''; }
    const remove = element(document, 'button', t('wb.settings.fleet.remove'), 'wb-btn wb-btn-sm wb-btn-danger-text fleet-agent-remove'); remove.type = 'button';
    remove.addEventListener('click', () => onRemove(agent.name));
    row.append(icon(document, 'server', 'xs'), name, url, state, remove);
    return row;
  }));
}
