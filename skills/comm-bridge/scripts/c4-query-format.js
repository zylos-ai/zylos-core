import { dataError, parseSessionGroup } from './c4-session-group.js';
export const ARG_PAYLOAD_MAX = 131071;
export const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export function replyVia(row, scriptPath) {
  const unavailable = reason => `---- reply via: 不可用（${reason}，见 C4 #${row.id}）`;
  if (/[\x00-\x1f\x7f]/.test(scriptPath)) return unavailable('Core 路径含控制字符');
  if (/[\x00-\x1f\x7f]/.test(row.endpoint_id ?? '')) return unavailable('路由含控制字符');
  if (Buffer.byteLength(row.endpoint_id ?? '') > ARG_PAYLOAD_MAX) return unavailable('路由超过参数长度上限');
  const parsed = parseSessionGroup(row.session_group);
  const suffix = row.channel !== 'internal' && parsed?.groupName ? ` --session-group ${parsed.groupName}` : '';
  return `---- reply via: node ${shellQuote(scriptPath)} ${shellQuote(row.channel)} ${shellQuote(row.endpoint_id ?? '')}${suffix}`;
}
// Reversible single-line encoding used by the text query protocol.
export function escapeText(value) {
  return String(value).replace(/\\|\n|\r|\t|[\x00-\x1f\x7f\u0085\u2028\u2029]/g, ch => ({ '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' }[ch] ?? (ch.charCodeAt(0) < 128 ? `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}` : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)));
}
const bytes = text => Buffer.byteLength(text);
const envelope = data => JSON.stringify({ ok: true, data }) + '\n';
function budget(value = 16384) {
  if (!Number.isInteger(value) || value < 2048 || value > 16384) throw dataError('INVALID_ARGS', 'maxBytes must be between 2048 and 16384');
  return value;
}
function bounded(text, max) { if (bytes(text) > max) throw new Error('Query encoding exceeded budget'); return text; }
const time = value => new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(' ', 'T') + 'Z').toISOString().replace('.000Z', 'Z');
const scopeFor = (transition, row) => transition.target_mode === 'single' ? '*' : row.session_group || 'origin';
export function formatAbsorbedPage({ transition, rows }, { group, after = 0, limit, maxBytes, json = false } = {}) {
  const max = budget(maxBytes);
  if (!Number.isSafeInteger(after) || after < 0 || (limit !== undefined && (!Number.isInteger(limit) || limit < 1))) throw dataError('INVALID_ARGS', 'Invalid page boundary');
  const scoped = rows.filter(r => group === undefined || scopeFor(transition, r) === group);
  const pending = scoped.filter(r => r.id > after);
  const items = [], runId = transition.run_id;
  function encode(list) {
    const last = list.at(-1)?.id;
    const next = last !== undefined && pending.some(r => r.id > last) ? last : null;
    const data = { runId, scope: group ?? 'all', total: scoped.length, after, maxBytes: max, items: list, count: list.length, next };
    if (json) return envelope(data);
    return `absorbed run=${runId} scope=${data.scope} total=${data.total} after=${after} maxBytes=${max}\n` + list.map(i => `#${i.id} [${i.k}] group=${i.group} time=${i.time} textBytes=${i.textBytes}\nreply: ${i.reply}\ntext: ${i.textOmitted ? `<省略：原文 ${i.textBytes} B；分段读取 --id ${i.id} --offset 0>` : escapeText(i.text)}\n`).join('') + `count=${list.length} next=${next ?? 'none'}\n`;
  }
  for (const row of pending) {
    if (limit !== undefined && items.length >= limit) break;
    const item = { k: items.length + 1, id: row.id, group: row.session_group, time: time(row.timestamp), textBytes: bytes(row.content), reply: `c4-send.js --absorbed-reply ${runId} ${row.id}`, text: row.content, textOmitted: false };
    if (bytes(encode([...items, item])) > max) {
      if (items.length) break;
      item.text = null; item.textOmitted = true;
    }
    items.push(item);
  }
  return bounded(encode(items), max);
}
export function formatAbsorbedPart({ transition, rows }, { id, field = 'text', offset = 0, maxBytes, json = false } = {}) {
  const max = budget(maxBytes);
  if (!['text', 'endpoint'].includes(field)) throw dataError('INVALID_ARGS', 'Invalid field');
  const row = rows.find(r => r.id === id);
  if (!row) throw dataError('ABSORBED_NOT_IN_RUN', 'Message is not in this transition');
  const value = field === 'text' ? row.content : row.endpoint_id ?? '', buffer = Buffer.from(value), total = buffer.length;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total || (offset < total && (buffer[offset] & 0xc0) === 0x80)) throw dataError('OFFSET_INVALID', 'Offset is not a UTF-8 character boundary');
  function encode(end, payload = buffer.subarray(offset, end).toString('utf8')) {
    const data = { runId: transition.run_id, id, field, bytes: total, offset, nextOffset: end, remaining: total - end, data: payload };
    return json ? envelope(data) : `absorbed-part run=${data.runId} id=${id} field=${field} bytes=${total} offset=${offset} nextOffset=${end} remaining=${data.remaining}\ndata: ${escapeText(data.data)}\nend id=${id} field=${field} nextOffset=${end}\n`;
  }
  let best = offset, encodedBytes = 0, previous = offset;
  for (let end = offset + 1; end <= total; end++) {
    if (end < total && (buffer[end] & 0xc0) === 0x80) continue;
    const character = buffer.subarray(previous, end).toString('utf8');
    encodedBytes += bytes(json ? JSON.stringify(character).slice(1, -1) : escapeText(character));
    previous = end;
    const size = bytes(encode(end, '')) + encodedBytes;
    if (size <= max) best = end;
    // Only decimal metadata can shrink as the endpoint advances.
    else if (size > max + 38) break;
  }
  if (offset < total && best === offset) throw new Error('Part budget did not permit forward progress');
  return bounded(encode(best), max);
}
export function formatAbsorbedSummary({ transition, rows }, { scopeAfter, maxBytes, json = false } = {}) {
  const max = budget(maxBytes), byScope = new Map();
  for (const row of rows) {
    const scope = scopeFor(transition, row);
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push(row);
  }
  const scopes = [...byScope.keys()].sort((a,b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const pending = scopes.filter(s => scopeAfter === undefined || Buffer.compare(Buffer.from(s), Buffer.from(scopeAfter)) > 0), items = [];
  function encode(list) {
    const last = list.at(-1)?.scope, nextScope = last !== undefined && pending.indexOf(last) < pending.length - 1 ? last : null;
    const data = { runId: transition.run_id, phase: transition.phase, total: rows.length, scopes: scopes.length, maxBytes: max, items: list, count: list.length, nextScope };
    if (json) return envelope(data);
    return `absorbed-summary run=${data.runId} phase=${data.phase} total=${data.total} scopes=${data.scopes} maxBytes=${max}\n` + list.map(i => `scope=${i.scope} count=${i.count} firstId=${i.firstId} lastId=${i.lastId}${i.bySourceGroup === undefined ? '' : ` bySourceGroup=${i.bySourceGroup === null ? '<省略>' : Object.entries(i.bySourceGroup).map(([g,n]) => `${g}:${n}`).join(',')}`}\n`).join('') + `count=${list.length} nextScope=${nextScope ?? 'none'}\n`;
  }
  for (const scope of pending) {
    const messages = byScope.get(scope), item = { scope, count: messages.length, firstId: messages[0].id, lastId: messages.at(-1).id };
    if (transition.target_mode === 'single') {
      item.bySourceGroup = Object.create(null);
      for (const row of messages) item.bySourceGroup[row.session_group] = (item.bySourceGroup[row.session_group] ?? 0) + 1;
      if (bytes(encode([...items, item])) > max) item.bySourceGroup = null;
    }
    if (bytes(encode([...items, item])) > max) break;
    items.push(item);
  }
  return bounded(encode(items), max);
}
export function formatQueryError(error, { maxBytes = 16384, json = false } = {}) {
  const max = Number.isInteger(maxBytes) && maxBytes >= 2048 && maxBytes <= 16384 ? maxBytes : 16384;
  const detail = { code: error.code ?? 'READ_FAILED', message: error.message, persisted: Object.hasOwn(error, 'persisted') ? error.persisted : [], ...(error.rollbackError ? { rollbackError: error.rollbackError.message } : {}), ...(error.ids ? { ids: [], count: error.count ?? error.ids.length } : {}) };
  const encode = () => json ? JSON.stringify({ ok: false, error: detail }) + '\n' : `Error [${detail.code}]: ${escapeText(detail.message)}${detail.ids ? ` ids=${detail.ids.join(',')} count=${detail.count}` : ''}\n`;
  if (bytes(encode()) > max) detail.message = 'Query failed';
  for (const id of error.ids ?? []) { detail.ids.push(id); if (bytes(encode()) > max) { detail.ids.pop(); break; } }
  return bounded(encode(), max);
}
