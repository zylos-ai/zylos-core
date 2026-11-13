const timestamp = value => typeof value === 'number' ? value : Date.parse(value);

export const STALE_STATUS_DISPLAY_MS = 60_000;

export function classify(row, { statusError, now = Date.now() } = {}) {
  const unknown = reason => ({ kind: 'unknown', reason: reason ?? 'no_rule' });
  if (row.presence === 'unknown' || row.live?.error || statusError) return unknown(statusError ?? row.live?.error?.code ?? row.reason);
  const wait = row.wait;
  if (wait?.kind === 'start_failed') return { kind: 'error' };
  const status = row.live?.status;
  const stale = row.presence === 'running' && !status?.valid && status?.reason === 'stale';
  const age = now - status?.sampledAt;
  if (stale && ['busy', 'idle'].includes(status.lastState) && Number.isFinite(status.sampledAt) &&
      age >= 0 && age < STALE_STATUS_DISPLAY_MS) {
    const state = classify({ ...row, live: { ...row.live, status: { ...status, valid: true, state: status.lastState } } }, { statusError, now });
    return { ...state, stale: true, sampledAt: status.sampledAt };
  }
  if (row.presence === 'running' && !status?.valid) return { ...unknown(status?.reason), sampledAt: status?.sampledAt };
  if (row.presence === 'running' && row.live.status.state === 'busy' && (!wait || ['queued', 'unknown'].includes(wait.kind))) return { kind: 'busy' };
  if (wait && !['queued', 'unknown'].includes(wait.kind)) return { kind: 'waiting' };
  if (wait?.kind === 'unknown' && wait.pendingKnown !== false) return { kind: 'waiting' };
  if (row.presence === 'running' && row.live.status.state === 'idle') return { kind: 'idle' };
  if (row.presence === 'not_running') return { kind: 'not_running' };
  return unknown('no_rule');
}

export function durationOf(row, { now = Date.now(), events = [] } = {}) {
  if (row.state.kind === 'idle') return (row.state.stale ? row.live.status.lastIdleSeconds : row.live.status.idleSeconds) ?? null;
  if (row.state.kind === 'waiting') {
    const start = row.wait.kind === 'starting' ? (row.createdAt == null ? null : row.createdAt * 1000) : row.wait.kind === 'fenced' ? (row.fence.createdAt == null ? null : row.fence.createdAt * 1000) : row.queue.pending.oldestAt;
    return start == null || !Number.isFinite(start) ? null : Math.max(0, (now - start) / 1000);
  }
  if (row.state.kind !== 'busy') return null;
  const turns = events.filter(event => event.session_group === row.sessionGroup && event.run_id === row.live.runId && ['user_prompt_submit', 'stop'].includes(event.event_type) && timestamp(event.timestamp) <= now)
    .sort((a, b) => timestamp(b.timestamp) - timestamp(a.timestamp) || (b.event_seq ?? 0) - (a.event_seq ?? 0));
  return turns[0]?.event_type === 'user_prompt_submit' ? Math.max(0, (now - timestamp(turns[0].timestamp)) / 1000) : null;
}

const order = { busy: 1, waiting: 2, error: 2, unknown: 3, idle: 4, not_running: 5 };
export function sortRows(rows) {
  return [...rows].sort((a, b) => Number(b.origin) - Number(a.origin) ||
    Number(Boolean(b.attention?.length)) - Number(Boolean(a.attention?.length)) || order[a.state.kind] - order[b.state.kind] ||
    (b.c4?.lastActivityAt ?? -Infinity) - (a.c4?.lastActivityAt ?? -Infinity));
}

export function countRows(rows) {
  const counts = { busy: 0, waiting: 0, error: 0, unknown: 0, idle: 0, not_running: 0 };
  for (const row of rows) counts[row.state.kind]++;
  return counts;
}
