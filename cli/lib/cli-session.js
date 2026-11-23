import { readSessionMode } from './config.js';
import { assertSessionGroup } from './session-group-paths.js';
import { readLiveIdentity, resolveTargetRuntime } from './session-state-reader.js';
import { getRuntime } from './runtime/index.js';

export async function resolveCliSession({ env = process.env, mode = readSessionMode,
  identity = readLiveIdentity, resolveRuntime = resolveTargetRuntime, runtimeFor = getRuntime } = {}) {
  const sessionMode = mode().mode;
  const sessionGroup = sessionMode === 'multi' ? env.ZYLOS_SESSION_GROUP ?? 'origin' : null;
  if (sessionGroup !== null) assertSessionGroup(sessionGroup);
  const live = await identity(sessionGroup);
  let runtime;
  if (live.present) runtime = live.runtime;
  else {
    try { runtime = await resolveRuntime(sessionGroup); }
    catch (error) {
      if (sessionMode !== 'multi') throw error;
      // Display callers retain the absent identity when target configuration is unreadable.
      runtime = 'unknown';
    }
  }
  return { sessionGroup, live, runtimeImpl: runtime === 'unknown' ? null : await runtimeFor(runtime), runtime };
}
