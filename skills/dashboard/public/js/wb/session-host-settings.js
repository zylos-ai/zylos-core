import { formatZoned } from './instance-zone.js';
import { mountPagedList } from './paged-list.js';
import { element, icon } from './plain-text.js';
import { settingsCard } from './settings.js';

/**
 * Two cards about session hosting on this machine, shown only when this machine itself is open: the channels that
 * are not notified while a group is hosted (each one a tag; its × removes it at once, since adding it back is one
 * step), and the hosting relationships as one of the settings page's long lists, where detaching asks first.
 * A change's result is shown in the card that made it.
 */
export function mountSessionHostSettings(root, { t, locale, local, read, write, confirm = async () => false }) {
  const document = root.ownerDocument;
  const label = (suffix, params) => t(`wb.settings.host.${suffix}`, params);
  const panel = element(document, 'section', undefined, 'wb-host-settings');
  panel.id = 'settings-session-hosts';
  panel.hidden = true;
  const failure = element(document, 'p', '', 'wb-note');
  failure.hidden = true;

  const allow = settingsCard(document, { icon: 'alert', id: 'settings-host-allowlist' });
  const channels = element(document, 'div', undefined, 'wb-host-chips');
  const form = element(document, 'form', undefined, 'wb-set-inline wb-host-allow');
  const input = element(document, 'input', undefined, 'wb-input');
  input.type = 'text';
  input.required = true;
  const add = element(document, 'button', '', 'wb-btn wb-btn-primary');
  add.type = 'submit';
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (input.value.trim()) submit({ action: 'allow', channel: input.value.trim() }, allow.card);
  });
  form.append(input, add);
  allow.card.append(channels, form);

  const hosts = settingsCard(document, { icon: 'layers', id: 'settings-host-relationships' });
  const rows = element(document, 'div', undefined, 'wb-host-rows');
  const list = mountPagedList({ document, t, list: rows, rows: () => [...rows.querySelectorAll('.wb-host-row')] });
  hosts.card.append(list.search, rows, list.empty, list.pager);

  const status = element(document, 'p', '', 'wb-note');
  status.setAttribute('role', 'status');
  status.tabIndex = -1;
  panel.append(failure, allow.card, hosts.card);
  root.append(panel);

  let generation = 0;
  let busy = false;
  let data = null;

  function relationshipRow(record) {
    const item = element(document, 'div', undefined, 'wb-host-row');
    item.dataset.search = `${record.source_group} ${record.target_group}`;
    const text = element(document, 'div', undefined, 'wb-host-text');
    const when = record.attached_at ? formatZoned(record.attached_at, locale()) : '—';
    text.append(element(document, 'div', `${record.source_group} → ${record.target_group}`), element(document, 'div', label('attached', { actor: record.attached_by, when }), 'wb-host-meta'));
    const detach = element(document, 'button', label('detach'), 'wb-btn wb-btn-danger-text');
    detach.type = 'button';
    detach.addEventListener('click', async () => {
      const asked = await confirm(label('detachConfirm', { source: record.source_group, target: record.target_group }),
        { title: label('detachTitle'), ok: label('detach'), danger: true });
      if (asked) submit({ action: 'detach', group: record.source_group }, hosts.card);
    });
    item.append(text, detach);
    return item;
  }

  function channelTag(channel) {
    const tag = element(document, 'span', undefined, 'wb-host-chip');
    const remove = element(document, 'button', undefined, 'wb-host-chip-x');
    remove.type = 'button';
    remove.setAttribute('aria-label', label('removeChannel', { channel }));
    remove.title = label('removeChannel', { channel });
    remove.append(icon(document, 'x', 'xs'));
    remove.addEventListener('click', () => submit({ action: 'disallow', channel }, allow.card));
    tag.append(element(document, 'span', channel), remove);
    return tag;
  }

  function render() {
    allow.label.textContent = label('allowlist');
    hosts.label.textContent = label('relationships');
    input.placeholder = label('channel');
    input.setAttribute('aria-label', label('channel'));
    add.textContent = label('add');
    list.setPlaceholder(label('search'));
    channels.replaceChildren(...(data.allowlist.length ? data.allowlist.map(channelTag) : [element(document, 'p', label('emptyAllowlist'), 'wb-host-meta')]));
    hosts.sub.textContent = label('count', { count: data.relationships.length });
    hosts.sub.hidden = !data.relationships.length;
    rows.replaceChildren(...(data.relationships.length ? data.relationships.map(relationshipRow) : [element(document, 'p', label('emptyRelationships'), 'wb-host-meta')]));
    list.relabel();
  }

  function invalidate() {
    generation++;
    busy = false;
    data = null;
    panel.hidden = true;
    status.textContent = '';
    status.remove();
    failure.hidden = true;
  }

  async function refresh() {
    invalidate();
    if (!local()) return;
    const current = generation;
    try {
      const value = await read();
      if (current !== generation || !local()) return;
      data = value;
      render();
      allow.card.hidden = hosts.card.hidden = false;
      panel.hidden = false;
    } catch (error) {
      if (current !== generation || !local() || error.status === 403) return;
      failure.textContent = label('readFailed');
      failure.hidden = false;
      allow.card.hidden = hosts.card.hidden = true;
      panel.hidden = false;
    }
  }

  async function submit(request, card) {
    if (!local() || busy) return;
    const current = generation;
    busy = true;
    const controls = [...panel.querySelectorAll('button, input')];
    for (const control of controls) control.disabled = true;
    card.append(status);
    status.textContent = label('saving');
    try {
      const value = await write(request);
      if (current !== generation || !local()) return;
      data = value;
      render();
      card.append(status);
      status.textContent = label(value.changed ? 'updated' : 'unchanged');
      status.focus();
    } catch {
      if (current === generation && local()) status.textContent = label('saveFailed');
    } finally {
      if (current === generation) {
        busy = false;
        for (const control of panel.querySelectorAll('button, input')) control.disabled = false;
      }
    }
  }

  return { refresh, invalidate };
}
