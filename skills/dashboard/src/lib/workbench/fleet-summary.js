/** A projection of the Workbench snapshot, never a second status or health reader. */
export function fleetGroupSummary(snapshot) {
  if (snapshot?.mode !== 'multi' || !Array.isArray(snapshot.rows)) return null;
  const rows = snapshot.rows.filter(row => row && ['running', 'starting'].includes(row.presence));
  const counts = { busy: 0, idle: 0, waiting: 0, unknown: 0, error: 0, no_response: 0 };
  const errors = [], silent = [];
  for (const row of rows) {
    // Attention already applies runtime health to the groups it affects. Queue waits,
    // stale samples and read failures are not themselves runtime errors.
    const problem = row.attention?.find(item => ['auth_failed', 'start_failed'].includes(item?.kind));
    const error = problem?.kind ?? (row.state?.kind === 'error' ? 'start_failed' : null);
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
  const restarts = snapshot.instance?.autoRestarts?.count;
  return { running: rows.length, counts, problems: problems.slice(0, 2), problemCount: problems.length,
    listKnown: snapshot.listKnown === true,
    pool: { used: snapshot.instance?.pool?.used ?? null, capacity: snapshot.instance?.pool?.capacity ?? null },
    noResponse: { count: counts.no_response },
    autoRestarts: Number.isSafeInteger(restarts) && restarts >= 0 ? { count: restarts } : null };
}

const count = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' ? value : null;

/** Keep older remote payloads valid and project only the supported, bounded contract. */
export function sanitizeFleetGroupSummary(value) {
  if (!value || !count(value.running) || !value.counts || !Array.isArray(value.problems) || !count(value.problemCount)) return null;
  const keys = ['busy', 'idle', 'waiting', 'unknown', 'error'];
  // An instance from before no-response was counted reports it as null.
  const silent = value.counts.no_response ?? 0;
  if (keys.some(key => !count(value.counts[key])) || !count(silent) ||
      keys.reduce((total, key) => total + value.counts[key], silent) !== value.running ||
      value.problemCount !== value.counts.error + silent) return null;
  const problems = value.problems.slice(0, 2).filter(row => row && typeof row.sessionGroup === 'string' &&
    ['auth_failed', 'start_failed', 'no_response'].includes(row.reason)).map(row => ({
    sessionGroup: row.sessionGroup, displayName: text(row.displayName),
    name: text(row.displayName) ? { displayName: row.displayName } : null,
    createdAt: Number.isFinite(row.createdAt) ? row.createdAt : null,
    c4: text(row.c4?.componentName) ? { componentName: row.c4.componentName } : null,
    reason: row.reason, durationSeconds: row.reason === 'no_response' && count(row.durationSeconds) ? row.durationSeconds : null,
  }));
  if (problems.length !== Math.min(2, value.problemCount)) return null;
  return { running: value.running, counts: { ...Object.fromEntries(keys.map(key => [key, value.counts[key]])), no_response: silent },
    problems, problemCount: value.problemCount, listKnown: value.listKnown === true,
    pool: { used: count(value.pool?.used) ? value.pool.used : null, capacity: count(value.pool?.capacity) ? value.pool.capacity : null },
    noResponse: { count: silent },
    autoRestarts: count(value.autoRestarts?.count) ? { count: value.autoRestarts.count } : null };
}
