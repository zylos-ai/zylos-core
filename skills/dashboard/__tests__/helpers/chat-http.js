import crypto from 'node:crypto';
import http from 'node:http';
import { AuthGate } from '../../src/lib/auth.js';
import { FleetProxy } from '../../src/lib/fleet-proxy.js';
import { sendJson } from '../../src/lib/http.js';
import { isChatDataRoute, requireChatAccess, requireChatWrite } from '../../src/lib/chat/access.js';
import { handleChatSettings } from '../../src/lib/chat/settings.js';

export const chatRoutes = [
  ...['/api/chat/conversations', ...['messages', 'status', 'questions'].map(kind => `/api/chat/conversations/local-chat/${kind}`)]
    .map(path => ({ method: 'GET', path })),
  { method: 'POST', path: '/api/chat/drafts' },
  ...['send', 'answers'].map(kind => ({ method: 'POST', path: `/api/chat/conversations/local-chat/${kind}` })),
];
export const tokens = { read: `zylos_st_${'a'.repeat(64)}`, admin: `zylos_st_${'b'.repeat(64)}` };
const cookie = 'isolated-browser-session';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

export async function chatHttpFixture(t, config = {}, { workbench, localConfig = {} } = {}) {
  const store = {
    getSession: hash => hash === digest(cookie) ? { created_at: Date.now(), last_activity_at: Date.now() } : null,
    touchSession() {}, deleteSession() {}, cleanupSessions() {}, cleanupExpiredApiSessions() {},
    getApiSession(hash) {
      const scope = Object.keys(tokens).find(scope => hash === digest(tokens[scope]));
      return scope ? { api_key_id: scope, scope, expires_at: Date.now() + 60_000 } : null;
    },
  };
  const settings = { auth: { enabled: true, password: 'scrypt:fixture' }, chat: { allowRemote: false }, ...config };
  // Every saved switch change, as the settings route reports it to its listeners.
  const settingsChanges = [];
  const auth = new AuthGate(settings, store);
  const hubSettings = { auth: { enabled: true, password: 'scrypt:fixture' }, chat: { allowRemote: false }, ...localConfig };
  const hubAuth = new AuthGate(hubSettings, store);
  const counts = { reads: 0, receives: 0, upstream: 0 };
  let mode = 'multi';
  let record = { channel: 'dashboard', namespace: 'dashboard-owned', localId: 'local-chat' };
  // The server-resolved owner of the requested conversation.
  let owner = { namespace: 'dashboard-owned', localId: 'local-chat' };
  let proxy;
  const servers = [];
  async function start(isHub) {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        if (await (isHub ? hubAuth : auth).handle(req, res, url)) return;
        if (isHub) { await proxy.handle(req, res, url); return; }
        if (await handleChatSettings(req, res, url, { auth, config: settings, onChange: chat => settingsChanges.push(chat) })) return;
        if (workbench && ['/api/workbench/groups', '/api/workbench/groups/search', '/api/workbench/activity'].includes(url.pathname)) {
          sendJson(res, 200, await workbench(url)); return;
        }
        if (isChatDataRoute(req.method, url.pathname)) {
          const denied = req.method === 'GET' ? requireChatAccess(req, auth, settings) :
            requireChatWrite(req, auth, settings, { mode, draft: url.pathname.endsWith('/drafts'),
              conversation: record, namespace: owner.namespace, localId: owner.localId });
          if (denied) { const { status, ...body } = denied; sendJson(res, status, body); return; }
          counts[req.method === 'GET' ? 'reads' : 'receives']++;
          sendJson(res, 200, { content: 'PRIVATE_BODY', summary: 'PRIVATE_SUMMARY', count: 12, questions: ['PRIVATE_QUESTION'] });
          return;
        }
        sendJson(res, 404, { error: 'not_found' });
      } catch (error) { sendJson(res, 500, { error: error.message }); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }
  const remote = await start(false);
  proxy = new FleetProxy({ config: { fleet: { agents: [{ name: 'Remote', base_url: remote }] } },
    poller: { getSessionToken: async () => tokens.admin }, fetch: async (...args) => { counts.upstream++; return fetch(...args); } });
  const hub = await start(true);
  t.after(async () => {
    clearInterval(auth._cleanupTimer);
    clearInterval(hubAuth._cleanupTimer);
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  async function request(route, { identity = 'cookie', fleet = false, origin = true, body = '{}', contentType = 'application/json' } = {}) {
    const base = fleet ? hub : remote;
    const headers = { 'content-type': contentType };
    if (identity === 'cookie') headers.cookie = `__Secure-zylos_dashboard_session=${cookie}`;
    else if (tokens[identity]) headers.authorization = `Bearer ${tokens[identity]}`;
    if (origin !== null) headers.origin = origin === true ? base : origin || 'https://other.invalid';
    const response = await fetch(`${base}${fleet ? '/fleet/Remote' : ''}${route.path}`, {
      method: route.method, headers, ...(['GET', 'HEAD'].includes(route.method) ? {} : { body }) });
    return { status: response.status, text: await response.text() };
  }
  return { request, config: settings, localConfig: hubSettings, counts, settingsChanges, auth, setMode: value => { mode = value; }, setRecord: value => { record = value; },
    setOwner: value => { owner = value; } };
}
