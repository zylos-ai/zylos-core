import { formatZoned } from './instance-zone.js';
import { element } from './plain-text.js';
import { settingsCard } from './settings.js';

export function mountSessionHostSettings(root, { t, locale, local, read, write }) {
  const document = root.ownerDocument;
  const key = suffix => `wb.settings.host.${suffix}`;
  const label = (suffix, params) => t(key(suffix), params);
  const panel = element(document, 'section', undefined, 'wb-host-settings');
  panel.id = 'settings-session-hosts';
  panel.hidden = true;
  const status = element(document, 'p', '', 'wb-note');
  status.setAttribute('role', 'status');
  status.tabIndex = -1;
  const list = element(document, 'div');
  panel.append(status, list);
  root.append(panel);

  let generation = 0;
  let busy = false;
  let data = null;

  function button(suffix, style = '') {
    const node = element(document, 'button', label(suffix), `wb-btn ${style}`);
    node.type = 'button';
    return node;
  }

  function action(suffix, request, style) {
    const node = button(suffix, style);
    node.addEventListener('click', () => submit(request));
    return node;
  }

  function card(suffix, icon) {
    const { card: node } = settingsCard(document, { icon, title: label(suffix) });
    const rows = element(document, 'div', undefined, 'wb-host-rows');
    node.append(rows);
    list.append(node);
    return rows;
  }

  function row(parent, title, details, actions) {
    const item = element(document, 'div', undefined, 'wb-host-row');
    const text = element(document, 'div', undefined, 'wb-host-text');
    text.append(element(document, 'div', title));
    for (const detail of details) text.append(element(document, 'div', detail, 'wb-host-meta'));
    const buttons = element(document, 'div', undefined, 'wb-set-inline');
    buttons.append(...actions);
    item.append(text, buttons);
    parent.append(item);
  }

  function empty(parent, suffix) {
    parent.append(element(document, 'p', label(suffix), 'wb-host-meta'));
  }

  function render() {
    list.replaceChildren();
    if (!data) return;

    const relationships = card('relationships', 'layers');
    if (!data.relationships.length) empty(relationships, 'emptyRelationships');
    for (const record of data.relationships) {
      const when = record.attached_at ? formatZoned(record.attached_at, locale()) : '—';
      row(relationships, `${record.source_group} → ${record.target_group}`, [
        label('attached', { actor: record.attached_by, when }),
      ], [action('detach', { action: 'detach', group: record.source_group }, 'wb-btn-danger-text')]);
    }

    const allowlist = card('allowlist', 'alert');
    if (!data.allowlist.length) empty(allowlist, 'emptyAllowlist');
    for (const channel of data.allowlist) {
      row(allowlist, channel, [], [action('remove', { action: 'disallow', channel }, 'wb-btn-danger-text')]);
    }
    const form = element(document, 'form', undefined, 'wb-set-inline wb-host-allow');
    const input = element(document, 'input', undefined, 'wb-input');
    input.type = 'text';
    input.required = true;
    input.setAttribute('aria-label', label('channel'));
    input.placeholder = label('channel');
    const add = button('add', 'wb-btn-primary');
    add.type = 'submit';
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (input.value.trim()) submit({ action: 'allow', channel: input.value.trim() });
    });
    form.append(input, add);
    allowlist.append(form);
  }

  function invalidate() {
    generation++;
    busy = false;
    data = null;
    panel.hidden = true;
    status.textContent = '';
    list.replaceChildren();
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
      panel.hidden = false;
    } catch (error) {
      if (current !== generation || !local() || error.status === 403) return;
      status.textContent = label('readFailed');
      panel.hidden = false;
    }
  }

  async function submit(request) {
    if (!local() || busy) return;
    const current = generation;
    busy = true;
    const controls = [...list.querySelectorAll('button, input')];
    for (const control of controls) control.disabled = true;
    status.textContent = label('saving');
    try {
      const value = await write(request);
      if (current !== generation || !local()) return;
      data = value;
      render();
      status.textContent = label(value.changed ? 'updated' : 'unchanged');
      status.focus();
    } catch {
      if (current === generation && local()) status.textContent = label('saveFailed');
    } finally {
      if (current === generation) {
        busy = false;
        for (const control of controls) control.disabled = false;
      }
    }
  }

  return { refresh, invalidate };
}
