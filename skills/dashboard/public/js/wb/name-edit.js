import { element } from './plain-text.js?v=84';
import { responseError } from './group-config.js?v=84';

export async function saveGroupName(key, name, { request }) {
  const path = `/api/workbench/groups/${encodeURIComponent(key)}/name`;
  const clear = name.trim() === '';
  const value = await request(path, clear ? { method: 'DELETE' } : {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
  if (value?.ok === false || value?.error) throw new Error(responseError(value));
  return value?.data ?? value;
}

export function renderNameEditor(root, { key, name = '', request, document = root.ownerDocument,
  t = key => key, writable = true, onInput = () => {}, onSave = () => {}, onCancel = () => {}, active = () => true }) {
  root.replaceChildren();
  const input = element(document, 'input'); input.value = name;
  input.setAttribute('aria-label', t('wb.name.edit'));
  input.addEventListener('input', () => onInput(input.value));
  const save = element(document, 'button', t('wb.name.save')); save.type = 'button';
  const cancel = element(document, 'button', t('wb.cancel')); cancel.type = 'button';
  const error = element(document, 'p', '', 'wb-name-error');
  input.disabled = save.disabled = !writable;
  save.addEventListener('click', async () => {
    if (save.disabled) return;
    save.disabled = true; error.textContent = '';
    try {
      const result = await saveGroupName(key, input.value, { request });
      if (active()) onSave(result);
    } catch (failure) {
      if (active()) error.textContent = failure.message;
    } finally { if (active()) save.disabled = !writable; }
  });
  cancel.addEventListener('click', onCancel);
  root.append(input, save, cancel, error);
  input.focus();
  return { input, save, error };
}
