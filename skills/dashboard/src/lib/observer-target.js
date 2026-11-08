import { loadCoreModule } from './core-modules.js';

const unavailable = () => Object.assign(new Error('Selected group has no ready managed session'), { code: 'agent_session_unavailable' });

// Resolve through this installation's Core reader, never a caller-supplied tmux name.
export function createObserverTargets({ load = loadCoreModule } = {}) {
  const mode = async () => (await load('config.js')).readSessionMode().mode ?? 'single';
  const resolve = async (sessionGroup) => {
    const sessionMode = await mode();
    const [{ readLiveIdentity }, paths] = await Promise.all([load('session-state-reader.js'), load('session-group-paths.js')]);
    if (sessionMode !== 'multi' && sessionGroup != null && sessionGroup !== 'origin') {
      throw Object.assign(new Error('Only Origin is available in single session mode'), { code: 'target_mismatch' });
    }
    const group = sessionMode === 'multi' ? sessionGroup ?? 'origin' : null;
    if (group !== null) {
      try { paths.assertSessionGroup(group); } catch { throw Object.assign(new Error('Invalid observer group'), { code: 'target_mismatch' }); }
    }
    let identity;
    try { identity = await readLiveIdentity(group); } catch { throw unavailable(); }
    const expectedName = paths.tmuxNameForGroup(group ?? 'origin');
    if (!identity?.present || !identity.ready || !identity.runId ||
        !['claude', 'codex'].includes(identity.runtime) || identity.tmuxName !== expectedName) throw unavailable();
    return { sessionMode, sessionGroup: group, tmuxName: identity.tmuxName, runId: identity.runId, runtime: identity.runtime };
  };
  return { mode, resolve };
}

export function sameObserverTarget(left, right) {
  return Boolean(left && right) && left.runId === right.runId &&
    left.sessionGroup === right.sessionGroup && left.runtime === right.runtime && left.tmuxName === right.tmuxName;
}

export async function validObserverBinding(binding, target, runId) {
  if (!binding || !['claude', 'codex'].includes(binding.runtime) || typeof binding.runId !== 'string' || !binding.runId ||
      binding.runId !== runId || binding.tmuxName !== target) return false;
  if (binding.sessionMode === 'single') return binding.sessionGroup === null && target === 'zylos-group-origin';
  if (binding.sessionMode !== 'multi' || typeof binding.sessionGroup !== 'string') return false;
  const paths = await loadCoreModule('session-group-paths.js');
  try { return paths.tmuxNameForGroup(binding.sessionGroup) === target && paths.groupFromTmuxName(target) === binding.sessionGroup; }
  catch { return false; }
}
