import { requireChatAccess } from './access.js';
import { sendJson } from '../http.js';

export async function handleChatHistory(req, res, url, { auth, config, history }) {
  const match = /^\/api\/chat\/conversations(?:\/([^/]+)\/(messages|status))?$/.exec(url.pathname);
  if (!match) return false;
  const denied = requireChatAccess(req, auth, config);
  if (denied) { const { status, ...body } = denied; sendJson(res, status, body); return true; }
  if (req.method !== 'GET') { sendJson(res, 405, { error: 'method_not_allowed' }); return true; }
  try {
    const options = Object.fromEntries(url.searchParams);
    const permitted = match[2] === 'status' ? ['tab', 'ids'] : match[2] === 'messages' ? ['tab', 'limit', 'cursor', 'direction', 'recheckIds', 'locale'] : ['tab', 'limit', 'cursor', 'locale'];
    if ([...url.searchParams.keys()].some(key => !permitted.includes(key) || url.searchParams.getAll(key).length !== 1)) {
      sendJson(res, 400, { error: 'invalid_chat_parameters' }); return true;
    }
    if (options.locale !== undefined && !['zh', 'en'].includes(options.locale)) {
      sendJson(res, 400, { error: 'invalid_chat_parameters' }); return true;
    }
    let id;
    try { id = match[1] && decodeURIComponent(match[1]); }
    catch { sendJson(res, 400, { error: 'invalid_chat_conversation' }); return true; }
    const result = match[2] ? history[match[2]](id, options) : history.list(options);
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, error.statusCode || 502, { error: error.code || 'chat_history_unavailable' });
  }
  return true;
}
