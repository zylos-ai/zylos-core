import { parseSessionGroup } from '../../../comm-bridge/scripts/c4-session-group.js';

// A stand-in for GET /api/memory/entries over a flat list of file rows: one directory level per read, folders before
// files, groups as `group` rows with their name and badge, invalid group folders marked, shallowest-match search,
// offset cursors. Order inside folders and files is by path, which is enough for fixtures that do not test ordering.
export function memoryEntriesPage(files, url, { badges = {}, names = {} } = {}) {
  const params = url.searchParams;
  const groupKey = path => { const parts = path.split('/'); return parts.length === 2 && parts[0] === 'session-groups' && parseSessionGroup(parts[1]) ? parts[1] : null; };
  const row = (path, directory) => {
    if (!directory) return files.find(item => item.path === path);
    const key = groupKey(path), name = path.split('/').at(-1);
    if (key) return { path, name, type: 'group', sessionGroup: key, displayName: names[key] ?? null, backlog: badges[key] ?? null };
    return { path, name, type: 'directory', ...(path.startsWith('session-groups/') && path.split('/').length === 2 ? { diagnostic: 'invalid_session_group' } : {}) };
  };
  const children = dir => {
    const prefix = dir ? `${dir}/` : '', seen = new Map();
    for (const item of files) {
      if (!item.path.startsWith(prefix)) continue;
      const rest = item.path.slice(prefix.length).split('/');
      seen.set(prefix + rest[0], rest.length > 1);
    }
    return [...seen].map(([path, directory]) => row(path, directory));
  };
  const view = params.get('view') ?? 'all', q = params.get('q')?.toLowerCase() ?? '';
  const dir = params.get('dir') ?? (view === 'groups' ? 'session-groups' : '');
  const hidden = item => view === 'shared' && item.path === 'session-groups';
  let rows;
  if (q) {
    rows = [];
    const walk = at => {
      for (const item of children(at).sort((a, b) => a.path < b.path ? -1 : 1)) {
        if (hidden(item)) continue;
        const relative = dir ? item.path.slice(dir.length + 1) : item.path;
        if (relative.toLowerCase().includes(q) || String(item.displayName ?? '').toLowerCase().includes(q)) rows.push(item);
        else if (item.type !== 'file') walk(item.path);
      }
    };
    walk(dir);
  } else rows = children(dir).filter(item => !hidden(item)).sort((a, b) => (a.type === 'file') - (b.type === 'file') || (a.path < b.path ? -1 : 1));
  const limit = Number(params.get('limit') ?? 50);
  const start = params.has('cursor') ? Number(params.get('cursor').slice(2)) : 0;
  return { items: rows.slice(start, start + limit), nextCursor: start + limit < rows.length ? `o:${start + limit}` : null };
}
