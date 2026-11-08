import { requireChatAccess } from './access.js';
import { sendJson } from '../http.js';

/**
 * `instanceTz` is the schedule page's time zone reader (the instance .env TZ). Message pages carry it as `tz` so the
 * page reads daily chart points in the agent's time zone; null when it is unknown.
 */
export async function handleChatHistory(req, res, url, { auth, config, history, instanceTz = null }) {
  const match = /^\/api\/chat\/conversations(?:\/([^/]+)\/(messages|status))?$/.exec(url.pathname);
  if (!match) return false;
  const denied = requireChatAccess(req, auth, config);
  if (denied) { const { status, ...body } = denied; sendJson(res, status, body); return true; }
  if (req.method !== 'GET') { sendJson(res, 405, { error: 'method_not_allowed' }); return true; }
  try {
    const options = Object.fromEntries(url.searchParams);
    const permitted = match[2] === 'status' ? ['tab', 'ids'] : match[2] === 'messages' ? ['tab', 'limit', 'cursor', 'direction', 'recheckIds'] : ['tab', 'limit', 'cursor'];
    if ([...url.searchParams.keys()].some(key => !permitted.includes(key) || url.searchParams.getAll(key).length !== 1)) {
      sendJson(res, 400, { error: 'invalid_chat_parameters' }); return true;
    }
    if (match[2] !== 'status') options.locale = req.headers['x-zylos-locale'] === 'en' ? 'en' : 'zh';
    let id;
    try { id = match[1] && decodeURIComponent(match[1]); }
    catch { sendJson(res, 400, { error: 'invalid_chat_conversation' }); return true; }
    const result = match[2] ? history[match[2]](id, options) : history.list(options);
    if (match[2] === 'messages') result.tz = await readInstanceTz(instanceTz);
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, error.statusCode || 502, { error: error.code || 'chat_history_unavailable' });
  }
  return true;
}

async function readInstanceTz(instanceTz) {
  try {
    const zone = instanceTz ? await instanceTz() : null;
    return typeof zone?.tz === 'string' && zone.tz ? zone.tz : null;
  } catch {
    return null;
  }
}
