// The shared definition of an unfinished mode transition.
export const OPEN_MODE_TRANSITION = "phase<>'complete'";
export function hasOpenModeTransition(c, get) {
  return Boolean(get(c, `SELECT 1 FROM mode_transitions WHERE ${OPEN_MODE_TRANSITION}`));
}

// Normal continuation policy.
const restartReasons = ['upgrade', 'auth', 'model_config', 'unexpected'];
export function continuationRequired(reason, group) {
  return restartReasons.includes(reason) || (reason === 'manual_restart' && group !== 'origin');
}
