import { randomUUID } from 'node:crypto';
import { submit } from './am-sock-client.js';
import { listGroupTmuxSessions } from './session-group-paths.js';
import { readLiveIdentity } from './session-state-reader.js';

async function configurationOverrides(groups, modelRuntime) {
  const store = await import('../../skills/comm-bridge/scripts/c4-db.js');
  if (!modelRuntime) return store.listGroupRuntimeOverrides();
  return store.listOverridesForGroups(groups).model.filter(row => row.runtime === modelRuntime);
}

export async function requestConfigRestart({ sessionGroup, runId }, send = submit) {
  if (!runId) return { status: 'not_restarted', reason: 'identity_unavailable' };
  try {
    const result = await send({ version: 1, type: 'manual_restart', requestId: randomUUID(),
      sessionGroup, expectedRunId: runId }, { deadlineAt: Date.now() + 10000 });
    if (result.kind === 'accepted' && ['accepted', 'already_accepted'].includes(result.reply.result)) {
      return { status: 'accepted' };
    }
    const reason = result.reply?.reason ?? result.reply?.code ?? result.reply?.result ?? result.kind;
    return { status: result.sent && !result.reply ? 'unknown' : 'not_restarted', reason };
  } catch (error) {
    return { status: 'unknown', reason: error.code ?? error.message };
  }
}

export async function observeRuntimeGroups(baseline, sessionMode, { list = listGroupTmuxSessions,
  modelRuntime = null, overrides = configurationOverrides,
  identity = readLiveIdentity } = {}) {
  const result = { groups: [], groupsComplete: true, observationErrors: [] };
  const names = new Set(['origin']);
  const failures = (source, sessionGroup, error) => {
    result.groupsComplete = false;
    result.observationErrors.push({ source, sessionGroup, code: 'READ_FAILED', message: error.message });
  };
  try { if (sessionMode !== 'single') for (const row of await list()) names.add(row.sessionGroup); } catch (error) { failures('tmux', null, error); }
  let configured;
  try {
    configured = new Set((await overrides([...names], modelRuntime)).map(row => row.sessionGroup));
    for (const group of configured) names.add(group);
  }
  catch (error) { failures('overrides', null, error); }
  for (const sessionGroup of [...names].sort()) {
    let live = null, error = null;
    try { if (sessionMode !== 'single' || sessionGroup === 'origin') live = await identity(sessionGroup); }
    catch (cause) { error = { code: 'READ_FAILED', message: cause.message }; failures('session', sessionGroup, cause); }
    const liveRuntime = live?.present ? live.runtime : null;
    const inherits = modelRuntime && live?.launchConfig?.mode === 'override' ? false
      : configured ? !configured.has(sessionGroup) : null;
    const otherRuntime = modelRuntime && liveRuntime && liveRuntime !== 'unknown' && liveRuntime !== modelRuntime;
    let status;
    if (inherits === false) status = 'override_kept';
    else if (otherRuntime) status = 'effective';
    else if (live?.present && live.ready === false) status = 'starting';
    else if (inherits === null || error || liveRuntime === 'unknown' || (live?.present && !live.launchConfig)) status = 'unknown';
    else if (!live?.present) status = 'not_running';
    else status = !modelRuntime && liveRuntime === baseline ? 'effective' : 'restart_needed';
    result.groups.push({ sessionGroup, inherits, liveRuntime, status, error,
      ...((!modelRuntime || status === 'restart_needed') && live?.present && typeof live.runId === 'string' && live.runId && { runId: live.runId }) });
  }
  return result;
}

export async function restartObservedGroups(observed, { restart = requestConfigRestart, modeChanged = false, skipStartingRuntime } = {}) {
  await Promise.all(observed.groups.map(async group => {
    const { sessionGroup, runId, inherits, status } = group;
    if (['override_kept', 'effective', 'not_running'].includes(status) ||
      (status === 'starting' && group.liveRuntime === skipStartingRuntime)) return;
    const reason = modeChanged ? 'mode_changed' : inherits === null ? 'override_state_unknown'
      : status === 'starting' ? 'not_ready' : !runId ? 'identity_unavailable' : null;
    group.restart = reason ? { status: 'not_restarted', reason } : await restart({ sessionGroup, runId });
  }));
}
