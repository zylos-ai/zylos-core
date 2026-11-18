// The shared definition of an unfinished mode transition.
export const OPEN_MODE_TRANSITION = "phase NOT IN ('complete','cancelled')";
export function hasOpenModeTransition(c, get) {
  return Boolean(get(c, `SELECT 1 FROM mode_transitions WHERE ${OPEN_MODE_TRANSITION}`));
}

// Normal continuation policy, also applied when a gating switch is cancelled.
const restartReasons = ['upgrade', 'auth', 'model_config', 'unexpected', 'mode_switch'];
export const CONTINUATION_REQUIRED = `(reason IN (${restartReasons.map(reason => "'" + reason + "'").join(',')}) OR (reason='manual_restart' AND session_group<>'origin'))`;
export function continuationRequired(reason, group) {
  return restartReasons.includes(reason) || (reason === 'manual_restart' && group !== 'origin');
}
