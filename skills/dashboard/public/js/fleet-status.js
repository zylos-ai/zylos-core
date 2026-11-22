export function stateMood(agent) {
  const state = String(agent?.state || 'UNKNOWN').toUpperCase();
  const reason = String(agent?.health_reason || '').toLowerCase();
  if (state === 'OFFLINE' || reason === 'offline' || reason === 'unreachable' || reason === 'version_unsupported' || reason === 'auth_failed') return 'offline';
  if (state === 'AUTH_WAIT' || state === 'WAKE_OVERDUE') return 'stuck';
  if (state === 'IDLE') return 'idle';
  if (state === 'BUSY') return 'busy';
  if (state === 'UNKNOWN') return 'unknown';
  return 'idle';
}

export function isOffline(agent) {
  return stateMood(agent) === 'offline' || Number(agent?.pulse_rate) === 0;
}

export function fleetMood(agent) {
  return isOffline(agent) ? 'offline' : stateMood(agent);
}

/** Connection state of a configured remote machine. */
export function remoteStatus(record) {
  if (!record) return { kind: 'unknown' };
  const reason = String(record.health_reason || '').toLowerCase();
  if (reason === 'not_polled') return { kind: 'pending' };
  if (reason === 'auth_failed') return { kind: 'auth' };
  if (reason === 'version_unsupported') return { kind: 'version' };
  if (record.pulse_rate === 0 || ['unreachable', 'timeout', 'conn_refused', 'bad_payload', 'offline'].includes(reason) || record.link?.quality === 'down') return { kind: 'down', reason: reason || record.link?.reason || null };
  return { kind: 'ok', latency: Number.isFinite(record.link?.latency_ms) ? Math.round(record.link.latency_ms) : null };
}
