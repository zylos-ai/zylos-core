/** A projection of the Workbench snapshot, never a second status or health reader. */
export function fleetGroupSummary(snapshot) {
  if (snapshot?.mode !== 'multi' || !Array.isArray(snapshot.rows)) return null;
  const rows = snapshot.rows.filter(row => row && ['running', 'starting'].includes(row.presence));
  const counts = { busy: 0, idle: 0, waiting: 0, unknown: 0, error: 0, no_response: null };
  const problems = [];
  for (const row of rows) {
    // Attention already applies runtime health to the groups it affects. Queue waits,
    // stale samples and read failures are not themselves runtime errors.
    const problem = row.attention?.find(item => ['auth_failed', 'start_failed'].includes(item?.kind));
    const reason = problem?.kind ?? (row.state?.kind === 'error' ? 'start_failed' : null);
    const kind = reason ? 'error' : row.state?.kind;
    counts[Object.hasOwn(counts, kind) && kind !== 'no_response' ? kind : 'unknown']++;
    if (reason) problems.push({ sessionGroup: row.sessionGroup,
      displayName: row.name?.displayName ?? null,
      name: row.name?.displayName ? { displayName: row.name.displayName } : null,
      createdAt: row.createdAt ?? null,
      c4: row.c4?.componentName ? { componentName: row.c4.componentName } : null,
      reason, durationSeconds: null });
  }
  return { running: rows.length, counts, problems: problems.slice(0, 2), problemCount: problems.length,
    listKnown: snapshot.listKnown === true,
    pool: { used: snapshot.instance?.pool?.used ?? null, capacity: snapshot.instance?.pool?.capacity ?? null },
    // Reserved for the supervisor's authoritative no-response and restart records.
    noResponse: null, autoRestarts: null };
}

const count = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' ? value : null;

/** Keep older remote payloads valid and project only the supported, bounded contract. */
export function sanitizeFleetGroupSummary(value) {
  if (!value || !count(value.running) || !value.counts || !Array.isArray(value.problems) || !count(value.problemCount)) return null;
  const keys = ['busy', 'idle', 'waiting', 'unknown', 'error'];
  if (keys.some(key => !count(value.counts[key])) || keys.reduce((total, key) => total + value.counts[key], 0) !== value.running ||
      value.problemCount !== value.counts.error) return null;
  const problems = value.problems.slice(0, 2).filter(row => row && typeof row.sessionGroup === 'string' &&
    ['auth_failed', 'start_failed'].includes(row.reason)).map(row => ({
    sessionGroup: row.sessionGroup, displayName: text(row.displayName),
    name: text(row.displayName) ? { displayName: row.displayName } : null,
    createdAt: Number.isFinite(row.createdAt) ? row.createdAt : null,
    c4: text(row.c4?.componentName) ? { componentName: row.c4.componentName } : null,
    reason: row.reason, durationSeconds: null,
  }));
  if (problems.length !== Math.min(2, value.problemCount)) return null;
  return { running: value.running, counts: { ...Object.fromEntries(keys.map(key => [key, value.counts[key]])), no_response: null },
    problems, problemCount: value.problemCount, listKnown: value.listKnown === true,
    pool: { used: count(value.pool?.used) ? value.pool.used : null, capacity: count(value.pool?.capacity) ? value.pool.capacity : null },
    noResponse: null, autoRestarts: null };
}
