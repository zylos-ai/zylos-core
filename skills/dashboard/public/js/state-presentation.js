export function originSessionUnavailable(payload) {
  const state = String(payload?.state || '').toUpperCase();
  return (payload?.sessionGroup === 'origin' && !payload?.runId)
    || ['SLEEPING', 'WAKING', 'WAKE_OVERDUE', 'RATE_WAIT', 'RECLAIMING', 'SWITCHING'].includes(state)
    || (state === 'AUTH_WAIT' && !payload?.runId);
}
