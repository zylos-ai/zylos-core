import { element, icon } from './plain-text.js?v=105';

export function mountChatSettings(root, { document = root.ownerDocument, t = key => key, local, read, write }) {
  const panel = element(document, 'div', undefined, 'wb-set-card');
  panel.id = 'settings-chat';
  panel.hidden = true;
  const head = element(document, 'div', undefined, 'wb-set-card-h'), heading = element(document, 'h4'), title = element(document, 'span', t('wb.settings.chatTitle'));
  title.dataset.i18n = 'wb.settings.chatTitle'; heading.append(icon(document, 'msg', 'xs'), title); head.append(heading);
  const label = element(document, 'label', undefined, 'wb-switch-l');
  const checkbox = element(document, 'input', undefined, 'wb-switch');
  checkbox.id = 'settings-chat-remote';
  checkbox.type = 'checkbox';
  checkbox.setAttribute('role', 'switch');
  checkbox.disabled = true;
  const text = element(document, 'span', t('wb.settings.allowRemoteChat'));
  text.dataset.i18n = 'wb.settings.allowRemoteChat';
  label.append(checkbox, text);
  panel.append(head);
  const status = element(document, 'p', undefined, 'wb-note');
  status.setAttribute('role', 'status');
  status.hidden = true;
  panel.append(label, status);
  root.append(panel);
  let generation = 0, saved = false, loaded = false, pending = false;

  function message(key) {
    status.hidden = !key;
    if (key) { status.dataset.i18n = key; status.textContent = t(key); }
    else { delete status.dataset.i18n; status.textContent = ''; }
  }
  function invalidate() {
    generation++;
    loaded = false;
    pending = false;
    saved = false;
    checkbox.checked = false;
    checkbox.disabled = true;
    panel.hidden = true;
    message(null);
  }
  async function refresh() {
    invalidate();
    if (!local()) return;
    panel.hidden = false;
    const current = generation;
    try {
      const value = await read();
      if (current !== generation || !local()) return;
      if (typeof value?.allowRemote !== 'boolean') throw Error('invalid_chat_settings');
      saved = value.allowRemote;
      checkbox.checked = saved;
      loaded = true;
      checkbox.disabled = false;
    } catch {
      if (current === generation && local()) message('wb.settings.chatReadFailed');
    }
  }
  checkbox.addEventListener('change', async () => {
    if (!local() || !loaded || pending) { checkbox.checked = saved; return; }
    const current = generation, desired = checkbox.checked;
    pending = true;
    checkbox.disabled = true;
    message(null);
    try {
      const value = await write({ allowRemote: desired });
      if (current !== generation || !local()) return;
      if (typeof value?.allowRemote !== 'boolean') throw Error('invalid_chat_settings');
      saved = value.allowRemote;
      message('wb.settings.chatSaved');
    } catch {
      if (current === generation && local()) message('wb.settings.chatSaveFailed');
    } finally {
      if (current === generation && local()) {
        checkbox.checked = saved;
        checkbox.disabled = false;
        pending = false;
      }
    }
  });
  return { refresh, invalidate };
}
