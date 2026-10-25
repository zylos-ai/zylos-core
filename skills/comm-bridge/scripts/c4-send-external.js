import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveCoreConfigModule } from './core-config-loader.js';
import { sendError } from './c4-send-args.js';
import { safeEntryId } from './c4-entry-id.js';

const pathsModule = path.join(path.dirname(resolveCoreConfigModule()), 'session-group-paths.js');
const { runDirFromEnv, legacyRunDir } = await import(pathToFileURL(pathsModule).href);

export const ARG_PAYLOAD_MAX = 131071;

export function senderSessionId(env = process.env) {
  try {
    const filename = env.ZYLOS_RUN_ID
      ? path.join(runDirFromEnv(env).dir, 'current-session.json')
      : path.join(legacyRunDir(env), 'foreground-session.json');
    const identity = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (env.ZYLOS_RUN_ID && identity.runId !== env.ZYLOS_RUN_ID) return null;
    const sessionId = env.ZYLOS_RUN_ID ? identity.sessionId : identity.session_id;
    return typeof sessionId === 'string' && sessionId ? sessionId : null;
  } catch { return null; }
}

export function readAbsorbedReply(runId, id, api) {
  const exactId = safeEntryId(id);
  if (exactId === null) throw sendError('ABSORBED_NOT_IN_RUN', 'Conversation is not absorbed in this run');
  return api.getDb().transaction(() => {
    const run = api.getModeTransition({ runId });
    if (!run) throw sendError('RUN_NOT_FOUND', 'Mode transition does not exist');
    if (!run.absorbed_ids.includes(exactId)) throw sendError('ABSORBED_NOT_IN_RUN', 'Conversation is not absorbed in this run');
    const [record] = api.getConversationsByRange(exactId, exactId);
    if (!record || record.status !== 'switch_absorbed') throw sendError('ABSORBED_MISMATCH', 'Absorbed conversation is missing or has changed state');
    const colon = record.session_group?.indexOf(':') ?? -1;
    return { kind: 'external', channel: record.channel, endpoint: record.endpoint_id,
      id, ...(colon >= 0 ? { groupName: record.session_group.slice(colon + 1) } : record.session_group ? { wholeGroup: true } : {}) };
  })();
}

export function assertEndpointPassable(endpoint, id) {
  if (endpoint === null) return;
  if (typeof endpoint !== 'string' || !endpoint) throw sendError('INVALID_ARGS', 'Invalid endpoint');
  if (endpoint.includes('\0') || Buffer.byteLength(endpoint) > ARG_PAYLOAD_MAX) {
    throw sendError('ENDPOINT_NOT_PASSABLE', `Endpoint cannot be passed as an argv value${id === undefined ? '' : ` (id: ${id})`}`);
  }
}

export async function sendExternal(request, message, { api, skillsDir, env = process.env,
  appendFallback } = {}) {
  const { channel, endpoint, groupName, wholeGroup } = request;
  const script = path.join(skillsDir, channel, 'scripts', 'send.js');
  try {
    api.validateChannel(channel, true);
    if (!fs.statSync(script, { throwIfNoEntry: false })?.isFile()) throw new Error('Channel script not found');
  } catch {
    throw sendError('INVALID_ARGS', 'Invalid channel: Channel script not found or component unavailable');
  }
  assertEndpointPassable(endpoint, request.id);
  const record = api.insertConversation('out', channel, endpoint, message,
    { status: 'delivered', groupName, wholeGroup, sessionId: senderSessionId(env) });
  await appendFallback?.(record, groupName);
  return new Promise((resolve, reject) => {
    let child;
    const spawnFailed = error => reject(sendError('COMPONENT_SPAWN_FAILED',
      `Component did not start (${error.code || 'UNKNOWN'}); audit retained; not sent`));
    try { child = spawn('node', [script, ...(endpoint === null ? [] : [endpoint]), message], { stdio: 'inherit' }); }
    catch (error) { spawnFailed(error); return; }
    child.once('error', spawnFailed);
    child.once('close', (code, signal) => {
      if (code === 0) resolve(record);
      else reject(Object.assign(sendError('SEND_FAILED', `Failed to send: component exit ${code ?? signal}; audit retained; delivery unconfirmed`), { exitCode: code }));
    });
  });
}

export function recordVoid(request, message, { api, env = process.env } = {}) {
  if (!request.endpoint) throw sendError('INVALID_ARGS', 'Endpoint is required for the void channel');
  api.validateEndpoint(request.endpoint);
  const group = Object.hasOwn(env, 'ZYLOS_SESSION_GROUP') ? env.ZYLOS_SESSION_GROUP : env.ZYLOS_RUN_ID ? 'origin' : null;
  if (group === null) throw sendError('NO_SESSION_ENV', 'Recording session environment is required');
  if (group === '') throw sendError('UNKNOWN_GROUP', 'Unknown recording group');
  try {
    return api.insertConversation('out', 'void', request.endpoint, message,
      { status: 'delivered', handoffGroup: group, sessionId: senderSessionId(env) });
  } catch (error) {
    if (['SESSION_GROUP_INVALID', 'SESSION_GROUP_TOO_LONG', 'SESSION_GROUP_NOT_FOUND'].includes(error.code)) {
      throw sendError('UNKNOWN_GROUP', 'Unknown recording group');
    }
    throw error;
  }
}
