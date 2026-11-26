import { isConversationApiPath } from './api-routes.js';
import { API_KEY_PERMISSIONS, customScopePermissions, normalizeApiKeyScope } from '../../public/js/wb/api-key-permissions.js';

export { API_KEY_PERMISSIONS, normalizeApiKeyScope };

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const GROUP = '[^/]+';

/**
 * Which permission a custom key needs for each request: [methods, path pattern, permission]. HEAD and OPTIONS are
 * looked up as GET. A request that matches no row is refused to every custom key, so a new route stays closed to
 * them until it is added here. API key management, the remote-access switch, Fleet machine registration, session
 * hosts, deletion and the /fleet/<name>/ proxy are deliberately absent.
 */
const ROUTE_PERMISSIONS = [
  [['GET'], /^\/api\/instance(?:\/(?:resources|runtime-options|core-update|avatar))?$/, 'instance.read'],
  [['GET'], /^\/api\/health$/, 'instance.read'],
  [['GET'], /^\/api\/settings\/(?:timezone|pricing|chat)$/, 'instance.read'],
  [['PUT'], /^\/api\/instance\/(?:defaults|name)$/, 'instance.settings'],
  [['PUT'], /^\/api\/settings\/(?:pricing|timezone)$/, 'instance.settings'],
  [['POST'], /^\/api\/instance\/actions\/recheck-runtime-cli$/, 'instance.settings'],
  [['POST'], /^\/api\/instance\/actions\/(?:switch-mode|switch-runtime|upgrade-runtime)$/, 'instance.ops'],
  [['POST'], /^\/api\/settings\/timezone\/actions\/restart-services$/, 'instance.ops'],
  [['GET'], /^\/api\/groups(?:\/(?:counts|activity))?$/, 'groups.read'],
  [['GET'], new RegExp(`^/api/groups/${GROUP}(?:/(?:runs|events|messages|backlog|usage))?$`), 'groups.read'],
  [['GET'], new RegExp(`^/api/groups/${GROUP}/restarts/${GROUP}$`), 'groups.read'],
  [['POST'], new RegExp(`^/api/groups/${GROUP}/actions/(?:restart|interrupt|chop-chop)$`), 'groups.control'],
  [['PUT'], new RegExp(`^/api/groups/${GROUP}/config$`), 'groups.settings'],
  [['PUT', 'DELETE'], new RegExp(`^/api/groups/${GROUP}/name$`), 'groups.settings'],
  [['POST'], /^\/api\/groups\/naming-prompt$/, 'groups.settings'],
  [['GET'], /^\/api\/usage\/(?:summary|series|pricing)$/, 'usage.read'],
  [['GET'], /^\/api\/memory\/(?:entries|backlog)$/, 'memory.list'],
  [['GET'], /^\/api\/memory\/(?:file|git)$/, 'memory.read'],
  [['PUT'], /^\/api\/memory\/file$/, 'memory.write'],
  [['GET'], new RegExp(`^/api/schedules(?:/${GROUP}(?:/history)?)?$`), 'schedules.read'],
  [['POST'], new RegExp(`^/api/schedules(?:/${GROUP}/actions/(?:pause|resume))?$`), 'schedules.write'],
  [['PUT', 'DELETE'], new RegExp(`^/api/schedules/${GROUP}$`), 'schedules.write'],
  // A draft's deletion preview (GET .../drafts/<id>/deletion) is a deletion route, not conversation data.
  [['GET'], /^\/api\/conversations(?!\/drafts\/[^/]+\/deletion$)(?:\/.*)?$/, 'conversations.read'],
  [['POST', 'PUT', 'PATCH'], /^\/api\/conversations(?:\/.*)?$/, 'conversations.write'],
  [['GET'], /^\/api\/observer\/(?:status|history\/.+)$/, 'terminal.read'],
  [['GET'], /^\/observer\/(?:frame|stream)$/, 'terminal.control'],
  [['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], /^\/api\/observer\/leases(?:\/.*)?$/, 'terminal.control'],
  [['POST'], /^\/api\/observer\/(?:agent-size|install|enable|disable)$/, 'terminal.control'],
  [['DELETE'], /^\/api\/observer\/install$/, 'terminal.control'],
  [['GET'], /^\/api\/fleet$/, 'fleet.read'],
];

for (const [, , permission] of ROUTE_PERMISSIONS) {
  if (!API_KEY_PERMISSIONS.includes(permission)) throw new Error(`Unknown API key permission in route table: ${permission}`);
}

function normalizePath(pathname) {
  return String(pathname || '').replace(/\/{2,}/g, '/');
}

/** The permission a custom key needs for this request, or null when no custom key may make it. */
export function routePermission(method, pathname, searchParams = null) {
  pathname = normalizePath(pathname);
  const lookup = READ_METHODS.has(method) ? 'GET' : method;
  if (pathname === '/api/stream') {
    if (lookup !== 'GET') return null;
    return searchParams?.has?.('chat') ? 'conversations.read' : 'instance.read';
  }
  for (const [methods, pattern, permission] of ROUTE_PERMISSIONS) {
    if (methods.includes(lookup) && pattern.test(pathname)) return permission;
  }
  return null;
}

/** The read scope's fixed boundary: every write, conversations, terminal history, key and Fleet management, memory files. */
function readScopeRefuses(pathname, method) {
  pathname = normalizePath(pathname);
  if (!READ_METHODS.has(method)) return true;
  if (isConversationApiPath(pathname) || pathname.startsWith('/api/observer/history/') ||
      pathname === '/observer/frame' || pathname === '/observer/stream') return true;
  if (pathname === '/api/fleet/agents' || pathname.startsWith('/api/fleet/agents/')) return true;
  if (pathname === '/api/keys' || pathname.startsWith('/api/keys/')) return true;
  if (pathname === '/api/memory/file' || pathname === '/api/memory/git') return true;
  const proxied = pathname.match(/^\/fleet\/[^/]+(\/api\/.*)$/);
  if (!proxied) return false;
  const remotePath = proxied[1];
  return remotePath === '/api/memory/file' || remotePath === '/api/memory/git' ||
    isConversationApiPath(remotePath) || remotePath.startsWith('/api/observer/history/');
}

export function isCustomScope(scope) {
  return typeof scope === 'string' && scope !== 'read' && scope !== 'admin';
}

/**
 * Whether a scope holds one permission. Admin (and every local browser session) holds all of them; the read scope
 * holds none of them, because the routes that check a permission are the ones read keys were already refused.
 */
export function hasPermission(scope, permission) {
  if (scope === 'admin') return true;
  if (!permission || scope === 'read') return false;
  return customScopePermissions(scope).includes(permission);
}

/**
 * The request-level decision for an API key. Read and admin keep their existing boundaries; a custom key needs the
 * route's permission. `required` names what was missing: "admin" for read keys and for routes no custom key may use.
 */
export function apiKeyRequestDecision(scope, method, pathname, searchParams = null) {
  if (scope === 'admin') return { allowed: true };
  if (scope === 'read') return readScopeRefuses(pathname, method) ? { allowed: false, required: 'admin' } : { allowed: true };
  const permission = routePermission(method, pathname, searchParams);
  if (!permission) return { allowed: false, required: 'admin' };
  return hasPermission(scope, permission) ? { allowed: true } : { allowed: false, required: permission };
}

/**
 * The 403 body for a principal lacking `permission`: custom keys are told the permission, everyone else keeps the
 * existing "admin" answer.
 */
export function scopeRefusal(scope, permission) {
  return { error: 'insufficient_scope', required: isCustomScope(scope) ? permission : 'admin' };
}

/** The 403 body a request refused by apiKeyRequestDecision gets. */
export function insufficientScopeBody(decision) {
  return { error: 'insufficient_scope', required: decision.required };
}
