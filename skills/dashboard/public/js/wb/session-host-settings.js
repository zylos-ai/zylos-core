import { formatZoned } from './instance-zone.js';
import { mountPagedList } from './paged-list.js';
import { element, icon } from './plain-text.js';
import { settingsCard } from './settings.js';

/**
 * Two cards about session hosting on this machine, shown only when this machine itself is open: the channels that
 * are not notified while a group is hosted (each one a tag; its × removes it at once, since adding it back is one
 * step), and the hosting relationships as one of the settings page's long lists, where detaching asks first.
 * Channels are added from a searchable list of the registered channels not on the list yet; text that names none
 * of them adds nothing. If the registered channels cannot be read, only adding is unavailable. A change's result is shown in the card that made it.
 */
export function mountSessionHostSettings(root, { t, locale, local, read, readChannels, write, confirm = async () => false }) {
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
  const combo = element(document, 'span', undefined, 'wb-host-combo');
  const input = element(document, 'input', undefined, 'wb-input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  const options = element(document, 'div', undefined, 'wb-host-options');
  options.id = 'settings-host-channel-options';
  options.setAttribute('role', 'listbox');
  options.hidden = true;
  input.setAttribute('aria-controls', options.id);
  combo.append(input, icon(document, 'chev', 'xs'), options);
  const add = element(document, 'button', '', 'wb-btn wb-btn-primary');
  add.type = 'submit';
  form.addEventListener('submit', event => {
    event.preventDefault();
    const channel = input.value.trim();
    if (candidates().includes(channel)) submit({ action: 'allow', channel }, allow.card);
  });
  input.addEventListener('focus', () => showOptions(true));
  input.addEventListener('click', () => showOptions(true));
  input.addEventListener('input', () => showOptions(true));
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !options.hidden) { event.preventDefault(); showOptions(false); }
  });
  // Choosing with the pointer keeps focus in the field, so the list is not closed by the field losing focus first.
  options.addEventListener('pointerdown', event => event.preventDefault());
  combo.addEventListener('focusout', event => { if (!combo.contains(event.relatedTarget)) showOptions(false); });
  form.append(combo, add);
  const channelsFailed = element(document, 'p', '', 'wb-host-meta');
  allow.card.append(channels, form, channelsFailed);

  const hosts = settingsCard(document, { icon: 'layers', id: 'settings-host-relationships' });
  const rows = element(document, 'div', undefined, 'wb-host-rows');
  const list = mountPagedList({ document, t, list: rows, server: {
    async readPage(page) {
      const current = generation;
      try {
        const value = await read(page);
        if (current !== generation || !local()) throw pageClosed;
        return value;
      } catch (error) {
        throw current !== generation || !local() ? pageClosed : error;
      }
    },
    render(items, page) {
      data = page;
      if (Number.isSafeInteger(page.total)) relationshipCount = page.total;
      renderAllowlist();
      hosts.sub.textContent = label('count', { count: relationshipCount });
      hosts.sub.hidden = !relationshipCount;
      const searching = list.search.querySelector('input').value.trim();
      const content = !items.length && !searching ? [element(document, 'p', label('emptyRelationships'), 'wb-host-meta')]
        : items.map(relationshipRow);
      rows.replaceChildren(...content);
      allow.card.hidden = hosts.card.hidden = false;
      failure.hidden = true;
      panel.hidden = false;
    },
    onError(error) {
      if (error === pageClosed || error.status === 403) return;
      failure.textContent = label('readFailed');
      failure.hidden = false;
      allow.card.hidden = hosts.card.hidden = !data;
      panel.hidden = false;
    },
  } });
  hosts.card.append(list.search, rows, list.empty, list.pager);

  const status = element(document, 'p', '', 'wb-note');
  status.setAttribute('role', 'status');
  status.tabIndex = -1;
  panel.append(failure, allow.card, hosts.card);
  root.append(panel);

  const pageClosed = new Error('Settings closed');
  let relationshipCount = 0;
  let generation = 0;
  let busy = false;
  let data = null;
  let registered = null;

  const candidates = () => (registered ?? []).filter(channel => !data.allowlist.includes(channel));

  function showOptions(open) {
    options.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (open) renderOptions();
    syncAdd();
  }

  function syncAdd() {
    add.disabled = busy || !data || !candidates().includes(input.value.trim());
  }

  function renderOptions() {
    const query = input.value.trim().toLowerCase();
    const shown = candidates().filter(channel => channel.toLowerCase().includes(query));
    options.replaceChildren(...(shown.length ? shown.map(channel => {
      const option = element(document, 'button', channel, 'wb-host-option');
      option.type = 'button';
      option.setAttribute('role', 'option');
      option.addEventListener('click', () => {
        input.focus();
        input.value = channel;
        showOptions(false);
      });
      return option;
    }) : [element(document, 'p', label('noChannels'), 'wb-host-meta')]));
  }

  function relationshipRow(record) {
    const item = element(document, 'div', undefined, 'wb-host-row');
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

  function renderAllowlist() {
    allow.label.textContent = label('allowlist');
    hosts.label.textContent = label('relationships');
    input.placeholder = label('pickChannel');
    channelsFailed.textContent = label('channelsFailed');
    form.hidden = !registered;
    channelsFailed.hidden = !!registered;
    input.setAttribute('aria-label', label('channel'));
    add.textContent = label('add');
    list.setPlaceholder(label('search'));
    channels.replaceChildren(...(data.allowlist.length ? data.allowlist.map(channelTag) : [element(document, 'p', label('emptyAllowlist'), 'wb-host-meta')]));
    list.relabel();
    if (!options.hidden) renderOptions();
    syncAdd();
  }

  function invalidate() {
    generation++;
    busy = false;
    data = null;
    registered = null;
    showOptions(false);
    panel.hidden = true;
    status.textContent = '';
    status.remove();
    failure.hidden = true;
  }

  async function refresh() {
    invalidate();
    if (!local()) return;
    const current = generation;
    const registry = readChannels().catch(() => null).then(value => {
      if (current !== generation || !local()) return;
      registered = value?.channels ?? null;
      if (data) renderAllowlist();
    });
    await Promise.all([list.refresh({ first: true }), registry]);
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
      data = { ...data, allowlist: value.allowlist };
      if (request.action === 'allow') input.value = '';
      renderAllowlist();
      await list.refresh({ first: true });
      if (current !== generation || !local()) return;
      card.append(status);
      status.textContent = label(value.changed ? 'updated' : 'unchanged');
      status.focus();
    } catch {
      if (current === generation && local()) status.textContent = label('saveFailed');
    } finally {
      if (current === generation) {
        busy = false;
        for (const control of controls) control.disabled = false;
        list.relabel();
        syncAdd();
      }
    }
  }

  return { refresh, invalidate };
}
