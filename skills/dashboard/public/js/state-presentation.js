export function stateTitleKey(value, mood) {
  if (mood === 'thinking') return 'agent_fleet.thinking';
  const state = String(value || 'UNKNOWN').toUpperCase();
  if (state === 'BUSY') return 'state.busy_simple';
  if (state === 'STARTING') return 'state.starting';
  if (state === 'IDLE') return 'state.idle';
  if (state === 'OFFLINE') return 'state.offline';
  if (state === 'WAITING_HUMAN') return 'state.waiting';
  if (state === 'POSSIBLY_STUCK') return 'state.possibly_stuck_simple';
  if (state === 'STUCK') return 'state.stuck_simple';
  return 'state.unknown_simple';
}

export function pendingDepthValue(depth) {
  return Number.isSafeInteger(depth) && depth >= 0 ? String(depth) : null;
}

export function sessionBlockTitleKey(sessionGroup) {
  if (sessionGroup === 'origin') return 'block.origin';
  if (sessionGroup === null) return 'block.single_session';
  return 'block.unknown_session';
}
