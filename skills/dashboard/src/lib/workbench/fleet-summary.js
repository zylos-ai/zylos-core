import { groupAttention } from '../../../public/js/wb/group-data.js';

/** A projection of the Workbench snapshot, never a second status or health reader. */
export function fleetGroupSummary(snapshot) {
  if (snapshot?.mode !== 'multi' || !Array.isArray(snapshot.rows)) return null;
  const rows = snapshot.rows.filter(row => row && ['running', 'starting', 'unknown'].includes(row.presence));
  const counts = { busy: 0, idle: 0, waiting: 0, unknown: 0, error: 0, no_response: 0 };
  const errors = [], silent = [];
  for (const row of rows) {
    // Compact flags carry the existing error observations. Queue waits, stale
    // samples and read failures are not themselves runtime errors.
    const runtime = row.runtime ?? row.target?.runtime ?? row.live?.runtime;
    // Unknown activity does not erase an independently observed authentication failure.
    const authFailed = row.flags?.blocked?.reason === 'auth_failed' ||
      ['running', 'starting', 'unknown'].includes(row.presence) && snapshot.instance?.runtimeHealth?.[runtime]?.health === 'auth_failed';
    const error = authFailed ? 'auth_failed'
      : row.flags?.startFailed || row.state?.kind === 'error' ? 'start_failed' : null;
    // A group the supervisor reminded and that has not responded since; an error outranks it.
    const since = !error && Number.isFinite(row.noResponse?.since) ? row.noResponse.since : null;
    const reason = error ?? (since === null ? null : 'no_response');
    const kind = error ? 'error' : reason ?? row.state?.kind;
    counts[Object.hasOwn(counts, kind) ? kind : 'unknown']++;
    if (reason) (error ? errors : silent).push({ sessionGroup: row.sessionGroup,
      displayName: row.name?.displayName ?? null,
      name: row.name?.displayName ? { displayName: row.name.displayName } : null,
      createdAt: row.createdAt ?? null,
      c4: row.c4?.componentName ? { componentName: row.c4.componentName } : null,
      reason, durationSeconds: since === null || !Number.isFinite(snapshot.readAt) ? null : Math.max(0, Math.floor((snapshot.readAt - since) / 1000)) });
  }
  const problems = [...errors, ...silent];
  const observations = groupAttention(snapshot.instance ?? {}, { ...snapshot.groupCounts, listKnown: snapshot.listKnown },
    snapshot.rows, snapshot.failedRows ?? [], snapshot.attentionFailures ?? []);
  const attention = [...observations.problems, ...observations.reminders]
    .filter(item => ['channel_send_failed', 'channel_restarting', 'rate_limited', 'data_unreadable'].includes(item.kind) ||
      item.kind === 'start_failed' && !rows.some(row => row.sessionGroup === item.group));
  const restarts = snapshot.instance?.autoRestarts?.count;
  return { running: rows.length, counts, problems: problems.slice(0, 2), problemCount: problems.length,
    listKnown: snapshot.listKnown === true,
    pool: { used: snapshot.instance?.pool?.used ?? null, capacity: snapshot.instance?.pool?.capacity ?? null },
    noResponse: { count: Number.isSafeInteger(snapshot.groupCounts?.running?.flags?.noResponse) ? snapshot.groupCounts.running.flags.noResponse : counts.no_response },
    autoRestarts: Number.isSafeInteger(restarts) && restarts >= 0 ? { count: restarts } : null,
    ...(attention.length ? { attention: sanitizeAttention(attention) } : {}) };
}

const count = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' ? value : null;
const attentionKinds = new Set(['channel_send_failed', 'channel_restarting', 'rate_limited', 'data_unreadable', 'start_failed']);
function sanitizeAttention(items) {
  return items.slice(0, 100).filter(item => item && attentionKinds.has(item.kind)).map(item => ({
    kind: item.kind,
    ...Object.fromEntries(['group', 'displayName', 'runtime', 'channel', 'service', 'reasonCode', 'source'].filter(key => text(item[key]) !== null)
      .map(key => [key, item[key].slice(0, 500)])),
    ...(count(item.count) ? { count: item.count } : {}),
    ...(count(item.count30m) ? { count30m: item.count30m } : {}),
    ...(Number.isFinite(item.until) || text(item.until) !== null ? { until: item.until } : {}),
  }));
}

/** Keep older remote payloads valid and project only the supported, bounded contract. */
export function sanitizeFleetGroupSummary(value) {
  if (!value || !count(value.running) || !value.counts || !Array.isArray(value.problems) || !count(value.problemCount)) return null;
  const keys = ['busy', 'idle', 'waiting', 'unknown', 'error'];
  // An instance from before no-response was counted reports it as null.
  const silent = value.counts.no_response ?? 0;
  if (keys.some(key => !count(value.counts[key])) || !count(silent) ||
      keys.reduce((total, key) => total + value.counts[key], silent) !== value.running ||
      value.problemCount !== value.counts.error + silent) return null;
  const noResponseCount = value.noResponse?.count ?? silent;
  if (!count(noResponseCount) || noResponseCount < silent || noResponseCount > value.running) return null;
  const problems = value.problems.slice(0, 2).filter(row => row && typeof row.sessionGroup === 'string' &&
    ['auth_failed', 'start_failed', 'no_response'].includes(row.reason)).map(row => ({
    sessionGroup: row.sessionGroup, displayName: text(row.displayName),
    name: text(row.displayName) ? { displayName: row.displayName } : null,
    createdAt: Number.isFinite(row.createdAt) || typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt)) ? row.createdAt : null,
    c4: text(row.c4?.componentName) ? { componentName: row.c4.componentName } : null,
    reason: row.reason, durationSeconds: row.reason === 'no_response' && count(row.durationSeconds) ? row.durationSeconds : null,
  }));
  if (problems.length !== Math.min(2, value.problemCount)) return null;
  if (value.attention !== undefined && !Array.isArray(value.attention)) return null;
  return { running: value.running, counts: { ...Object.fromEntries(keys.map(key => [key, value.counts[key]])), no_response: silent },
    problems, problemCount: value.problemCount, listKnown: value.listKnown === true,
    pool: { used: count(value.pool?.used) ? value.pool.used : null, capacity: count(value.pool?.capacity) ? value.pool.capacity : null },
    noResponse: { count: noResponseCount },
    autoRestarts: count(value.autoRestarts?.count) ? { count: value.autoRestarts.count } : null,
    ...(value.attention !== undefined ? { attention: sanitizeAttention(value.attention) } : {}) };
}
