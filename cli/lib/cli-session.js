import { readSessionMode } from './config.js';
import { assertSessionGroup } from './session-group-paths.js';
import { readLiveIdentity, resolveTargetRuntime } from './session-state-reader.js';
import { getSessionAdapter } from './runtime/index.js';

export async function resolveCliSession({ env = process.env, mode = readSessionMode,
  identity = readLiveIdentity, resolveRuntime = resolveTargetRuntime, adapter = getSessionAdapter } = {}) {
  const sessionMode = mode().mode;
  const sessionGroup = sessionMode === 'multi' ? env.ZYLOS_SESSION_GROUP ?? 'origin' : null;
  if (sessionGroup !== null) assertSessionGroup(sessionGroup);
  const live = await identity(sessionGroup);
  const runtime = live.present ? live.runtime : await resolveRuntime(sessionGroup);
  return { sessionGroup, live, adapter: adapter(runtime), runtime };
}
