/** Assemble page-owned view data from the separate instance and group resources. */
export function groupSnapshot(instance, counts, page) {
  const rows = page?.rows ?? [];
  const overrides = rows.some(row => row.runtimeOverridden === null || row.modelOverridden === null) ? null : { runtime: rows.filter(row => row.runtimeOverridden === true),
    model: rows.filter(row => row.modelOverridden === true) };
  return { mode: counts.mode, view: counts.mode === 'single' ? 'single' : counts.mode === 'multi' ? 'multi' : 'unreadable',
    baselineRuntime: instance.default_runtime ?? instance.runtime_info?.runtime,
    readAt: counts.readAt, listKnown: counts.listKnown !== false && page.listKnown !== false, rows, counts: { ...counts.running?.states, offline: counts.offline?.total ?? 0 },
    groupCounts: counts, nextCursor: page.nextCursor ?? null, hasOlder: page.nextCursor != null, overrides,
    instance: { ...instance, pool: counts.pool },
    sources: { status: { ok: counts.listKnown !== false && page.listKnown !== false, readAt: page.readAt ?? counts.readAt } },
    attention: { problems: rows.flatMap(row => row.attention ?? []).filter(item => item.severity !== 'reminder'),
      reminders: rows.flatMap(row => row.attention ?? []).filter(item => item.severity === 'reminder') } };
}

export async function readGroupSnapshot(read, { signal, side = 'running', cursor = null, pages = 1 } = {}) {
  const params = new URLSearchParams();
  if (cursor != null) params.set('cursor', cursor);
  const path = side === 'offline' ? '/api/groups/offline' + (params.size ? '?' + params : '') : '/api/groups/running';
  const [instance, counts, page] = await Promise.all([
    read('/api/instance', { signal }), read('/api/groups/counts', { signal }), read(path, { signal }),
  ]);
  const combined = { ...page, rows: [...(page.rows ?? [])] };
  const visited = new Set();
  for (let index = 1; side === 'offline' && index < pages && combined.nextCursor != null; index++) {
    if (visited.has(combined.nextCursor)) throw Error('offline_cursor_repeated');
    visited.add(combined.nextCursor);
    const next = await read('/api/groups/offline?cursor=' + encodeURIComponent(combined.nextCursor), { signal });
    const known = new Set(combined.rows.map(row => row.sessionGroup));
    combined.rows.push(...(next.rows ?? []).filter(row => !known.has(row.sessionGroup)));
    combined.nextCursor = next.nextCursor ?? null;
  }
  return groupSnapshot(instance, counts, combined);
}

/** Instance defaults use one write resource; process actions belong to their object. */
export function instanceActionRequest(action, body = {}) {
  const defaults = { 'switch-model': 'model', 'switch-effort': 'effort', 'set-threshold': 'threshold', 'set-session-hot-ttl': 'session-hot-ttl' };
  if (defaults[action]) return { method: 'PUT', path: '/api/instance/defaults', body: { ...body, kind: defaults[action] } };
  const groups = { 'restart-session': 'restart', interrupt: 'interrupt', 'chop-chop': 'chop-chop' };
  if (groups[action]) return { method: 'POST', path: '/api/groups/origin/actions/' + groups[action], body };
  const actions = { 'switch-mode': 'switch-mode', 'switch-runtime': 'switch-runtime', 'upgrade-zylos': 'upgrade', 'upgrade-cc': 'upgrade-runtime' };
  if (actions[action]) return { method: 'POST', path: '/api/instance/actions/' + actions[action], body };
  // Timezone service restart remains in the settings migration's later step.
  if (action === 'restart-timezone-services') return { method: 'POST', path: '/api/actions/restart-timezone-services', body };
  throw Error('unknown_action');
}
