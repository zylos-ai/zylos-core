import { readSessionMode, ZYLOS_DIR } from './config.js';
import { listGroupTmuxSessions } from './session-group-paths.js';
import { readSessionState, readRuntimeHealth } from './session-state-reader.js';
import { SUPPORTED_RUNTIMES } from './runtime/index.js';
import fs from 'node:fs';

const readError = error => ({ code: 'READ_FAILED', message: error.message });

export async function collectStatus({ mode = readSessionMode, list = listGroupTmuxSessions,
  session = readSessionState, health = readRuntimeHealth, runtimes = SUPPORTED_RUNTIMES,
  now = Date.now, resolveRoot = () => fs.realpathSync(ZYLOS_DIR) } = {}) {
  resolveRoot();
  const readAt = now();
  let sessionMode;
  try { sessionMode = mode().mode; if (![null, 'single', 'multi'].includes(sessionMode)) sessionMode = 'unreadable'; }
  catch { sessionMode = 'unreadable'; }
  const view = sessionMode === null || sessionMode === 'single' ? 'single' : 'multi';
  async function item(sessionGroup) {
    const empty = { sessionGroup, presence: 'unknown', runId: null, sessionId: null, runtime: null,
      status: { valid: false, reason: null, state: null, idleSeconds: null, sampledAt: null }, error: null };
    try {
      const { identity, status } = await session(sessionGroup, { freshnessMs: 5000 });
      return { ...empty, presence: !identity.present ? 'not_running' : identity.ready ? 'running' : 'starting',
        runId: identity.present ? identity.runId : null, sessionId: identity.present ? identity.sessionId : null,
        runtime: identity.present ? identity.runtime : null,
        status: { valid: status.valid, reason: status.reason, sampledAt: status.sampledAt,
          state: status.valid ? status.value.state : null,
          idleSeconds: status.valid ? status.value.idle_seconds ?? null : null } };
    } catch (error) { return { ...empty, error: readError(error) }; }
  }
  const origin = await item(view === 'single' ? null : 'origin');
  let groups = [], groupListError = null;
  if (view === 'multi') {
    try {
      const names = [...new Set((await list()).map(row => row.sessionGroup).filter(group => group !== 'origin'))].sort();
      groups = await Promise.all(names.map(item));
    } catch (error) { groupListError = readError(error); }
  }
  const runtimeHealth = {};
  for (const runtime of runtimes) {
    let record;
    try { record = await health(runtime); } catch { record = { unreadable: true }; }
    const source = record.missing ? 'missing' : record.unreadable ? 'unreadable' : 'record';
    runtimeHealth[runtime] = { source, health: source === 'record' ? record.health : source === 'missing' ? 'ok' : null,
      publicHealth: source === 'record' ? record.publicHealth : source === 'missing' ? 'ok' : null,
      cooldownUntil: source === 'record' ? record.cooldownUntil : null,
      updatedAt: source === 'record' ? record.updatedAt : null };
  }
  return { sessionMode, view, origin, groups, groupListError, runtimeHealth, readAt };
}
