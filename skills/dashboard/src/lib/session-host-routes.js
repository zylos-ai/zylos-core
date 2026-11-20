import { readJsonBody, sendJson } from './http.js';
import { isSameOriginRequest } from './request-origin.js';
import { parseSessionGroup } from '../../../comm-bridge/scripts/c4-session-group.js';
import { notifySessionHostAllowlist } from '../../../comm-bridge/scripts/c4-host-notice.js';

export const SESSION_HOST_PATH = '/api/session-hosts';
export const SESSION_HOST_CHANNELS_PATH = `${SESSION_HOST_PATH}/channels`;

export function createSessionHostRoutes({ auth, loadStore = () => import('../../../comm-bridge/scripts/c4-db.js'),
  notifyAllowlist = notifySessionHostAllowlist }) {
  return async (req, res, url) => {
    const channelsRoute = url.pathname === SESSION_HOST_CHANNELS_PATH;
    if (url.pathname !== SESSION_HOST_PATH && !channelsRoute) return false;
    const context = auth.resolveAuthContext(req);
    if (context?.kind !== 'cookie' || context.scope !== 'admin') {
      sendJson(res, 403, { error: 'local_cookie_required' });
      return true;
    }
    if (channelsRoute && req.method !== 'GET') {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    if (req.method === 'POST' && !isSameOriginRequest(req)) {
      sendJson(res, 403, { error: 'same_origin_required' });
      return true;
    }
    if (!['GET', 'POST'].includes(req.method)) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    try {
      const store = await loadStore();
      if (req.method === 'GET') {
        const result = channelsRoute ? { channels: store.listSessionHostChannels() } : store.listSessionHosts();
        sendJson(res, 200, result);
        return true;
      }
      const body = await readJsonBody(req, 4096);
      const action = body?.action;
      let changed;
      if (action === 'detach' && parseSessionGroup(body.group)) {
        changed = store.detachSessionHost(body.group);
      } else if (['allow', 'disallow'].includes(action) && typeof body.channel === 'string' && body.channel) {
        const allowed = action === 'allow';
        changed = store.setSessionHostAllowlist(body.channel, allowed);
        if (changed) await notifyAllowlist(body.channel, allowed);
      } else {
        sendJson(res, 400, { error: 'invalid_host_action' });
        return true;
      }
      sendJson(res, 200, { changed, ...store.listSessionHosts() });
    } catch (error) {
      const status = error.status ?? (error.code === 'INVALID_ARGS' ? 400 : 502);
      sendJson(res, status, { error: status === 502 ? 'session_host_unavailable' : error.code ?? error.message });
    }
    return true;
  };
}
