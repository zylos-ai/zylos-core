import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveCoreConfigModule } from './core-config-loader.js';
import { sendError } from './c4-send-args.js';
import { safeEntryId } from './c4-entry-id.js';
import { queryComponentSessionGroup, fixedAddressSessionGroup } from './c4-component-session-group.js';
import { assertOutboundSession } from './c4-outbound-session.js';
import { readChannelHookMetadata, runBeforeSendHook } from './c4-channel-hooks.js';

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
    return { kind: 'external', channel: record.channel, endpoint: record.endpoint_id,
      id: exactId, runId };
  })();
}

export function assertEndpointPassable(endpoint, id) {
  if (endpoint === null) return;
  if (typeof endpoint !== 'string' || !endpoint) throw sendError('INVALID_ARGS', 'Invalid endpoint');
  if (endpoint.includes('\0') || Buffer.byteLength(endpoint) > ARG_PAYLOAD_MAX) {
    throw sendError('ENDPOINT_NOT_PASSABLE', `Endpoint cannot be passed as an argv value${id === undefined ? '' : ` (id: ${id})`}`);
  }
}

export async function sendExternal(request, message, { api, skillsDir, env = process.env } = {}) {
  const { channel, endpoint } = request;
  if (typeof channel !== 'string' || !channel || channel.includes('..') || /[/\\\0]/.test(channel)) {
    throw sendError('INVALID_ARGS', 'Invalid channel');
  }
  const script = path.join(skillsDir, channel, 'scripts', 'send.js');
  try {
    if (!fs.statSync(script, { throwIfNoEntry: false })?.isFile()) throw new Error('Channel script not found');
  } catch {
    throw sendError('INVALID_ARGS', 'Invalid channel: Channel script not found or component unavailable');
  }
  assertEndpointPassable(endpoint, request.id);
  const hasSender = Object.hasOwn(env, 'ZYLOS_SESSION_GROUP');
  const senderGroup = env.ZYLOS_SESSION_GROUP;
  if (hasSender && (typeof senderGroup !== 'string' || !senderGroup ||
      (senderGroup !== 'origin' && !api.getDb().prepare('SELECT 1 FROM group_heads WHERE session_group=?').get(senderGroup)))) {
    throw sendError('UNKNOWN_GROUP', 'Unknown sender session group');
  }
  const fixed = fixedAddressSessionGroup(channel, endpoint);
  let groupName = fixed || undefined;
  if (!fixed) {
    try {
      groupName = queryComponentSessionGroup({ component: channel, endpoint }, { skillsDir, env }).groupName ?? undefined;
    } catch (error) {
      if (error.code !== 'SESSION_GROUP_QUERY_FAILED') throw error;
      throw Object.assign(sendError(error.code,
        `${error.message}. Nothing was sent or recorded. This is a component bug or an environment problem: tell your user the message was not sent and report the error. Do not retry through another thread.`),
      { reason: error.reason, stderr: error.stderr });
    }
  }
  const route = { groupName, wholeGroup: groupName === undefined };
  if (hasSender) {
    const ownerGroup = fixed || api.resolveSessionGroup('out', channel, endpoint, route);
    assertOutboundSession(senderGroup, ownerGroup, request);
  }
  const stdinDelivery = readChannelHookMetadata(channel, { skillsDir })?.delivery === 'stdin';
  await runBeforeSendHook({ ...request, ...route }, message, { skillsDir, env });
  const record = api.insertConversation('out', channel, endpoint, message,
    { status: 'delivered', ...route, sessionId: senderSessionId(env) });
  return new Promise((resolve, reject) => {
    let child;
    let inputError;
    const spawnFailed = error => reject(sendError('COMPONENT_SPAWN_FAILED',
      `Component did not start (${error.code || 'UNKNOWN'}); audit retained; not sent`));
    const args = stdinDelivery ? [script] : [script, ...(endpoint === null ? [] : [endpoint]), message];
    try { child = spawn(process.execPath, args, { env, stdio: stdinDelivery ? ['pipe', 'inherit', 'inherit'] : 'inherit' }); }
    catch (error) { spawnFailed(error); return; }
    child.once('error', spawnFailed);
    child.once('close', (code, signal) => {
      if (code === 0 && !inputError) resolve(record);
      else reject(Object.assign(sendError('SEND_FAILED', `Failed to send: ${inputError ? 'component stdin failed' : `component exit ${code ?? signal}`}; audit retained; delivery unconfirmed`), { exitCode: inputError && code === 0 ? 1 : code }));
    });
    if (stdinDelivery) {
      child.stdin.on('error', error => { inputError = error; });
      child.stdin.end(JSON.stringify({ version: 1, c4_id: record.id, channel: record.channel,
        endpoint_id: record.endpoint_id, session_group: record.session_group, content: message }));
    }
  });
}

export function recordVoid(request, message, { api, env = process.env } = {}) {
  if (!request.endpoint) throw sendError('INVALID_ARGS', 'Endpoint is required for the void channel');
  const group = Object.hasOwn(env, 'ZYLOS_SESSION_GROUP') ? env.ZYLOS_SESSION_GROUP : env.ZYLOS_RUN_ID ? 'origin' : null;
  if (group === '') throw sendError('UNKNOWN_GROUP', 'Unknown recording group');
  return api.insertConversation('out', 'void', request.endpoint, message,
    { status: 'delivered', handoffGroup: group, sessionId: senderSessionId(env) });
}
