import { requireChatAccess } from './access.js';
import { sendJson } from '../http.js';
import { canDeleteConversations } from '../workbench/group-deletion.js';
import { listErrorBody, listFailure } from '../list-query.js';
import { chatCollection, chatQuery } from './history.js';

const text = value => value;
const queryOptions = {
  messages: { extras: { direction: ['before', 'after'], anchor: ['read'], recheckIds: text } },
  status: { paging: false, extras: { ids: text } },
  activity: { paging: false, extras: { subtask: text } },
};
const invalid = param => listFailure(400, 'invalid_parameter', `Invalid ${param}`, param);

function historyFailure(error, kind) {
  switch (error.code) {
    case 'invalid_chat_limit': return invalid('limit');
    case 'invalid_chat_tab': return invalid('tab');
    case 'invalid_chat_direction': return invalid('direction');
    case 'invalid_chat_parameters': return invalid(error.param || 'query');
    case 'invalid_chat_subtask': return invalid('subtask');
    case 'invalid_chat_message_ids': return invalid(kind === 'status' ? 'ids' : 'recheckIds');
    case 'invalid_chat_conversation': return invalid('id');
    case 'invalid_chat_cursor': return listFailure(400, 'invalid_cursor', 'The cursor is no longer valid; reload the first page');
    case 'chat_conversation_not_found':
    case 'chat_message_not_found': return listFailure(404, 'not_found', 'The requested conversation or message does not exist');
    case 'chat_history_unavailable':
    case 'chat_activity_unavailable': return listFailure(503, 'unavailable', 'Conversation data is unavailable');
    default: return error.statusCode && error.code ? error
      : listFailure(503, 'unavailable', 'Conversation data is unavailable');
  }
}

/**
 * `instanceTz` is the schedule page's time zone reader (the instance .env TZ). The conversation list and message pages
 * carry it as `tz`, so the page shows message times and reads daily chart points in the agent's time zone; null when
 * it is unknown.
 */
export async function handleChatHistory(req, res, url, { auth, config, history, activity = null, instanceTz = null }) {
  const match = /^\/api\/conversations(?:\/([^/]+)\/(messages|status|activity))?$/.exec(url.pathname);
  if (!match) return false;
  const denied = requireChatAccess(req, auth, config);
  if (denied) { const { status, ...body } = denied; sendJson(res, status, body); return true; }
  if (req.method !== 'GET') { sendJson(res, 404, { error: 'not_found' }); return true; }
  const kind = match[2];
  try {
    let id;
    try { id = match[1] && decodeURIComponent(match[1]); }
    catch { throw invalid('id'); }
    if (kind === 'activity' && !activity) throw listFailure(404, 'not_found', 'Conversation activity is unavailable');
    const collection = chatCollection(id, kind);
    const page = chatQuery(url.searchParams, collection, kind ? queryOptions[kind] : { q: true });
    const options = { tab: page.filters.tab, ...page.extras, limit: page.limit, page,
      locale: req.headers['x-zylos-locale'] === 'en' ? 'en' : 'zh' };
    if (options.anchor && options.tab !== 'mine') throw invalid('anchor');
    const result = kind === 'activity' ? await activity.activity(id, options)
      : kind ? history[kind](id, options) : history.list({ ...options, includeSummary: auth.resolveAuthContext(req)?.scope === 'admin' });
    if (!kind || kind === 'messages') result.tz = await readInstanceTz(instanceTz);
    if (!kind) result.deletionAllowed = canDeleteConversations(req, auth, config);
    sendJson(res, 200, result);
  } catch (error) {
    const failure = historyFailure(error, kind);
    sendJson(res, failure.statusCode, listErrorBody(failure));
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
