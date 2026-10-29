import { sendJson } from '../http.js';
import { ClaudeHistory } from './claude-history.js';
import { CodexHistory } from './codex-history.js';
import { createRedactor } from '../redaction/engine.js';

const PREVIEW = 2000;
const CHUNK_BYTES = 256 * 1024;
const SEARCH_BYTES = 20 * 1024 * 1024;
const SAFE_FAILURE = '此内容暂时无法安全显示';
const INLINE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const ROUTES = new Set(['sessions', 'entries', 'content', 'search']);

class HistoryError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function integer(params, name, fallback, max) {
  const raw = params.get(name);
  if (raw === null) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new HistoryError(400, 'invalid_' + name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) throw new HistoryError(400, 'invalid_' + name);
  return value;
}

// Offsets count UTF-16 units, like JS string.length. Cuts never split a Unicode
// scalar and each response is at most CHUNK_BYTES in UTF-8.
export function textChunk(text, offset, maxBytes = CHUNK_BYTES) {
  if (offset > text.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] || '') && /[\uD800-\uDBFF]/.test(text[offset - 1]))) {
    throw new HistoryError(400, 'invalid_offset');
  }
  let end = Math.min(text.length, offset + maxBytes);
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  if (Buffer.byteLength(text.slice(offset, end)) > maxBytes) {
    let low = offset, high = end;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(text.slice(offset, mid)) <= maxBytes) low = mid;
      else high = mid - 1;
    }
    end = low;
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  }
  return { text: text.slice(offset, end), offset, next: end < text.length ? end : null, total: text.length };
}

function position(entries, index, cursor) {
  if (!/^o:(0|[1-9]\d*)(?::(0|[1-9]\d*))?$/.test(cursor || '')) throw new HistoryError(400, 'invalid_cursor');
  const offset = Number(cursor.split(':')[1]);
  if (!Number.isSafeInteger(offset) || !index.lines.some((line) => line.offset === offset)) throw new HistoryError(400, 'invalid_cursor');
  const found = entries.findIndex((entry) => entry.id === cursor);
  if (found >= 0) return found;
  // A line cursor may identify an internal/empty record with no visible blocks.
  if (cursor.split(':').length > 2) throw new HistoryError(400, 'invalid_cursor');
  return entries.findIndex((entry) => Number(entry.id.split(':')[1]) >= offset);
}

export class HistoryService {
  constructor({ config = {}, store, stateEngine, parser, redactor } = {}) {
    this.runtime = config.runtime || 'claude';
    const Parser = this.runtime === 'codex' ? CodexHistory : ClaudeHistory;
    this.parser = parser || new Parser({ zylosDir: config.zylosDir, store, stateEngine });
    this.redactor = redactor || createRedactor({ zylosDir: config.zylosDir, allowlist: config.history?.redactionAllowlist || [] });
  }

  async safe(value, key) {
    try {
      if (typeof value === 'string') return await this.redactor.redact(value, key);
      const result = await this.redactor.redactValue(value, key);
      return { ...result, text: JSON.stringify(result.value, null, 2) };
    } catch {
      return { text: SAFE_FAILURE, count: 0, kinds: [], failed: true };
    }
  }

  async publicEntry(entry, session, generation) {
    const out = { id: entry.id, kind: entry.kind, fields: {}, redaction: { count: 0, kinds: [] } };
    const kinds = new Set();
    const add = (result) => {
      out.redaction.count += result.count || 0;
      for (const kind of result.kinds || []) kinds.add(kind);
    };
    // Explicit projection prevents parser-private paths and original values from
    // accidentally becoming part of the HTTP response.
    for (const key of ['ts', 'channel', 'sender', 'target', 'name', 'tool', 'summary', 'status', 'label', 'system']) {
      if (entry[key] === undefined) continue;
      if (typeof entry[key] === 'boolean') { out[key] = entry[key]; continue; }
      const result = await this.safe(String(entry[key]), `${session}:${generation}:${entry.id}:meta:${key}`);
      out[key] = result.text; add(result);
    }
    for (const [key, value] of Object.entries(entry.fields || {})) {
      // Field identifiers are parser-defined, never values taken from a record.
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) continue;
      const result = await this.safe(value, `${session}:${generation}:${entry.id}:${key}`);
      const text = result.text;
      let previewEnd = Math.min(PREVIEW, text.length);
      if (/[\uDC00-\uDFFF]/.test(text[previewEnd] || '')) previewEnd--;
      out.fields[key] = { preview: text.slice(0, previewEnd), total: text.length, truncated: previewEnd < text.length || Boolean(entry.deferred) };
      add(result);
    }
    for (const [key, binary] of Object.entries(entry.binaries || {})) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) continue;
      const name = await this.safe(String(binary.name || 'attachment'), `${session}:${entry.id}:${key}:name`);
      const mime = await this.safe(String(binary.mimeType || 'application/octet-stream'), `${session}:${entry.id}:${key}:mime`);
      out.fields[key] = { type: 'binary', mimeType: mime.text, name: name.text, bytes: binary.data?.length || binary.bytes || 0, total: binary.data?.length || binary.bytes || 0, truncated: false };
      add(name); add(mime);
    }
    out.redaction.kinds = [...kinds];
    return out;
  }

  async sessions() {
    const listing = await this.parser.listSessions();
    const sessions = [];
    for (const item of listing.sessions) {
      const out = {};
      for (const key of ['id', 'parentId', 'kind', 'title', 'startedAt', 'updatedAt', 'bytes']) {
        if (item[key] === undefined) continue;
        out[key] = typeof item[key] === 'string' ? (await this.safe(item[key], `session:${item.id}:${key}`)).text : item[key];
        if (key === 'title' && typeof out[key] === 'string') out[key] = out[key].slice(0, 120);
      }
      sessions.push(out);
    }
    return { runtime: this.runtime, current: listing.current || null, sessions };
  }

  async session(params) {
    const id = params.get('session');
    if (!id || id.length > 200) throw new HistoryError(400, 'invalid_session');
    const list = await this.parser.listSessions();
    if (!list.sessions.some((item) => item.id === id)) throw new HistoryError(404, 'session_not_found');
    return { id, ...await this.parser.loadSession(id) };
  }

  async entries(params) {
    const limit = integer(params, 'limit', 50, 200);
    if (!limit) throw new HistoryError(400, 'invalid_limit');
    const modes = ['before', 'after', 'around'].filter((key) => params.has(key));
    if (modes.length > 1 || (params.has('internal') && !['0', '1'].includes(params.get('internal')))) throw new HistoryError(400, 'invalid_parameters');
    const session = await this.session(params);
    const all = session.entries;
    const visible = (entry) => params.get('internal') === '1' || entry.kind !== 'internal';
    const mode = modes[0];
    let anchor = mode ? position(all, session.index, params.get(mode)) : all.length;
    if (anchor < 0) anchor = all.length;
    let selected;
    if (mode === 'after') selected = all.slice(anchor + 1).filter(visible).slice(0, limit);
    else if (mode === 'around') {
      const older = all.slice(0, anchor).filter(visible).slice(-Math.floor(limit / 2));
      selected = [...older, ...all.slice(anchor).filter(visible).slice(0, limit - older.length)];
    } else selected = all.slice(0, anchor).filter(visible).slice(-limit);
    const entries = await Promise.all(selected.map((entry) => this.publicEntry(entry, session.id, session.generation)));
    const first = selected.length ? all.indexOf(selected[0]) : anchor;
    const last = selected.length ? all.indexOf(selected.at(-1)) : anchor;
    const hasNewer = all.slice(last + 1).some(visible);
    const after = hasNewer ? selected.at(-1)?.id || params.get('after') : all.at(-1)?.id || null;
    // Tool results may arrive after the call's original page was fetched. Send
    // replacements by stable id as well as the newly appended records.
    const updates = mode === 'after' ? await Promise.all(all.slice(0, anchor + 1).filter((entry) => ['tool', 'outbound'].includes(entry.kind) && entry.updatedOffset > Number(params.get('after').split(':')[1])).map((entry) => this.publicEntry(entry, session.id, session.generation))) : [];
    return { entries, updates, before: selected[0]?.id || null, after, hasOlder: all.slice(0, first).some(visible), hasNewer };
  }

  async content(params) {
    const session = await this.session(params);
    const entryId = params.get('entry');
    const at = position(session.entries, session.index, entryId);
    let entry = session.entries[at];
    if (!entry || entry.id !== entryId) throw new HistoryError(404, 'entry_not_found');
    const deferred = Boolean(entry.deferred);
    if (deferred) entry = await this.parser.expandEntry(session.id, entryId);
    const field = params.get('field');
    const offset = integer(params, 'offset', 0, Number.MAX_SAFE_INTEGER);
    const binary = Object.hasOwn(entry.binaries || {}, field) ? entry.binaries[field] : null;
    if (binary) return { binary };
    if (!Object.hasOwn(entry.fields || {}, field)) throw new HistoryError(404, 'field_not_found');
    const result = await this.safe(entry.fields[field], `${session.id}:${session.generation}:${entry.id}:${field}`);
    const chunk = textChunk(result.text, offset);
    if (deferred) chunk.expandedEntry = await this.publicEntry(entry, session.id, session.generation);
    return chunk;
  }

  async search(params) {
    const query = params.get('q') || '';
    if (query.length < 2 || query.length > 200) throw new HistoryError(400, 'invalid_query');
    const limit = integer(params, 'limit', 20, 200);
    if (!limit) throw new HistoryError(400, 'invalid_limit');
    const session = await this.session(params);
    let at = params.has('before') ? position(session.entries, session.index, params.get('before')) - 1 : session.entries.length - 1;
    const needle = query.toLowerCase();
    const matches = [];
    let scanned = 0, cursor = null;
    for (; at >= 0 && matches.length < limit && scanned < SEARCH_BYTES; at--) {
      const entry = session.entries[at]; cursor = entry.id;
      if (entry.kind === 'internal' && params.get('internal') !== '1') continue;
      for (const [field, value] of Object.entries(entry.fields || {})) {
        const result = await this.safe(value, `${session.id}:${session.generation}:${entry.id}:${field}`);
        scanned += Buffer.byteLength(result.text);
        const found = result.text.toLowerCase().indexOf(needle);
        if (found >= 0) {
          matches.push({ entry: entry.id, snippet: result.text.slice(Math.max(0, found - 100), found + query.length + 200) });
          break;
        }
      }
    }
    return { matches, before: cursor, hasMore: at >= 0 };
  }

  async handle(req, res, url) {
    const route = url.pathname.slice('/api/observer/history/'.length);
    try {
      if (!ROUTES.has(route)) throw new HistoryError(404, 'not_found');
      if (req.method !== 'GET') throw new HistoryError(405, 'method_not_allowed');
      const result = route === 'sessions' ? await this.sessions() : await this[route](url.searchParams);
      if (result.binary) {
        const { data, mimeType } = result.binary;
        const mime = INLINE_MEDIA.has(mimeType) ? mimeType : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox', 'Content-Disposition': INLINE_MEDIA.has(mimeType) ? 'inline' : 'attachment; filename="attachment"' });
        res.end(data);
      } else sendJson(res, 200, result);
    } catch (error) {
      // Never reflect exception text or record-controlled paths into errors.
      sendJson(res, error instanceof HistoryError ? error.status : 503, { error: error instanceof HistoryError ? error.code : 'history_unavailable' });
    }
    return true;
  }

  async close() { await this.redactor.close?.(); }
}
