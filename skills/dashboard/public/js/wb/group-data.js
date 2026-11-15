/** Page-owned names adapt the compact object rows; evidence stays in group detail. */
export function displayGroupRow(row, side) {
  return { ...row, sessionGroup: row.id ?? row.sessionGroup,
    ...(row.displayName != null ? { name: { displayName: row.displayName } } : {}),
    ...(!row.state && (side === 'offline' || row.id != null) ? { state: { kind: 'offline' } } : {}) };
}

export function groupAttention(instance, counts, rows, failedRows = [], failures = []) {
  const problems = [], reminders = [];
  if (instance.supervisorPaused === true) reminders.push({ kind: 'supervisor_paused' });
  for (const [runtime, record] of Object.entries(instance.runtimeHealth ?? {})) {
    if (record?.health === 'auth_failed') problems.push({ kind: 'auth_failed', runtime,
      groups: rows.filter(row => row.runtime === runtime && row.flags?.blocked?.reason === 'auth_failed').map(row => row.sessionGroup) });
    if (['rate_limited', 'recovering'].includes(record?.health)) reminders.push({ kind: 'rate_limited', runtime, until: record.cooldownUntil });
  }
  const waiting = counts.offline?.waitingSlot ?? 0;
  if (waiting > 0 && counts.pool?.used != null && counts.pool.capacity != null && counts.pool.used >= counts.pool.capacity) reminders.push({ kind: 'pool_full', waiting });
  for (const channel of instance.services?.channels ?? []) if (channel.down) problems.push({ kind: 'channel_down', service: channel.service, pm2Status: channel.status });
  const failed = new Map([...rows, ...failedRows].filter(row => row.flags?.startFailed).map(row => [row.sessionGroup, row]));
  for (const row of failed.values()) problems.push({ kind: 'start_failed', group: row.sessionGroup, count30m: row.flags.startFailed.count, lastAt: row.flags.startFailed.lastAt });
  const unreadable = new Set(failures);
  if (counts.listKnown === false) unreadable.add('groups');
  for (const row of [...rows, ...failedRows]) for (const reason of row.flags?.unreadable?.reasons ?? []) unreadable.add(reason);
  for (const source of unreadable) problems.push({ kind: 'data_unreadable', source });
  return { problems, reminders };
}

/** Assemble page-owned view data from the separate instance and group resources. */
export function groupSnapshot(instance, counts, page) {
  const rows = (page?.rows ?? []).map(row => displayGroupRow(row, page.side));
  const mode = instance.session_mode?.sessionMode ?? null;
  const failedRows = (page.failedRows ?? []).map(row => displayGroupRow(row, 'offline'));
  return { mode, view: ['single', 'multi'].includes(mode) ? mode : 'unreadable',
    baselineRuntime: instance.default_runtime,
    readAt: counts.readAt, listKnown: counts.listKnown !== false && page.listKnown !== false, rows,
    counts: { ...counts.running?.states, offline: counts.offline?.total ?? 0 },
    groupCounts: counts, nextCursor: page.nextCursor ?? null, hasOlder: page.nextCursor != null, overrides: null,
    instance: { ...instance, pool: counts.pool },
    failedRows, attentionFailures: page.attentionFailures ?? [],
    sources: { status: { ok: counts.listKnown !== false && page.listKnown !== false, readAt: page.readAt ?? counts.readAt } },
    attention: groupAttention(instance, counts, rows, failedRows, [...(page.attentionFailures ?? []), ...(page.listKnown === false ? ['groups'] : [])]) };
}

export async function readGroupSnapshot(read, { signal, side = 'running', cursor = null, pages = 1, instance, counts } = {}) {
  const params = new URLSearchParams();
  if (cursor != null) params.set('cursor', cursor);
  const path = side === 'offline' ? '/api/groups/offline' + (params.size ? '?' + params : '') : '/api/groups/running';
  const [instanceData, countsData, page] = await Promise.all([
    instance ?? read('/api/instance', { signal }), counts ?? read('/api/groups/counts', { signal }), read(path, { signal }),
  ]);
  const combined = { ...page, side, rows: [...(page.rows ?? [])] };
  const visited = new Set();
  for (let index = 1; side === 'offline' && index < pages && combined.nextCursor != null; index++) {
    if (visited.has(combined.nextCursor)) throw Error('offline_cursor_repeated');
    visited.add(combined.nextCursor);
    const next = await read('/api/groups/offline?cursor=' + encodeURIComponent(combined.nextCursor), { signal });
    const known = new Set(combined.rows.map(row => row.id ?? row.sessionGroup));
    combined.rows.push(...(next.rows ?? []).filter(row => !known.has(row.id ?? row.sessionGroup)));
    combined.nextCursor = next.nextCursor ?? null;
  }
  if ((countsData.offline?.startFailed ?? 0) > 0) {
    try {
      const failedRows = [], visited = new Set(); let cursor = null;
      do {
        const result = await read('/api/groups/offline?flag=startFailed' + (cursor == null ? '' : '&cursor=' + encodeURIComponent(cursor)), { signal });
        failedRows.push(...(result.rows ?? [])); cursor = result.nextCursor ?? null;
        if (cursor != null && visited.has(cursor)) throw Error('offline_cursor_repeated');
        if (cursor != null) visited.add(cursor);
      } while (cursor != null);
      combined.failedRows = failedRows;
    } catch { combined.attentionFailures = ['offline_start_failed']; }
  }
  return groupSnapshot(instanceData, countsData, combined);
}

/** Instance defaults use one write resource; process actions belong to their object. */
export function instanceActionRequest(action, body = {}) {
  const defaults = { 'switch-model': 'model', 'switch-effort': 'effort', 'set-threshold': 'threshold', 'set-session-hot-ttl': 'session-hot-ttl' };
  if (defaults[action]) return { method: 'PUT', path: '/api/instance/defaults', body: { ...body, kind: defaults[action] } };
  const groups = { 'restart-session': 'restart', interrupt: 'interrupt', 'chop-chop': 'chop-chop' };
  if (groups[action]) return { method: 'POST', path: '/api/groups/origin/actions/' + groups[action], body };
  const actions = { 'switch-mode': 'switch-mode', 'switch-runtime': 'switch-runtime', 'upgrade-zylos': 'upgrade', 'upgrade-cc': 'upgrade-runtime' };
  if (actions[action]) return { method: 'POST', path: '/api/instance/actions/' + actions[action], body };
  // Timezone service restart remains in the existing settings API.
  if (action === 'restart-timezone-services') return { method: 'POST', path: '/api/actions/restart-timezone-services', body };
  throw Error('unknown_action');
}
