import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCoreConfigModule } from './core-config-loader.js';
import { dataError } from './c4-session-group.js';
import { DATA_DIR } from './c4-config.js';
import { normalizeStatusEndpoint } from './status-endpoint.js';
import { safeEntryId } from './c4-entry-id.js';

export const entryEventsPath = () => path.join(DATA_DIR, 'receive-events.jsonl');
export const sanitizeEntryDetail = detail => Array.from(String(detail ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '')).slice(0, 500).join('');

export async function appendEntryEvent(event, options = {}) {
  const filename = options.filename ?? entryEventsPath();
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
  if (!/^[1-9][0-9]*$/.test(textId)) throw dataError('INVALID_ARGS', 'id must be a positive integer');
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
          && typeof event.detail === 'string' && typeof event.runtime === 'string'
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
