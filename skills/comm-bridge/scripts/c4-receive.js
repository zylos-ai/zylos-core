#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as database from './c4-db.js';
import { reserveStatusNotice, sendStatusNotice } from './status-notice.js';
import { validateChannel, validateEndpoint } from './c4-validate.js';
import { validateGroupName, composeSessionGroup, dataError, isDataError } from './c4-session-group.js';
import { appendEntryEvent } from './c4-entry-events.js';
import { queryRoute } from './c4-entry-route.js';

export function parseReceiveArgs(args) {
  const result = { channel: null, endpoint: null, content: null, priority: 3,
    noReply: false, requireIdle: false, json: false };
  const values = { '--channel': 'channel', '--endpoint': 'endpoint', '--content': 'content',
    '--priority': 'priority', '--session-group': 'groupName', '--core-source': 'coreSource' };
  const flags = { '--no-reply': 'noReply', '--json': 'json', '--require-idle': 'requireIdle', '--block-queue-until-idle': 'requireIdle' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flags[arg]) result[flags[arg]] = true;
    else if (values[arg]) {
      if (args[i + 1] === undefined) throw dataError('INVALID_ARGS', `Missing value for ${arg}`);
      result[values[arg]] = args[++i];
    } else throw dataError('INVALID_ARGS', `Unknown option: ${arg}`);
  }
  if (!result.content) throw dataError('INVALID_ARGS', '--content is required');
  if (!result.channel && !result.noReply) throw dataError('INVALID_ARGS', '--channel is required unless --no-reply is set');
  if (!/^[123]$/.test(String(result.priority))) throw dataError('INVALID_ARGS', '--priority must be an integer 1, 2, or 3');
  result.priority = Number(result.priority);
  if (result.coreSource !== undefined && result.coreSource !== 'scheduler') throw dataError('INVALID_ARGS', 'Unknown --core-source');
  return result;
}

export async function receive(args, dependencies = {}) {
  const db = dependencies.db ?? database;
  const routeQuery = dependencies.queryRoute ?? queryRoute;
  const append = dependencies.appendEntryEvent ?? appendEntryEvent;
  const reserve = dependencies.reserveStatusNotice ?? reserveStatusNotice;
  const send = dependencies.sendStatusNotice ?? sendStatusNotice;
  const diagnostic = dependencies.diagnostic ?? console.error;
  const input = parseReceiveArgs(args);
  const { channel: rawChannel, endpoint, content, noReply, priority, requireIdle, groupName, coreSource } = input;
  if (endpoint !== null) {
    try { validateEndpoint(endpoint); }
    catch (error) { throw dataError('INVALID_ARGS', `invalid endpoint: ${error.message}`); }
  }
  try {
    if (rawChannel) validateChannel(rawChannel, true);
    if (groupName !== undefined) validateGroupName(groupName);
  } catch (error) {
    const code = error.code?.startsWith('SESSION_GROUP_') ? error.code : 'INVALID_ARGS';
    await append({ event: 'group_rejected', conversation_id: null, channel: rawChannel || '', endpoint: endpoint || '',
      session_group: '', runtime: '', reason_code: code, detail: '' });
    throw dataError(code, code === 'INVALID_ARGS' ? `invalid channel or endpoint: ${error.message}` : error.message);
  }
  const channel = rawChannel || 'system';
  const binding = rawChannel ? db.getChannelNamespace(rawChannel) : null;
  const preGroup = rawChannel ? (binding ? composeSessionGroup(binding.namespace, groupName) : null) : 'origin';
  const request = { version: 2, type: 'route', requestId: `${process.pid}-${Date.now()}`, channel,
    endpoint, noReply, receivedAt: Date.now(), sessionGroup: preGroup, componentName: rawChannel,
    ...(coreSource ? { coreSide: true, coreSource } : {}) };
  const route = await routeQuery(request);
  const pending = route.decision === 'pending';
  const auth = route.decision === 'auth_rejected';
  let record;
  try {
    record = db.insertConversation('in', channel, noReply ? null : endpoint, content, {
      status: pending ? 'pending' : 'failed', priority, requireIdle,
      ...(auth ? { deliveryAction: 'auth_rejected' } : {}),
      ...(groupName !== undefined ? { groupName } : {}) });
  } catch (error) {
    if (isDataError(error)) throw error;
    throw dataError('INTERNAL_ERROR', 'Inbound commit state is unknown; do not resend without checking.',
      { persisted: null, cause: error });
  }
  const result = { ok: true, action: pending ? 'queued' : auth ? 'auth_rejected' : 'delivered',
    id: record.id, sessionGroup: record.session_group, runtime: route.runtime };
  if (auth) result.reasonLogged = await append({ event: 'auth_rejected', conversation_id: record.id,
    channel: record.channel, endpoint: record.endpoint_id || '', session_group: record.session_group,
    runtime: route.runtime, reason_code: route.auth.result === 'failed' ? 'auth_check_failed' : 'auth_check_unconfirmed',
    detail: route.auth.detail });
  if (pending || noReply) return result;
  const persisted = ['D1'];
  let claim;
  const finalRoute = { ...route, sessionGroup: record.session_group };
  try { claim = reserve(channel, endpoint, finalRoute); }
  catch {
    diagnostic(`status notice reservation failed after conversation ${record.id} committed`);
    throw dataError('UNHEALTHY_NOTIFY_FAILED', 'Inbound committed; status notice reservation failed. Do not resend.', { persisted, id: record.id });
  }
  if (claim.suppressed) {
    if (!auth) {
      try {
        if (!db.markStatusNoticeSuppressed(record.id, { sessionGroup: record.session_group,
          channel: record.channel, endpointId: record.endpoint_id, health: route.health || 'unavailable', reason: route.reason || route.health || 'unavailable' })) {
          diagnostic(`status notice suppression did not match conversation ${record.id}`);
        }
      } catch { diagnostic(`status notice suppression update failed for conversation ${record.id}`); }
      result.action = 'suppressed';
    }
    return result;
  }
  const sent = send(claim, route.userMessage, finalRoute);
  if (sent.outcome === 'sent') return result;
  throw dataError(sent.outcome === 'failed' ? 'UNHEALTHY_NOTIFY_FAILED' : 'UNHEALTHY_NOTIFY_UNCERTAIN',
    `Inbound committed; status notice ${sent.outcome}. Do not resend.`, { persisted, id: record.id });
}

export async function main(args = process.argv.slice(2)) {
  const json = args.includes('--json');
  try {
    const result = await receive(args);
    console.log(json ? JSON.stringify(result) : `[C4] Message ${result.action === 'queued' ? 'queued' : 'handled'} (id=${result.id}, action=${result.action})`);
  } catch (error) {
    const contractError = isDataError(error);
    const code = contractError ? error.code : 'INTERNAL_ERROR';
    const persisted = contractError ? error.persisted ?? null : [];
    if (json) console.log(JSON.stringify({ ok: false, error: { code, message: error.message, persisted, ...(error.id ? { id: error.id } : {}) } }));
    else console.error(`Error [${code}]: ${error.message}`);
    process.exitCode = 1;
  } finally { database.close(); }
}
function isMainModule() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isMainModule()) await main();
