import { permissionErrorKey } from './write-errors.js';
import { element } from './plain-text.js';
import { responseError } from './group-config.js';

/** Ask Origin to name the unnamed groups. Resolves to the Dashboard's answer; HTTP failures carry their body. */
export function sendNamePrompt({ request }) {
  return request('/api/groups/naming-prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
}

/**
 * What the person is told after confirming: sent only when C4 queued the prompt. Otherwise one plain sentence, while
 * the raw answer (error code, message, command output) is kept as `detail` for the technical-detail view only.
 */
export function namePromptResult(value, error, t = key => key, { single = false } = {}) {
  // The Dashboard names the session it queued for: null is the only session of single mode.
  if (value?.ok === true) return { ok: true, text: t(value.sessionGroup === null ? 'wb.name.sentSingle' : 'wb.name.sent') };
  const body = error ? error.body : value;
  const lone = body && typeof body === 'object' && 'sessionGroup' in body ? body.sessionGroup === null : single;
  const detail = body ? responseError(body) : error?.message ?? '';
  const code = typeof body?.error === 'string' ? body.error : body?.error?.code;
  const permission = permissionErrorKey(code);
  if (permission) return { ok: false, text: t(permission), detail };
  if (error?.status >= 400 && error.status < 500) return { ok: false, text: t('wb.name.rejected'), detail };
  if (body?.unknown || (error && !body)) return { ok: false, text: t(lone ? 'wb.name.unknownSingle' : 'wb.name.unknown'), detail };
  return { ok: false, text: t('wb.name.failed'), detail };
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
  // The raw answer stays out of the sentence: folded, and shown only while technical detail is on.
  let detail = null;
  if (!state.ok && state.detail) {
    detail = element(document, 'details', undefined, 'wb-tech wb-name-detail');
    detail.append(element(document, 'summary', t('wb.detail')), element(document, 'pre', state.detail));
    root.append(detail);
  }
  const close = element(document, 'button', t('wb.close'), 'wb-btn'); close.type = 'button';
  close.addEventListener('click', onClose);
  const actions = element(document, 'div', undefined, 'wb-modal-acts'); actions.append(close);
  root.append(actions);
  close.focus?.();
  return { message, close, detail };
}
