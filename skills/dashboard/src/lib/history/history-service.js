// This module awaits the Dashboard runtime factory at module scope.
// The corresponding runtime implementations must not statically import it.

import { sendJson } from '../http.js';
import { isoTimestamp } from '../wire-time.js';
import { getDashboardRuntime } from '../runtime/index.js';
import { UNSUPPORTED } from '../runtime/contract.js';
import { createHistoryScope } from './history-scope.js';
import { createRedactor } from '../redaction/engine.js';
import { loadCoreModule } from '../core-modules.js';

const { DEFAULT_RUNTIME, SUPPORTED_RUNTIMES } = await loadCoreModule('runtime/descriptors.js');
import { BOOLEAN, listErrorBody, listFailure, parseListQuery } from '../list-query.js';

// Transcript readers exist only for these runtimes. Other runtimes have no
// imported history yet and must never inherit another runtime's file reader.
class EmptyHistory {
  paths = new Map();
  async listSessions() { return { current: null, sessions: [] }; }
}
const dashboardRuntimes = await Promise.all(SUPPORTED_RUNTIMES.map(id => getDashboardRuntime(id)));
const parsers = new Map(dashboardRuntimes
  .filter(runtime => runtime.history !== UNSUPPORTED)
  .map(runtime => [runtime.id, runtime.history]));
const parserForRuntime = runtime => parsers.get(runtime) ?? EmptyHistory;

const PREVIEW = 2000;
const CHUNK_BYTES = 256 * 1024;
const SEARCH_BYTES = 20 * 1024 * 1024;
const SAFE_FAILURE = '此内容暂时无法安全显示';
const INLINE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const ROUTES = new Set(['sessions', 'entries', 'content', 'search']);
const LIST_ROUTES = new Set(['sessions', 'entries']);
const nonempty = value => value && value.length <= 200 ? value : undefined;
const sessionId = value => nonempty(value) && /^[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/agent-[a-zA-Z0-9_-]+)?$/.test(value) ? value : undefined;
const entryId = value => /^o:(0|[1-9]\d*)(?::(0|[1-9]\d*))?$/.test(value) &&
  value.slice(2).split(':').every(part => Number.isSafeInteger(Number(part))) ? value : undefined;

function historyListQuery(route, params) {
  const filters = { session_group: nonempty };
  const extras = {};
  const normalized = new URLSearchParams(params);
  if (!normalized.has('session_group')) normalized.set('session_group', 'origin');
  if (route === 'entries') {
    filters.session = sessionId;
    filters.internal = BOOLEAN;
    extras.direction = ['before', 'after'];
    extras.anchor = entryId;
    if (!normalized.has('internal')) normalized.set('internal', 'false');
  }
  const query = parseListQuery(`observer/history/${route}`, normalized, { filters, extras });
  if (route === 'entries' && !query.filters.session) throw listFailure(400, 'invalid_parameter', 'session is required', 'session');
  if (query.after !== null && query.extras.anchor) throw listFailure(400, 'invalid_parameter', 'anchor is only allowed on the first page', 'anchor');
  return query;
}

function compareSessionKeys(left, right) {
  return (right[0] < left[0] ? -1 : right[0] > left[0] ? 1 : 0) ||
    (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0);
}

const sessionKey = item => [isoTimestamp(item.updatedAt) ?? '', item.id];
const entryKey = id => id ? id.slice(2).split(':').map(Number) : [-1];
const compareEntryKeys = ([leftLine, leftBlock = -1], [rightLine, rightBlock = -1]) =>
  leftLine - rightLine || leftBlock - rightBlock;

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
  constructor({ config = {}, store, stateEngine, parser, redactor, resolveScope, readCurrentSessionId, readGroupKey } = {}) {
    this.config = config;
    this.store = store;
    this.resolveScope = resolveScope || (parser ? null : createHistoryScope({ config, store, readCurrentSessionId, readGroupKey }));
    this.scopedParsers = new Map();
    this.runtime = config.runtime || DEFAULT_RUNTIME;
    const Parser = parserForRuntime(this.runtime);
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
      const result = await this.safe(key === 'ts' ? isoTimestamp(entry[key]) : String(entry[key]), `${session}:${generation}:${entry.id}:meta:${key}`);
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

  async sessions(params = new URLSearchParams(), query = historyListQuery('sessions', params),
    listings = null, runtime = this.runtime) {
    listings ??= [await this.parser.listSessions()];
    const current = listings.find(listing => listing.current)?.current ?? null;
    const unique = new Map();
    for (const listing of listings) {
      for (const item of listing.sessions) if (!unique.has(item.id)) unique.set(item.id, { item, key: sessionKey(item) });
    }
    const matches = [...unique.values()].sort((left, right) => compareSessionKeys(left.key, right.key));
    const page = matches.filter(({ key }) => query.after === null || compareSessionKeys(key, query.after) > 0).slice(0, query.limit + 1);
    const more = page.length > query.limit;
    if (more) page.pop();
    const items = [];
    for (const { item, key: [updatedAt] } of page) {
      const out = {};
      for (const key of ['id', 'kind', 'title']) {
        if (item[key] === undefined) continue;
        out[key] = typeof item[key] === 'string' ? (await this.safe(item[key], `session:${item.id}:${key}`)).text : item[key];
        if (key === 'title' && typeof out[key] === 'string') out[key] = out[key].slice(0, 120);
      }
      items.push({ ...out, updatedAt: updatedAt || null });
    }
    return { runtime, current, items, nextCursor: more ? query.nextCursor(page.at(-1).key) : null };
  }

  async session(params) {
    const id = params.get('session');
    if (!id || id.length > 200) throw new HistoryError(400, 'invalid_session');
    const list = await this.parser.listSessions();
    if (!list.sessions.some((item) => item.id === id)) throw new HistoryError(404, 'session_not_found');
    return { id, ...await this.parser.loadSession(id) };
  }

  async entries(params, query = historyListQuery('entries', params)) {
    const session = await this.session(params);
    const all = session.entries;
    const visible = query.filters.internal ? all : all.filter(entry => entry.kind !== 'internal');
    const { anchor, direction = 'before' } = query.extras;
    const boundary = entryKey(query.after);
    const indexOf = predicate => {
      const index = visible.findIndex(entry => predicate(entryKey(entry.id)));
      return index < 0 ? visible.length : index;
    };
    let start, end;
    if (anchor) {
      try { position(all, session.index, anchor); }
      catch { throw listFailure(400, 'invalid_parameter', 'Unknown history anchor', 'anchor'); }
      const at = indexOf(key => compareEntryKeys(key, entryKey(anchor)) >= 0);
      start = Math.max(0, Math.min(at - Math.floor(query.limit / 2), visible.length - query.limit));
      end = Math.min(start + query.limit, visible.length);
    } else if (direction === 'after' && query.after !== null) {
      start = indexOf(key => compareEntryKeys(key, boundary) > 0);
      end = Math.min(start + query.limit, visible.length);
    } else {
      end = query.after === null ? visible.length : indexOf(key => compareEntryKeys(key, boundary) >= 0);
      start = Math.max(0, end - query.limit);
    }
    const selected = visible.slice(start, end);
    const project = entry => this.publicEntry(entry, session.id, session.generation);
    const afterId = end < visible.length ? selected.at(-1)?.id ?? query.after : all.at(-1)?.id ?? '';
    // Tool results may arrive after the call's original page was fetched. Send
    // replacements by stable id as well as the newly appended records.
    const updates = direction === 'after' && query.after !== null ? all.filter(entry =>
      entry.updatedOffset > boundary[0] && compareEntryKeys(entryKey(entry.id), boundary) <= 0) : [];
    return {
      items: await Promise.all(selected.map(project)),
      updates: await Promise.all(updates.map(project)),
      nextCursor: start > 0 ? query.nextCursor(selected[0]?.id ?? query.after) : null,
      afterCursor: query.nextCursor(afterId),
    };
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

  async scopedService(group, scope, route) {
    const key = `${group}:${scope.runtime}`;
    let cached = this.scopedParsers.get(key);
    // A pending discovery is shared before checking its completed version.
    const pending = cached?.pending;
    if (cached) {
      try { await cached.snapshot; }
      catch (error) {
        if (this.scopedParsers.get(key) === cached) this.scopedParsers.delete(key);
        throw error;
      }
    }
    const discovery = cached?.parser.discoveryVersion ? await cached.parser.discoveryVersion() : null;
    // Another request may have published a replacement while this one awaited stat.
    const latest = this.scopedParsers.get(key);
    if (latest !== cached && latest?.revision === scope.revision && latest.currentSessionId === scope.currentSessionId) {
      cached = latest;
    } else if (!cached || cached.revision !== scope.revision || cached.currentSessionId !== scope.currentSessionId || cached.discovery !== discovery
        || (route === 'sessions' && !pending)) {
      const Parser = parserForRuntime(scope.runtime);
      const parser = new Parser({ ...scope, zylosDir: this.config.zylosDir, store: this.store, indexCache: this.parser.indexCache });
      if (cached?.parser) {
        parser.metadataCache = cached.parser.metadataCache;
        if (parser.metadataLoads) parser.metadataLoads = cached.parser.metadataLoads;
      }
      const next = { parser, revision: scope.revision, currentSessionId: scope.currentSessionId, pending: true };
      next.snapshot = parser.listSessions().then(listing => {
        next.discovery = parser.discoverySnapshot ?? null;
        next.pending = false;
        return { parser, listing, paths: parser.paths };
      });
      cached = next;
    }
    this.scopedParsers.delete(key);
    this.scopedParsers.set(key, cached);
    while (this.scopedParsers.size > 8) this.scopedParsers.delete(this.scopedParsers.keys().next().value);
    let snapshot;
    try { snapshot = await cached.snapshot; }
    catch (error) {
      if (this.scopedParsers.get(key) === cached) this.scopedParsers.delete(key);
      throw error;
    }
    const { parser, listing, paths } = snapshot;
    const service = Object.create(this);
    service.runtime = scope.runtime;
    // Discovery and paths belong to one group/runtime/import generation.
    // Each request keeps that snapshot even while another import refreshes it.
    service.parser = Object.assign(Object.create(parser), scope, { paths, loads: new Map(),
      listSessions: async () => ({ ...listing, current: paths.has(scope.currentSessionId) ? scope.currentSessionId : null }) });
    return service;
  }

  async handle(req, res, url) {
    const route = url.pathname.slice('/api/observer/history/'.length);
    try {
      if (!ROUTES.has(route)) throw new HistoryError(404, 'not_found');
      if (req.method !== 'GET') throw new HistoryError(404, 'not_found');
      const query = LIST_ROUTES.has(route) ? historyListQuery(route, url.searchParams) : undefined;
      let service = this;
      if (this.resolveScope) {
        const scope = await this.resolveScope(url.searchParams, route);
        const group = url.searchParams.get('session_group') ?? 'origin';
        const scopes = scope.scopes ?? [scope];
        if (route === 'sessions') {
          const listings = await Promise.all(scopes.map(async candidate =>
            (await this.scopedService(group, candidate, route)).parser.listSessions()));
          sendJson(res, 200, await this.sessions(url.searchParams, query, listings, scope.runtime));
          return true;
        }
        for (const candidate of scopes) {
          service = await this.scopedService(group, candidate, route);
          if (service.parser.paths.has(url.searchParams.get('session'))) break;
        }
      }
      const result = await service[route](url.searchParams, query);
      if (result.binary) {
        const { data, mimeType } = result.binary;
        const mime = INLINE_MEDIA.has(mimeType) ? mimeType : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox', 'Content-Disposition': INLINE_MEDIA.has(mimeType) ? 'inline' : 'attachment; filename="attachment"' });
        res.end(data);
      } else sendJson(res, 200, result);
    } catch (error) {
      if (LIST_ROUTES.has(route)) {
        const failure = ['invalid_parameter', 'invalid_cursor'].includes(error.code) ? error
          : error.code === 'invalid_session_group' ? listFailure(400, 'invalid_parameter', 'Invalid session group', 'session_group')
            : error.status === 404 && error instanceof HistoryError ? listFailure(404, 'not_found', 'History resource not found')
              : listFailure(503, 'unavailable', 'History could not be read');
        sendJson(res, failure.statusCode, listErrorBody(failure));
        return true;
      }
      // Never reflect exception text or record-controlled paths into errors.
      const known = error instanceof HistoryError || ['invalid_session_group', 'group_catalog_unreadable'].includes(error.code);
      sendJson(res, known ? error.status : 503, { error: known ? error.code : 'history_unavailable' });
    }
    return true;
  }

  async close() { await this.redactor.close?.(); }
}
