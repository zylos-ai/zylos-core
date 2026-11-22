/**
 * Answers GET /api/keys for browser cases the way the Dashboard does: `limit` keys a page, `q` matching the key
 * name, an opaque `cursor`, `total` with `include=total`, and the active and revoked counts of every key. The keys
 * are listed in the order given, which the cases write in the server's order (active first, newest first).
 */
export function keyPage(keys, url) {
  const params = url.searchParams, limit = Number(params.get('limit') ?? 50), q = (params.get('q') ?? '').toLowerCase();
  const matched = keys.filter(key => key.name.toLowerCase().includes(q));
  const start = params.has('cursor') ? Number(params.get('cursor')) : 0;
  const items = matched.slice(start, start + limit);
  const revoked = keys.filter(key => key.status === 'revoked').length;
  return {
    items,
    nextCursor: start + limit < matched.length ? String(start + limit) : null,
    ...(params.get('include') === 'total' ? { total: matched.length } : {}),
    counts: { active: keys.length - revoked, revoked },
  };
}
