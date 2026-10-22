import { dataError, requireGroup } from './c4-session-group.js';
export function normalizeTargetBinding(value) {
  if (value === null || value === undefined) return null;
  try {
    const v = typeof value === 'string' ? JSON.parse(value) : value;
    const text = x => typeof x === 'string' && x.length > 0;
    if (!v || Array.isArray(v) || Object.keys(v).some(k => !['expectedRunId','tmuxTarget','expectedSessionId'].includes(k)) || !text(v.expectedRunId)) throw new Error('Invalid binding fields');
    const t = v.tmuxTarget;
    if (!t || Array.isArray(t) || Object.keys(t).length !== 3 || Object.keys(t).some(k => !['serverGeneration','sessionId','paneId'].includes(k)) || !text(t.serverGeneration) || !/^\$\d+$/.test(t.sessionId) || !/^%\d+$/.test(t.paneId)) throw new Error('Invalid tmux identity');
    if (v.expectedSessionId != null && !text(v.expectedSessionId)) throw new Error('Invalid expected session');
    return JSON.stringify({ expectedRunId: v.expectedRunId, tmuxTarget: { serverGeneration: t.serverGeneration, sessionId: t.sessionId, paneId: t.paneId }, ...(v.expectedSessionId == null ? {} : { expectedSessionId: v.expectedSessionId }) });
  } catch (cause) { throw dataError('TARGET_BINDING_INVALID', 'Invalid target binding', { cause }); }
}

// resolveTarget is a private Core dependency. It must collect the target,
// environment, runtime and READY identity using one tmux server connection.
export function createTargetBindingBuilder({ baseline, snapshot, knownGroup, get, resolveTarget }) {
  return function buildTargetBinding(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => !['sessionGroup', 'expectedRunId', 'expectedRuntime', 'expectedSessionId'].includes(k))) throw dataError('INVALID_ARGS', 'Invalid target binding options');
    const { sessionGroup = null, expectedRunId, expectedRuntime, expectedSessionId } = options;
    if (typeof expectedRunId !== 'string' || !expectedRunId || (expectedRuntime !== undefined && (typeof expectedRuntime !== 'string' || !expectedRuntime)) || (expectedSessionId != null && (typeof expectedSessionId !== 'string' || !expectedSessionId))) throw dataError('INVALID_ARGS', 'Expected target identity is required');
    const { sessionMode } = baseline();
    snapshot(c => {
      if (sessionMode === 'single' && sessionGroup !== null) throw dataError('TARGET_SCOPE_MISMATCH', 'Single mode does not accept a group target');
      if (sessionMode === 'multi') {
        if (sessionGroup === null) throw dataError('CONTROL_TARGET_REQUIRED', 'Multi mode requires a group target');
        requireGroup(sessionGroup); knownGroup(c, sessionGroup);
      }
      if (get(c, "SELECT 1 FROM mode_transitions WHERE phase<>'complete'")) throw dataError('TRANSITION_OPEN', 'A mode transition is in progress');
    });
    if (typeof resolveTarget !== 'function') throw dataError('TARGET_SNAPSHOT_UNKNOWN', 'Core target resolver has not been connected');
    const target = resolveTarget({ sessionGroup, sessionMode });
    if (!target) throw dataError('TARGET_NOT_RUNNING', 'The target session is not running');
    if (target.runId !== expectedRunId) throw dataError('TARGET_MISMATCH', 'The target run has changed', { runId: target.runId ?? null });
    if (!target.runtime || target.runtime === 'unknown') throw dataError('TARGET_SNAPSHOT_UNKNOWN', 'The target runtime cannot be identified');
    if (expectedRuntime !== undefined && target.runtime !== expectedRuntime) throw dataError('TARGET_RUNTIME_MISMATCH', 'The target runtime has changed');
    if (sessionMode === 'multi' ? target.sessionGroup !== sessionGroup : target.sessionGroup !== undefined && target.sessionGroup !== null) throw dataError('TARGET_SCOPE_MISMATCH', 'The target session environment does not match its scope');
    if (!target.currentSession || target.currentSession.runId !== target.runId) throw dataError('TARGET_NOT_READY', 'The target READY identity does not match');
    if (expectedSessionId != null && target.currentSession.sessionId !== expectedSessionId) throw dataError('STALE_TARGET', 'The target session has changed');
    return normalizeTargetBinding({ expectedRunId, tmuxTarget: target.tmuxTarget, expectedSessionId });
  };
}
