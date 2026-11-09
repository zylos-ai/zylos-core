import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadCoreModule as defaultLoadCoreModule } from '../core-modules.js';
import { readJsonBody, sendJson } from '../http.js';
import { isSameOriginRequest } from '../request-origin.js';
import { parseSessionGroup } from '../../../../comm-bridge/scripts/c4-session-group.js';

const invalid = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });

/** The child owns Core's C4 writer; this Dashboard process keeps its read-only connection. */
export function createGroupDeletionBridge({ zylosDir, loadCoreModule = defaultLoadCoreModule,
  execute = promisify(execFile), env = process.env } = {}) {
  return async (target, { preview = false, actor, operationId } = {}) => {
    const { groupDeletionCliPath } = await loadCoreModule('group-delete.js');
    const childEnv = { ...env, ZYLOS_DIR: zylosDir };
    delete childEnv.ZYLOS_SESSION_GROUP;
    const args = [groupDeletionCliPath,
      ...(target.draftLocalId ? ['--draft-local-id', target.draftLocalId] : ['--group', target.sessionGroup]),
      preview ? '--preview' : '--yes', '--json', '--actor', actor,
      ...(operationId ? ['--operation-id', operationId] : [])];
    let stdout;
    try { ({ stdout } = await execute(process.execPath, args, { env: childEnv, timeout: 30000, maxBuffer: 1024 * 1024 })); }
    catch (error) {
      if (typeof error.stdout !== 'string' || !error.stdout.trim()) throw invalid('deletion_result_unknown', 502);
      stdout = error.stdout;
    }
    let result;
    try { result = JSON.parse(stdout); } catch { throw invalid('deletion_result_unknown', 502); }
    if (!result || typeof result.ok !== 'boolean') throw invalid('deletion_result_unknown', 502);
    return result;
  };
}

export function isGroupDeletionRoute(pathname) {
  return /^\/api\/workbench\/groups\/[^/]+(?:\/deletion)?$/.test(pathname) ||
    /^\/api\/chat\/drafts\/[^/]+(?:\/deletion)?$/.test(pathname);
}

export function canDeleteConversations(req, auth, config) {
  const context = auth.enabled && config.auth?.password ? auth.resolveAuthContext(req) : null;
  return context?.kind === 'cookie' && context.scope === 'admin';
}

/** Only the local password owner may preview or delete; API keys never grant this operation. */
export function createGroupDeletionRoutes({ auth, config, conversations,
  core = createGroupDeletionBridge({ zylosDir: config.zylosDir }) } = {}) {
  return async (req, res, url) => {
    const group = /^\/api\/workbench\/groups\/([^/]+)(\/deletion)?$/.exec(url.pathname);
    const draft = /^\/api\/chat\/drafts\/([^/]+)(\/deletion)?$/.exec(url.pathname);
    if (!group && !draft) return false;
    const preview = Boolean((group ?? draft)[2]);
    if (!preview && req.method !== 'DELETE') return false;
    if (req.method !== (preview ? 'GET' : 'DELETE')) {
      sendJson(res, 405, { error: 'method_not_allowed' }); return true;
    }
    if (!canDeleteConversations(req, auth, config)) {
      sendJson(res, 403, { error: 'local_cookie_required' }); return true;
    }
    if (!preview && !isSameOriginRequest(req)) {
      sendJson(res, 403, { error: 'same_origin_required' }); return true;
    }
    try {
      let id;
      try { id = decodeURIComponent((group ?? draft)[1]); }
      catch { throw invalid('invalid_deletion_target'); }
      let target;
      if (group) {
        if (!parseSessionGroup(id)) throw invalid('invalid_deletion_target');
        if (id === 'origin') throw invalid('origin_deletion_forbidden', 403);
        target = { sessionGroup: id };
      } else {
        // A namespace can be bound by an upload before any message exists.
        // Core proves whether this is still a draft or an actual group, and
        // can acknowledge an operation after its registration was removed.
        target = { draftLocalId: id };
      }
      const context = auth.resolveAuthContext(req);
      const body = preview ? null : await readJsonBody(req, 4096);
      if (!preview && (!body || body.confirmed !== true || Array.isArray(body) ||
        Object.keys(body).some(key => !['confirmed', 'operationId'].includes(key)) ||
        (typeof body.operationId !== 'string' || !body.operationId || body.operationId.length > 128))) {
        throw invalid('deletion_confirmation_required');
      }
      const result = await core(target, { preview, actor: `dashboard:${context.principalId}`,
        ...(body?.operationId ? { operationId: body.operationId } : {}) });
      const code = result.error?.code ?? result.error;
      const denied = ['ORIGIN_DELETE_FORBIDDEN', 'origin_forbidden'].includes(code);
      const conflict = ['TRANSITION_OPEN', 'transition_open',
        'DELETION_IN_PROGRESS', 'DELETION_OWNERSHIP_MISMATCH', 'DELETION_INFLIGHT', 'DRAFT_BECAME_ACTIVE',
        'FENCE_MISMATCH', 'fence_conflict', 'group_delete_send_pending'].includes(code);
      sendJson(res, result.ok ? result.pending ? 202 : 200 : result.pending ? 202 : denied ? 403 : conflict ? 409 : result.error?.status ?? 400, result);
    } catch (error) {
      sendJson(res, error.statusCode ?? error.status ?? 502, { ok: false, error: { code: error.code ?? 'deletion_unavailable' } });
    }
    return true;
  };
}
