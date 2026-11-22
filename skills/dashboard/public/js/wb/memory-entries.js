// The memory page's loaded directory pages from GET /api/memory/entries. Nothing here reads the whole memory
// directory: each list is one directory level (or one search) read page by page, and every question the page asks
// about memory (which groups exist, whether a file's group is valid, the root files' sizes) is answered from what
// has been loaded.

export const ENTRY_PAGE = 50;
export const GROUPS_DIR = 'session-groups';

/** The entries request for one list: `dir`, `view` and `q` select it; `limit` and `cursor` page it. */
export function memoryEntriesPath({ dir = '', view = 'all', q = '', limit = ENTRY_PAGE, cursor = null } = {}) {
  const params = new URLSearchParams();
  if (dir) params.set('dir', dir);
  if (view !== 'all') params.set('view', view);
  if (q) params.set('q', q);
  if (limit !== ENTRY_PAGE) params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  const text = params.toString();
  return `/api/memory/entries${text ? `?${text}` : ''}`;
}

/** Rows of a later page join the loaded rows once each, by path: a file changed between pages can come back. */
function merge(rows, more) {
  const seen = new Set(rows.map(row => row.path));
  return [...rows, ...more.filter(row => !seen.has(row.path))];
}

/**
 * The loaded lists. `get(spec)` returns a list or null; `start(spec)` returns it, beginning its first read when it
 * has none, so a drawing page can ask for what it shows. A list is `{items, nextCursor, loading, error}`.
 * `onChange` runs after each read settles. A cursor the server refuses (after a Dashboard restart) reads the
 * first page again, silently.
 */
export function createMemoryEntries({ request, onChange = () => {} }) {
  let lists = new Map(), generation = 0;
  const keyOf = ({ dir = '', view = 'all', q = '', limit = ENTRY_PAGE } = {}) => JSON.stringify([dir, view, q, limit]);
  async function read(spec, more) {
    const key = keyOf(spec), operation = generation, before = lists.get(key);
    lists.set(key, { items: before?.items ?? [], nextCursor: before?.nextCursor ?? null, loading: true, error: null });
    let next;
    try {
      const value = await request(memoryEntriesPath({ ...spec, cursor: more ? before.nextCursor : null }));
      if (operation !== generation) return;
      const items = Array.isArray(value?.items) ? value.items : [];
      next = { items: more ? merge(before.items, items) : items, nextCursor: value?.nextCursor ?? null, loading: false, error: null };
    } catch (error) {
      if (operation !== generation) return;
      if (more && error?.code === 'invalid_cursor') { lists.delete(key); return read(spec, false); }
      next = { items: before?.items ?? [], nextCursor: before?.nextCursor ?? null, loading: false, error: error?.code || 'memory_browser_failed' };
    }
    lists.set(key, next);
    onChange();
  }
  const api = {
    get: spec => lists.get(keyOf(spec)) ?? null,
    start(spec) {
      const list = lists.get(keyOf(spec));
      if (list) return list;
      read(spec, false);
      return lists.get(keyOf(spec));
    },
    /** Reads a list's first page (again); resolves once it has settled. */
    load: spec => read(spec, false),
    /** Reads a list's next page, once at a time. */
    more(spec) {
      const list = lists.get(keyOf(spec));
      return list?.nextCursor && !list.loading ? read(spec, true) : Promise.resolve();
    },
    /** Adds a row the page knows of (a deep-linked file or its folder) to a loaded list, unless it is there. */
    insert(spec, row) {
      const key = keyOf(spec), list = lists.get(key);
      if (!list || list.items.some(item => item.path === row.path)) return;
      lists.set(key, { ...list, items: [...list.items, row] });
    },
    /** A saved file's new size and time, in every loaded list that shows it. */
    updateFile(path, fields) {
      for (const [key, list] of lists) {
        if (list.items.some(row => row.path === path)) {
          lists.set(key, { ...list, items: list.items.map(row => row.path === path ? { ...row, ...fields } : row) });
        }
      }
    },
    /** Forgets every list; reads in flight are dropped. */
    reset() { generation++; lists = new Map(); },
    /**
     * What the loaded lists say about memory: each loaded session group by key, the group directories with an
     * invalid name, and the root directory's files (from its listing).
     */
    known() {
      const groups = new Map(), invalid = new Set(), rootFiles = [];
      for (const [key, list] of lists) {
        const [dir, , q] = JSON.parse(key);
        for (const row of list.items) {
          if (row.type === 'group') groups.set(row.sessionGroup, row);
          else if (row.diagnostic === 'invalid_session_group') invalid.add(row.name);
          else if (row.type === 'file' && !dir && !q && !row.path.includes('/')) rootFiles.push(row);
        }
      }
      return { groups, invalid, rootFiles };
    },
  };
  return api;
}
