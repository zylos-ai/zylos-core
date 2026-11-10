import { element, icon } from './plain-text.js?v=106';

const keyStatus = key => key.status || (key.revoked_at ? 'revoked' : 'active');
const dateText = (value, t) => value ? String(value).replace('T', ' ').replace(/\.\d+Z?$|Z$/, '').slice(0, 16) : t('wb.settings.keys.never');

/** What each key action asks before it runs: rotating and revoking break machines using the key, deleting is permanent. */
export function keyActionConfirmation(action, name, t = key => key) {
  if (!['rotate', 'revoke', 'delete'].includes(action)) return null;
  const base = 'wb.settings.keys.confirm.' + action;
  return { title: t(base + '.title', { name }), text: t(base + '.body', { name }), ok: t('wb.settings.keys.' + action), danger: action !== 'rotate' };
}

/** API keys as a table: name, scope badge, status, created, last used and text actions; each action confirms first. */
export function renderKeyTable(root, keys = [], { document = root.ownerDocument, t = key => key, confirm = async () => false, onAction = () => {} } = {}) {
  // Without a confirmation dialog nothing runs: revoking and deleting cannot be undone.
  if (!keys.length) { root.replaceChildren(element(document, 'p', t('fleet_manage.keys_empty'), 'wb-note')); return; }
  const table = element(document, 'table', undefined, 'wb-ktable');
  const head = element(document, 'tr');
  for (const key of ['name', 'scope', 'status', 'created', 'lastUsed', '']) head.append(element(document, 'th', key ? t('wb.settings.keys.col.' + key) : ''));
  const thead = element(document, 'thead'); thead.append(head);
  const body = element(document, 'tbody');
  const ordered = [...keys.filter(key => keyStatus(key) !== 'revoked'), ...keys.filter(key => keyStatus(key) === 'revoked')];
  for (const key of ordered) {
    const status = keyStatus(key), row = element(document, 'tr', undefined, 'api-key-row' + (status === 'revoked' ? ' revoked' : ''));
    const name = element(document, 'td'), label = element(document, 'b', key.name); label.title = key.name; name.append(label);
    const scope = element(document, 'td'); scope.append(element(document, 'span', t(key.scope === 'admin' ? 'fleet_manage.scope_admin' : 'fleet_manage.scope_read'), 'wb-scope-b' + (key.scope === 'admin' ? ' admin' : '')));
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
    if (status === 'active') { action('rotate', 'wb.settings.keys.rotate'); action('revoke', 'wb.settings.keys.revoke', 'wb-btn-danger-text'); }
    else action('delete', 'wb.settings.keys.delete', 'wb-btn-danger-text');
    acts.append(box);
    row.append(name, scope, state, element(document, 'td', dateText(key.created_at, t)), element(document, 'td', key.last_used_at ? dateText(key.last_used_at, t) : t('wb.settings.keys.never')), acts);
    body.append(row);
  }
  table.append(thead, body); root.replaceChildren(table);
}

/** Counts for the existing-keys card header. */
export function keyCounts(keys = []) {
  const revoked = keys.filter(key => keyStatus(key) === 'revoked').length;
  return { active: keys.length - revoked, revoked };
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

/** Connection state of a remote machine, from the fleet poller's record for it. */
export function remoteStatus(record) {
  if (!record) return { kind: 'unknown' };
  const reason = String(record.health_reason || '').toLowerCase();
  if (reason === 'not_polled') return { kind: 'pending' };
  if (reason === 'auth_failed') return { kind: 'auth' };
  if (reason === 'version_unsupported') return { kind: 'version' };
  if (record.pulse_rate === 0 || ['unreachable', 'timeout', 'conn_refused', 'bad_payload', 'offline'].includes(reason) || record.link?.quality === 'down') return { kind: 'down', reason: reason || record.link?.reason || null };
  return { kind: 'ok', latency: Number.isFinite(record.link?.latency_ms) ? Math.round(record.link.latency_ms) : null };
}

/** Configured remote machines: name, address, connection state, technical latency bars and remove. */
export function renderRemoteAgents(root, agents = [], { records = [], document = root.ownerDocument, t = key => key, technical = false, latency, onRemove = () => {} } = {}) {
  if (!agents.length) { root.replaceChildren(element(document, 'p', t('fleet_manage.empty'), 'wb-note')); return; }
  root.replaceChildren(...agents.map(agent => {
    const record = records.find(item => item.name === agent.name), status = remoteStatus(record);
    const row = element(document, 'div', undefined, 'wb-agent-row'); row.dataset.agent = agent.name;
    const name = element(document, 'b', agent.name); name.title = agent.key_masked ? `${agent.key_masked} · ${agent.access || 'read'}` : '';
    const url = element(document, 'span', agent.base_url || '', 'wb-agent-url wb-mono'); url.title = agent.base_url || '';
    const state = element(document, 'span', undefined, 'wb-agent-st' + (['auth', 'down', 'version'].includes(status.kind) ? ' bad' : ''));
    const access = t(agent.access === 'admin' ? 'fleet_manage.scope_admin' : 'fleet_manage.scope_read');
    if (status.kind === 'ok') state.append(element(document, 'span', undefined, 'wb-hdot'), element(document, 'span', [t('wb.settings.fleet.reachable'), access, status.latency == null ? null : status.latency + 'ms'].filter(Boolean).join(' · ')));
    else if (status.kind === 'pending' || status.kind === 'unknown') state.append(icon(document, 'clock', 'xs'), element(document, 'span', t('wb.settings.fleet.' + status.kind) + ' · ' + access));
    else state.append(icon(document, 'alert', 'xs'), element(document, 'span', t('wb.settings.fleet.' + status.kind)));
    if (technical && record?.latency?.samples?.length && latency) { const chart = latency(state, record.latency.samples); chart.dataset.settingsLatency = ''; }
    const remove = element(document, 'button', t('wb.settings.fleet.remove'), 'wb-btn wb-btn-sm wb-btn-danger-text fleet-agent-remove'); remove.type = 'button';
    remove.addEventListener('click', () => onRemove(agent.name));
    row.append(icon(document, 'server', 'xs'), name, url, state, remove);
    return row;
  }));
}
