import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolveCoreConfigModule } from './core-config-loader.js';
import { composeSessionGroup, dataError } from './c4-session-group.js';
import { normalizeStatusEndpoint } from './status-endpoint.js';
import { safeEntryId } from './c4-entry-id.js';

export const entryEventsPath = (env = process.env) => path.join(env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos'), 'comm-bridge', 'receive-events.jsonl');
export const sanitizeEntryDetail = detail => Array.from(String(detail ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '')).slice(0, 500).join('');

export async function appendEntryEvent(event, options = {}) {
  const filename = options.filename ?? entryEventsPath(options.env);
  const value = { v: 1, ts: (options.now ?? Date.now)(), ...event,
    endpoint: normalizeStatusEndpoint(event.endpoint), detail: sanitizeEntryDetail(event.detail) };
  try {
    const create = options.createJsonlStream ?? (await import(pathToFileURL(path.join(path.dirname(resolveCoreConfigModule()), 'jsonl-stream.js')).href)).createJsonlStream;
    await create(filename).append(value);
    return true;
  } catch (error) {
    (options.diagnostic ?? console.error)(`entry event ${event.event} append failed: ${error.code ?? error.message}`);
    return false;
  }
}

export async function appendOutGroupFallback(record, groupName, options = {}) {
  if (groupName === undefined || !record.session_group || record.session_group.includes(':')) return false;
  let reason = 'SESSION_GROUP_NOT_FOUND';
  try { composeSessionGroup(record.session_group, groupName); }
  catch (error) { reason = error.code; }
  return appendEntryEvent({ event: 'out_group_fallback', conversation_id: record.id,
    channel: record.channel, endpoint: record.endpoint_id, session_group: record.session_group,
    runtime: '', reason_code: reason, detail: '' }, options);
}

function retainedFiles(filename, io) {
  let names;
  try { names = io.readdirSync(path.dirname(filename)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw dataError('INTERNAL_ERROR', 'Unable to list rejection logs'); }
  const base = path.basename(filename, '.jsonl');
  const rotations = names.filter(name => name.startsWith(base + '.') && /^\d+\.jsonl$/.test(name.slice(base.length + 1)))
    .sort((a, b) => Number(b.slice(base.length + 1, -6)) - Number(a.slice(base.length + 1, -6)));
  return [filename, ...rotations.map(name => path.join(path.dirname(filename), name))];
}

export function queryRejection(id, { getConversationsByRange, filename = entryEventsPath(), io = fs,
  diagnostic = console.error } = {}) {
  const textId = String(id);
  if (!/^[1-9][0-9]{0,18}$/.test(textId) || (textId.length === 19 && textId > '9223372036854775807')) throw dataError('INVALID_ARGS', 'id must be a positive SQLite integer');
  const exactId = safeEntryId(id);
  if (exactId === null) throw dataError('NOT_FOUND', 'Conversation not found');
  const rows = getConversationsByRange(exactId, exactId);
  const row = rows[0];
  if (!row) throw dataError('NOT_FOUND', 'Conversation not found');
  if (row.status !== 'failed' || row.delivery_action !== 'auth_rejected') throw dataError('NOT_REJECTED', 'Conversation is not an authentication rejection');
  const result = { status: row.status, category: row.delivery_action };
  const visited = new Set();
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const file of retainedFiles(filename, io)) {
      if (visited.has(file)) continue;
      let text;
      try { text = io.readFileSync(file, 'utf8'); visited.add(file); }
      catch (error) { if (error.code === 'ENOENT') continue; throw dataError('INTERNAL_ERROR', 'Unable to read rejection log'); }
      const lines = text.split('\n'); lines.pop();
      for (const line of lines.reverse()) {
        let event;
        try { event = JSON.parse(line); }
        catch { diagnostic('rejection log: skipped malformed complete line'); continue; }
        const valid = event && event.v === 1 && event.event === 'auth_rejected'
          && (typeof event.conversation_id === 'string' || Number.isSafeInteger(event.conversation_id))
          && ['auth_check_failed', 'auth_check_unconfirmed'].includes(event.reason_code)
          && typeof event.detail === 'string' && ['claude', 'codex'].includes(event.runtime)
          && Number.isSafeInteger(event.ts) && event.ts >= 0;
        if (!valid) { diagnostic('rejection log: skipped invalid event'); continue; }
        if (String(event.conversation_id) === String(id)) {
          return { ...result, reason_code: event.reason_code, detail: event.detail, runtime: event.runtime, ts: event.ts };
        }
      }
    }
  }
  return { ...result, reason: 'expired_or_missing' };
}
