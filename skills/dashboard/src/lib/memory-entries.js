import fs from 'node:fs/promises';
import path from 'node:path';
import { parseSessionGroup } from '../../../comm-bridge/scripts/c4-session-group.js';
import { listFailure, parseListQuery } from './list-query.js';
import { isMemoryWriteTemp, isTextFileName, validateMemoryQueryPath } from './memory-browser.js';

const GROUPS = 'session-groups';
const VIEWS = ['all', 'shared', 'groups'];
const inGroups = rel => rel === GROUPS || rel.startsWith(`${GROUPS}/`);

// A directory path under the memory root: the browser's path rules, and never into Git's own directory.
function directoryParam(value) {
  let rel;
  try { rel = validateMemoryQueryPath(value, { allowEmpty: true }); } catch { return undefined; }
  return rel.split('/').includes('.git') ? undefined : rel;
}

/**
 * The entries list's query: `dir` (a directory, the memory root by default) and `view` (`all`, `shared` without
 * `session-groups/`, `groups` only `session-groups/`) are filters bound to the cursor, with `q`, `limit` and `cursor`.
 */
export function parseEntriesQuery(searchParams) {
  const query = parseListQuery('memory-entries', searchParams, { filters: { dir: directoryParam, view: VIEWS }, q: true });
  const view = query.filters.view ?? 'all';
  const dir = query.filters.dir ?? (view === 'groups' ? GROUPS : '');
  if (view === 'shared' && inGroups(dir)) throw listFailure(400, 'invalid_parameter', 'The shared view has no session-groups directory', 'view');
  if (view === 'groups' && !inGroups(dir)) throw listFailure(400, 'invalid_parameter', 'The groups view has only the session-groups directory', 'view');
  const position = query.after;
  if (position !== null && !(Array.isArray(position) && (query.q
    ? position.length === 1 && typeof position[0] === 'string'
    : position.length === 3 && [0, 1, 2, 3].includes(position[0]) && Number.isFinite(position[1]) && typeof position[2] === 'string'))) {
    throw listFailure(400, 'invalid_cursor', 'The cursor is no longer valid; reload the first page');
  }
  return { ...query, dir, view };
}

const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function compareKeys(a, b) {
  return a[0] - b[0] || a[1] - b[1] || compareText(a[2], b[2]);
}
// Search order: depth first with names in code-unit order, a directory before what it holds.
function compareDepthFirst(a, b) {
  const x = a.split('/'), y = b.split('/');
  for (let index = 0; index < Math.min(x.length, y.length); index++) {
    const order = compareText(x[index], y[index]);
    if (order) return order;
  }
  return x.length - y.length;
}
function timestampMillis(value) {
  if (typeof value !== 'string' || !value) return NaN;
  // C4 timestamps are UTC even when their SQLite text omits the offset.
  return Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value);
}

/**
 * One page of one memory directory's entries under the list API standard, or with `q` one page of the matches in
 * its subtree (the path below `dir` or a group's display name matches). `browser` resolves paths under its rules; `displayName(key)`, `sortMessage(key)` (the group's latest
 * received message, list API standard 6.2/6.3) and `badges(keys)` describe session groups; badges are read only
 * for the groups on the page. `readdir` and `lstat` are the file system reads.
 */
export async function readEntriesPage(query, { browser, displayName = () => null, sortMessage = () => null,
  badges = async keys => keys.map(() => null), readdir = fs.readdir, lstat = fs.lstat } = {}) {
  let resolved;
  try { resolved = await browser.resolvePath(query.dir, { allowRoot: true }); }
  catch (error) {
    if (error.code === 'memory_file_not_found') throw listFailure(404, 'not_found', 'The directory does not exist');
    if (error.code === 'invalid_memory_path') throw listFailure(400, 'invalid_parameter', 'Invalid dir', 'dir');
    throw listFailure(503, 'unavailable', 'The memory directory cannot be read');
  }
  if (!resolved.stat.isDirectory()) throw listFailure(400, 'invalid_parameter', 'dir is not a directory', 'dir');
  const root = await browser.realRoot();
  const groupKey = rel => {
    const parts = rel.split('/');
    return parts.length === 2 && parts[0] === GROUPS && parseSessionGroup(parts[1]) !== null ? parts[1] : null;
  };
  // A directory's listed children: no Git directory, no links, no in-flight write files.
  async function children(rel) {
    let entries;
    try { entries = await readdir(rel ? path.join(root, rel) : root, { withFileTypes: true }); }
    catch { if (rel === query.dir) throw listFailure(503, 'unavailable', 'The memory directory cannot be read'); return []; }
    return entries.filter(entry => entry.name !== '.git' && !entry.isSymbolicLink()
      && (entry.isDirectory() || entry.isFile() && !isMemoryWriteTemp(entry.name))
      && !(query.view === 'shared' && !rel && entry.name === GROUPS))
      .map(entry => ({ rel: rel ? `${rel}/${entry.name}` : entry.name, name: entry.name, directory: entry.isDirectory() }));
  }
  async function fileRow(entry, stat) {
    stat ??= await lstat(path.join(root, entry.rel));
    if (!stat.isFile()) return null;
    return { path: entry.rel, name: entry.name, type: 'file', size_bytes: stat.size, mtime: stat.mtime.toISOString(),
      renderable: isTextFileName(entry.name) && stat.size <= browser.maxFileBytes };
  }
  function directoryRow(entry) {
    const key = groupKey(entry.rel);
    if (key !== null) return { path: entry.rel, name: entry.name, type: 'group', sessionGroup: key, displayName: displayName(key) ?? null };
    return { path: entry.rel, name: entry.name, type: 'directory', ...(entry.rel.startsWith(`${GROUPS}/`) && entry.rel.split('/').length === 2
      ? { diagnostic: 'invalid_session_group' } : {}) };
  }
  async function withBadges(rows) {
    const groups = rows.filter(row => row.type === 'group');
    let read;
    try { read = await badges(groups.map(row => row.sessionGroup)); } catch { read = groups.map(() => null); }
    groups.forEach((row, index) => { row.backlog = read[index] ?? null; });
    return rows;
  }

  if (query.q) {
    const needle = query.q.toLowerCase(), after = query.after?.[0] ?? null, found = [];
    // Shallowest matches only: a matching directory stands for everything under it, so its subtree is not read.
    async function walk(rel) {
      const entries = (await children(rel)).sort((a, b) => compareText(a.name, b.name));
      for (const entry of entries) {
        if (found.length > query.limit) return;
        const before = after !== null && compareDepthFirst(entry.rel, after) <= 0;
        const holdsCursor = after !== null && after.startsWith(`${entry.rel}/`);
        if (before && !holdsCursor) continue;
        const key = entry.directory ? groupKey(entry.rel) : null;
        const matches = !before && ((query.dir ? entry.rel.slice(query.dir.length + 1) : entry.rel).toLowerCase().includes(needle)
          || key !== null && String(displayName(key) ?? '').toLowerCase().includes(needle));
        if (matches) {
          const row = entry.directory ? directoryRow(entry) : await fileRow(entry);
          if (row) found.push(row);
        } else if (entry.directory) await walk(entry.rel);
      }
    }
    await walk(query.dir);
    const page = found.slice(0, query.limit);
    return { items: await withBadges(page), nextCursor: found.length > query.limit ? query.nextCursor([page.at(-1).path]) : null };
  }

  // One level: directories first (session groups by their latest received message, newest first, then groups
  // without one, then other directories by name), then files by modification time, newest first; the path breaks ties.
  // Only the session-groups level reads C4; a search, the root and other directories do not.
  const entries = await children(query.dir);
  const keyed = [];
  for (const entry of entries) {
    if (entry.directory) {
      const key = groupKey(entry.rel);
      let at = NaN;
      if (key !== null) {
        // Without C4 the groups have no standard order, so the listing fails rather than falling back to another one.
        let message;
        try { message = sortMessage(key); } catch { throw listFailure(503, 'unavailable', 'The group message order cannot be read'); }
        at = timestampMillis(message?.timestamp);
      }
      keyed.push({ entry, key: key === null ? [2, 0, entry.rel] : Number.isFinite(at) ? [0, -at, entry.rel] : [1, 0, entry.rel] });
    } else {
      let stat;
      try { stat = await lstat(path.join(root, entry.rel)); } catch { continue; }
      if (stat.isFile()) keyed.push({ entry, stat, key: [3, -stat.mtimeMs, entry.rel] });
    }
  }
  keyed.sort((a, b) => compareKeys(a.key, b.key));
  const rest = query.after === null ? keyed : keyed.filter(row => compareKeys(row.key, query.after) > 0);
  const page = rest.slice(0, query.limit);
  const rows = [];
  for (const { entry, stat } of page) rows.push(entry.directory ? directoryRow(entry) : await fileRow(entry, stat));
  return { items: await withBadges(rows), nextCursor: rest.length > query.limit ? query.nextCursor(page.at(-1).key) : null };
}
