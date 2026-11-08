import { requireChatAccess } from './access.js';
import { parseChatSubscription } from './change-observer.js';
import { sendJson } from '../http.js';

/** Ordinary streams keep their existing behavior; chat is an explicit opt-in. */
export function handleChatStream(req, res, url, { auth, config, hub, observer }) {
  if (url.pathname !== '/api/stream' || !url.searchParams.has('chat')) return false;
  if (req.method !== 'GET') { sendJson(res, 405, { error: 'method_not_allowed' }); return true; }
  const validate = () => !requireChatAccess(req, auth, config, { touch: false });
  const denied = requireChatAccess(req, auth, config);
  if (denied) { sendJson(res, denied.status, denied); return true; }
  let subscription;
  try { subscription = parseChatSubscription(url.searchParams); }
  catch (err) { sendJson(res, err.statusCode || 400, { error: err.code || 'invalid_chat_subscription' }); return true; }
  const principal = `${req._authContext.kind}:${req._authContext.principalId}`;
  if (!hub.canAddChatClient(principal)) return false;
  let unsubscribe;
  const client = hub.addClient(res, validate, { chatPrincipal: principal, onClose: () => unsubscribe?.() });
  unsubscribe = observer.subscribe(subscription, {
    validate,
    send: (event, data) => hub.sendTo(client, event, data),
    onStop: reason => {
      if (reason === 'chat_unavailable') {
        hub.sendTo(client, 'chat_unavailable', { version: 1, ...subscription, ids: [] });
        hub.detachChat(client);
        return;
      }
      hub.removeClient(res);
      if (!res.writableEnded) res.end();
    }
  });
  if (!hub.clients.has(client)) unsubscribe();
  return true;
}
