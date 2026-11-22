/** Page-owned names adapt the compact object rows; evidence stays in group detail. */
export function displayGroupRow(row, side) {
  return { ...row, sessionGroup: row.id ?? row.sessionGroup,
    ...(row.displayName != null ? { name: { displayName: row.displayName } } : {}),
    ...(!row.state && (side === 'offline' || row.id != null) ? { state: { kind: 'offline' } } : {}) };
}

export const CHANNEL_RESTART_THRESHOLD = 3;

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
  for (const channel of instance.services?.channels ?? []) {
    if (channel.lastSendFailed) problems.push({ kind: 'channel_send_failed', channel: channel.channel, count: channel.consecutiveFailures });
    if (channel.restarts10m >= CHANNEL_RESTART_THRESHOLD) problems.push({ kind: 'channel_restarting', channel: channel.channel, count: channel.restarts10m });
  }
  const failed = new Map([...rows, ...failedRows].filter(row => row.flags?.startFailed).map(row => [row.sessionGroup, row]));
  for (const row of failed.values()) problems.push({ kind: 'start_failed', group: row.sessionGroup, count30m: row.flags.startFailed.count, lastAt: row.flags.startFailed.lastAt });
  const unreadable = new Set(failures);
  if (counts.listKnown === false) unreadable.add('groups');
  const seen = new Set();
  for (const row of [...rows, ...failedRows]) for (const reasonCode of row.flags?.unreadable?.reasons ?? []) {
    const group = row.sessionGroup ?? row.id;
    const key = JSON.stringify([group, reasonCode]);
    if (!seen.has(key)) problems.push({ kind: 'data_unreadable', group,
      displayName: row.name?.displayName ?? row.displayName ?? group, reasonCode });
    seen.add(key);
  }
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
    sources: { status: { ok: counts.listKnown !== false && page.listKnown !== false, readAt: page.sources?.status?.readAt ?? page.readAt ?? counts.readAt } },
    attention: groupAttention(instance, counts, rows, failedRows, [...(page.attentionFailures ?? []), ...(page.listKnown === false ? ['groups'] : [])]) };
}

export function groupDetailPath(id, include) {
  const path = '/api/groups/' + encodeURIComponent(id);
  // The Origin Operations Interface retains its legacy includes.
  return include || id === 'origin' ? path + '?include=' + (include ?? '') : path;
}

export async function readGroupPage(read, { signal, side, cursor, q, flag } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ side, flag, q, cursor })) {
    if (value != null) params.set(key, value);
  }
  const result = await read('/api/groups' + (params.size ? '?' + params : ''), { signal });
  return { ...result, rows: (result.items ?? []).map(row => displayGroupRow(row, side)) };
}

export async function readGroupPages(read, { pages = 1, ...options } = {}) {
  const page = await readGroupPage(read, options);
  const rows = [...page.rows], known = new Set(rows.map(row => row.sessionGroup)), visited = new Set();
  let { nextCursor, listKnown } = page;
  for (let index = 1; index < pages && nextCursor != null; index++) {
    if (visited.has(nextCursor)) throw Error('group_cursor_repeated');
    visited.add(nextCursor);
    const next = await readGroupPage(read, { ...options, cursor: nextCursor });
    for (const row of next.rows) {
      if (known.has(row.sessionGroup)) continue;
      rows.push(row);
      known.add(row.sessionGroup);
    }
    nextCursor = next.nextCursor;
    if (next.listKnown === false) listKnown = false;
  }
  return { ...page, rows, listKnown, nextCursor: nextCursor ?? null };
}

export async function readGroupSnapshot(read, { signal, side = 'running', cursor, pages = 1, instance, counts } = {}) {
  const [instanceData, countsData, page] = await Promise.all([
    instance ?? read('/api/instance', { signal }), counts ?? read('/api/groups/counts', { signal }),
    readGroupPages(read, { signal, side, pages, cursor }),
  ]);
  const combined = { ...page, side };
  if ((countsData.offline?.startFailed ?? 0) > 0) {
    try {
      const failedRows = [], visited = new Set(); let cursor = null;
      do {
        const result = await readGroupPage(read, { signal, side: 'offline', flag: 'startFailed', cursor });
        failedRows.push(...result.rows); cursor = result.nextCursor ?? null;
        if (cursor != null && visited.has(cursor)) throw Error('group_cursor_repeated');
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
  const actions = { 'switch-mode': 'switch-mode', 'switch-runtime': 'switch-runtime', 'upgrade-cc': 'upgrade-runtime' };
  if (actions[action]) return { method: 'POST', path: '/api/instance/actions/' + actions[action], body };
  // Timezone service restart belongs to its settings resource.
  if (action === 'restart-timezone-services') return { method: 'POST', path: '/api/settings/timezone/actions/restart-services', body };
  throw Error('unknown_action');
}
