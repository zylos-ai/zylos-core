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
function pageLimit(value, fallback, maximum) {
  const limit = value === undefined ? fallback : value;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) throw dataError('INVALID_ARGS', `limit must be between 1 and ${maximum}`);
  return limit;
}
const time = value => new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(' ', 'T') + 'Z').toISOString().replace('.000Z', 'Z');
const scopeFor = (transition, row) => transition.target_mode === 'single' ? '*' : row.session_group || 'origin';
export function formatAbsorbedPage({ transition, rows }, { group, after = 0, limit: requested, json = false } = {}) {
  const limit = pageLimit(requested, 20, 100);
  if (!Number.isSafeInteger(after) || after < 0) throw dataError('INVALID_ARGS', 'Invalid page boundary');
  const scoped = rows.filter(r => group === undefined || scopeFor(transition, r) === group);
  const pending = scoped.filter(r => r.id > after);
  const runId = transition.run_id;
  const items = pending.slice(0, limit).map((row, index) => {
    const characters = Array.from(row.content);
    return { k: index + 1, id: row.id, group: row.session_group, time: time(row.timestamp), textBytes: bytes(row.content),
      reply: `c4-send.js --absorbed-reply ${runId} ${row.id}`, text: characters.slice(0, 300).join(''), textTruncated: characters.length > 300 };
  });
  const next = items.length && pending.length > items.length ? items.at(-1).id : null;
  const data = { runId, scope: group ?? 'all', total: scoped.length, after, limit, items, count: items.length, next };
  if (json) return envelope(data);
  return `absorbed run=${runId} scope=${data.scope} total=${data.total} after=${after} limit=${limit}\n` + items.map(i =>
    `#${i.id} [${i.k}] group=${i.group} time=${i.time} textBytes=${i.textBytes}\nreply: ${i.reply}\ntext: ${escapeText(i.text)}${i.textTruncated ? ` …<截断：原文 ${i.textBytes} B；全文 --id ${i.id}>` : ''}\n`
  ).join('') + `count=${items.length} next=${next ?? 'none'}\n`;
}
export function absorbedField({ transition, rows }, { id, field = 'text' } = {}) {
  if (!['text', 'endpoint'].includes(field)) throw dataError('INVALID_ARGS', 'Invalid field');
  const row = rows.find(r => r.id === id);
  if (!row) throw dataError('ABSORBED_NOT_IN_RUN', 'Message is not in this transition');
  const value = field === 'text' ? row.content : row.endpoint_id ?? '';
  return { runId: transition.run_id, id, field, bytes: bytes(value), data: value };
}
export function formatAbsorbedFull(snapshot, options = {}) {
  const { json = false, out } = options;
  const data = absorbedField(snapshot, options);
  if (out !== undefined) {
    const { data: value, ...metadata } = data;
    return json ? envelope({ ...metadata, path: out }) : `absorbed-file run=${data.runId} id=${data.id} field=${data.field} bytes=${data.bytes} path=${escapeText(out)}\n`;
  }
  return json ? envelope(data) : `absorbed-full run=${data.runId} id=${data.id} field=${data.field} bytes=${data.bytes}\ndata: ${escapeText(data.data)}\nend id=${data.id} field=${data.field}\n`;
}
export function formatAbsorbedSummary({ transition, rows }, { scopeAfter, limit: requested, json = false } = {}) {
  const limit = pageLimit(requested, 50, 200), byScope = new Map();
  for (const row of rows) {
    const scope = scopeFor(transition, row);
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push(row);
  }
  const binary = (a,b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const scopes = [...byScope.keys()].sort(binary);
  const pending = scopes.filter(s => scopeAfter === undefined || binary(s, scopeAfter) > 0);
  const items = pending.slice(0, limit).map(scope => {
    const messages = byScope.get(scope), item = { scope, count: messages.length, firstId: messages[0].id, lastId: messages.at(-1).id };
    if (transition.target_mode === 'single') {
      const counts = new Map();
      for (const row of messages) counts.set(row.session_group, (counts.get(row.session_group) ?? 0) + 1);
      const groups = [...counts.keys()].sort(binary);
      item.bySourceGroup = Object.fromEntries(groups.slice(0, 50).map(g => [g, counts.get(g)]));
      if (groups.length > 50) item.bySourceGroupMore = groups.length - 50;
    }
    return item;
  });
  const nextScope = items.length && pending.length > items.length ? items.at(-1).scope : null;
  const data = { runId: transition.run_id, phase: transition.phase, total: rows.length, scopes: scopes.length, items, count: items.length, nextScope };
  if (json) return envelope(data);
  return `absorbed-summary run=${data.runId} phase=${data.phase} total=${data.total} scopes=${data.scopes}\n` + items.map(i =>
    `scope=${i.scope} count=${i.count} firstId=${i.firstId} lastId=${i.lastId}${i.bySourceGroup === undefined ? '' : ` bySourceGroup=${Object.entries(i.bySourceGroup).map(([g,n]) => `${g}:${n}`).join(',')}${i.bySourceGroupMore ? `,+${i.bySourceGroupMore} more` : ''}`}\n`
  ).join('') + `count=${items.length} nextScope=${nextScope ?? 'none'}\n`;
}
export function formatQueryError(error, { json = false } = {}) {
  const detail = { code: error.code ?? 'READ_FAILED', message: error.message, persisted: error.persisted ?? [],
    ...(error.ids ? { ids: error.ids.slice(0, 20), count: error.count ?? error.ids.length } : {}) };
  return json ? JSON.stringify({ ok: false, error: detail }) + '\n' : `Error [${detail.code}]: ${escapeText(detail.message)}${detail.ids ? ` ids=${detail.ids.join(',')} count=${detail.count}` : ''}\n`;
}
