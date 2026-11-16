import { element } from './plain-text.js';
import { responseError } from './group-config.js';

/** Ask Origin to name the unnamed groups. Resolves to the Dashboard's answer; HTTP failures carry their body. */
export function sendNamePrompt({ request }) {
  return request('/api/groups/naming-prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
}

/** What the person is told after confirming: sent only when C4 queued the prompt, otherwise why not. */
export function namePromptResult(value, error, t = key => key, { single = false } = {}) {
  // The Dashboard names the session it queued for: null is the only session of single mode.
  if (value?.ok === true) return { ok: true, text: t(value.sessionGroup === null ? 'wb.name.sentSingle' : 'wb.name.sent') };
  const body = error ? error.body : value;
  const lone = body && 'sessionGroup' in body ? body.sessionGroup === null : single;
  if (body?.unknown || (error && !body)) return { ok: false, text: t(lone ? 'wb.name.unknownSingle' : 'wb.name.unknown', { reason: body ? responseError(body) : error.message }) };
  return { ok: false, text: t('wb.name.failed', { reason: responseError(body) }) };
}

/** The answer after confirming: sending, then sent or failed, with a close button. */
export function renderNameResult(root, state, { document = root.ownerDocument, t = key => key, onClose = () => {}, single = false } = {}) {
  root.replaceChildren();
  root.append(element(document, 'h3', t('wb.name.auto')));
  const message = element(document, 'p', state === 'sending' ? t(single ? 'wb.name.sendingSingle' : 'wb.name.sending') : state.text,
    state === 'sending' ? 'wb-name-status' : state.ok ? 'wb-name-status wb-name-sent' : 'wb-name-status wb-name-failed');
  message.setAttribute('role', state !== 'sending' && !state.ok ? 'alert' : 'status');
  root.append(message);
  if (state === 'sending') return { message, close: null };
  const close = element(document, 'button', t('wb.close'), 'wb-btn'); close.type = 'button';
  close.addEventListener('click', onClose);
  const actions = element(document, 'div', undefined, 'wb-modal-acts'); actions.append(close);
  root.append(actions);
  close.focus?.();
  return { message, close };
}
