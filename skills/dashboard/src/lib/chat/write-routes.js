import { requireChatAccess, requireChatWrite } from './access.js';
import { readJsonBody, sendJson } from '../http.js';
import { attachmentPrincipal } from './attachment-routes.js';

const deniedResponse = (res, denied) => {
  const { status, ...body } = denied;
  sendJson(res, status, body);
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Only registered Dashboard conversations can be written; routing never comes from the body. */
export async function handleChatConversations(req, res, url, { auth, config, conversations, sender, readMode }) {
  const draft = url.pathname === '/api/chat/drafts';
  const match = /^\/api\/chat\/conversations\/([^/]+)(\/send)?$/.exec(url.pathname);
  if (!draft && !match) return false;
  const read = !draft && !match[2] && req.method === 'GET';
  const preflight = read ? requireChatAccess(req, auth, config)
    : requireChatWrite(req, auth, config, { mode: readMode(), draft: true });
  if (preflight) { deniedResponse(res, preflight); return true; }
  const allowed = draft ? req.method === 'POST' : match[2] ? req.method === 'POST' : ['GET', 'PATCH'].includes(req.method);
  if (!allowed) { sendJson(res, 405, { error: 'method_not_allowed' }); return true; }
  try {
    if ([...url.searchParams].length) {
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
    const permitted = draft ? ['displayName'] : match[2] ? ['content', 'retry', 'attachments'] : ['displayName'];
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
      sendJson(res, 200, await sender.send(id, body, { authorize, principal: attachmentPrincipal(req._authContext) }));
    } else {
      const row = await sender.resolve(id);
      const denied = authorize(row);
      if (denied) { deniedResponse(res, denied); return true; }
      sendJson(res, 200, { conversation: conversations.rename(row.localId, body.displayName) });
    }
  } catch (error) {
    sendJson(res, error.statusCode || error.status || 502, {
      error: error.code || error.message || 'chat_write_failed',
      ...(error.statusCode === 409 && typeof error.conversationId === 'string'
        ? { conversationId: error.conversationId, preserveInput: true } : {}),
    });
  }
  return true;
}
