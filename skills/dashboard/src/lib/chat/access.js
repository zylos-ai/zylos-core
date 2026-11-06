import { isSameOriginRequest } from '../request-origin.js';

export const CHAT_SETTINGS_PATH = '/api/chat/settings';

// Keep the proxy's public route contract explicit as handlers are added.
export function isChatDataRoute(method, pathname) {
  return method === 'GET' && (
    pathname === '/api/chat/conversations' ||
    /^\/api\/chat\/conversations\/[^/]+\/(?:messages|status|questions)$/.test(pathname)
  ) || method === 'POST' && (
    pathname === '/api/chat/drafts' ||
    /^\/api\/chat\/conversations\/[^/]+\/(?:send|answers)$/.test(pathname)
  );
}

export function requireChatAccess(req, auth, config) {
  const context = auth.enabled ? auth.resolveAuthContext(req) : null;
  if (!context) return { status: 403, error: 'chat_auth_required' };
  if (context.kind === 'cookie' && context.scope === 'admin') return null;
  if (context.kind !== 'api') return { status: 403, error: 'chat_auth_required' };
  if (config.chat?.allowRemote !== true) {
    return { status: 403, error: 'remote_chat_disabled', message: '对方实例未开放远端查看对话' };
  }
  return context.scope === 'admin' ? null : { status: 403, error: 'insufficient_scope', required: 'admin' };
}

export function requireChatWrite(req, auth, config, { mode, draft = false, conversation, namespace, localId } = {}) {
  const denied = requireChatAccess(req, auth, config);
  if (denied) return denied;
  if (req._authContext.kind === 'cookie' && !isSameOriginRequest(req)) return { status: 403, error: 'same_origin_required' };
  if (mode !== 'multi') return { status: 403, error: 'chat_requires_multi' };
  // Draft creation has no existing record. Sends/answers must pass a stored
  // record and server-owned namespace/local ID, never caller routing fields.
  if (!draft && (!conversation || conversation.channel !== 'dashboard' || !namespace ||
      conversation.namespace !== namespace || !localId || conversation.localId !== localId)) {
    return { status: 403, error: 'chat_conversation_forbidden' };
  }
  return null;
}

export function requireChatSettingsAccess(req, auth) {
  const context = auth.enabled ? auth.resolveAuthContext(req) : null;
  if (context?.kind !== 'cookie' || context.scope !== 'admin') return { status: 403, error: 'local_cookie_required' };
  if (req.method !== 'GET' && !isSameOriginRequest(req)) return { status: 403, error: 'same_origin_required' };
  return null;
}
