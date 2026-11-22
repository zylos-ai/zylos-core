import { requireChatAccess, requireChatWrite, requireChatWritePreflight } from './access.js';
import { readJsonBody, sendJson } from '../http.js';
import { attachmentPrincipal } from './attachment-routes.js';
import { listErrorBody, listFailure } from '../list-query.js';
import { chatQuery } from './history.js';

const deniedResponse = (res, denied) => {
  const { status, ...body } = denied;
  sendJson(res, status, body);
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Only registered Dashboard conversations can be written; routing never comes from the body. */
export async function handleChatConversations(req, res, url, { auth, config, conversations, sender, history, readMode }) {
  const draft = url.pathname === '/api/conversations/drafts';
  const pins = url.pathname === '/api/conversations/pins';
  const match = draft || pins ? null : /^\/api\/conversations\/([^/]+)(?:\/(send|read))?$/.exec(url.pathname);
  const markRead = match?.[2] === 'read';
  if (!draft && !match && !pins) return false;
  const read = Boolean(match && !match[2] && req.method === 'GET');
  const preflight = read ? requireChatAccess(req, auth, config)
    : draft ? requireChatWrite(req, auth, config, { mode: readMode(), draft: true })
      : requireChatWritePreflight(req, auth, config);
  if (preflight) { deniedResponse(res, preflight); return true; }
  const allowed = pins || markRead ? req.method === 'PUT' : draft ? req.method === 'POST' : match[2] ? req.method === 'POST' : ['GET', 'PATCH'].includes(req.method);
  if (!allowed) { sendJson(res, 404, { error: 'not_found' }); return true; }
  try {
    let pinTab;
    if (pins) {
      try { pinTab = chatQuery(url.searchParams, 'conversations:pins', { paging: false }).filters.tab; }
      catch { sendJson(res, 400, { error: 'invalid_chat_parameters' }); return true; }
    } else if (url.searchParams.size) {
      if (markRead) throw listFailure(400, 'invalid_parameter', 'Unexpected query parameter', url.searchParams.keys().next().value);
      sendJson(res, 400, { error: 'invalid_chat_parameters' }); return true;
    }
    let id;
    try { id = match && decodeURIComponent(match[1]); }
    catch { sendJson(res, 400, { error: 'invalid_chat_conversation' }); return true; }
    if (read) {
      const receipt = await sender.reconcile(id);
      let row;
      try { row = conversations.get(receipt.localId); }
      catch (error) {
        if (error.code !== 'chat_conversation_not_found') throw error;
        row = await sender.resolve(id);
      }
      sendJson(res, 200, { ...receipt, conversation: row });
      return true;
    }
    const body = await readJsonBody(req, 512 * 1024);
    if (markRead) {
      if (!object(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'upTo')) {
        throw listFailure(400, 'invalid_parameter', 'Invalid upTo', 'upTo');
      }
      sendJson(res, 200, { readUpTo: history.markRead(id, body.upTo) });
      return true;
    }
    if (pins) {
      if (!object(body) || Object.keys(body).length !== 1 || !Array.isArray(body.ids)) {
        sendJson(res, 400, { error: 'invalid_chat_parameters' }); return true;
      }
      sendJson(res, 200, { ids: history.replacePins(body.ids, pinTab) });
      return true;
    }
    const permitted = draft ? ['displayName'] : match[2] ? ['content', 'retry', 'attachments', 'quote'] : ['displayName'];
    if (!object(body) || Object.keys(body).some(key => !permitted.includes(key))
        || (Object.hasOwn(body, 'retry') && typeof body.retry !== 'boolean')
        || (!draft && !match[2] && !Object.hasOwn(body, 'displayName'))) {
      sendJson(res, 400, { error: 'invalid_chat_parameters' }); return true;
    }
    if (draft) {
      const denied = requireChatWrite(req, auth, config, { mode: readMode(), draft: true });
      if (denied) { deniedResponse(res, denied); return true; }
      sendJson(res, 201, { conversation: conversations.create(body) });
      return true;
    }
    const authorize = record => requireChatWrite(req, auth, config, {
      mode: readMode(), conversation: record, namespace: record.namespace, localId: record.localId,
      draft: record.namespace === null && record.state !== 'active',
    });
    if (match[2]) {
      const receipt = await sender.send(id, body, { authorize, principal: attachmentPrincipal(req._authContext) });
      if (receipt.stored === true && receipt.messageId) {
        try { history?.markRead(receipt.conversationId, receipt.messageId); }
        catch (error) {
          // The send has committed. Preserve its receipt even if local read
          // position storage temporarily fails.
          console.error('[chat] Could not advance the read position after send:', error.code || error.name);
        }
      }
      sendJson(res, 200, receipt);
    } else {
      const row = await sender.resolve(id);
      const denied = authorize(row);
      if (denied) { deniedResponse(res, denied); return true; }
      sendJson(res, 200, { conversation: conversations.rename(row.localId, body.displayName) });
    }
  } catch (error) {
    if (markRead) {
      const failure = error.statusCode && !error.code?.startsWith('chat_') ? error
        : error.status ? listFailure(error.status, error.message, error.message)
          : listFailure(503, 'unavailable', 'Conversation data is unavailable');
      sendJson(res, failure.statusCode, listErrorBody(failure));
      return true;
    }
    sendJson(res, error.statusCode || error.status || 502, {
      error: error.code || error.message || 'chat_write_failed',
      ...(error.statusCode === 409 && typeof error.conversationId === 'string'
        ? { conversationId: error.conversationId, preserveInput: true } : {}),
    });
  }
  return true;
}
