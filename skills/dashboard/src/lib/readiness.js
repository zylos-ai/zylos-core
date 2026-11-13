import { randomUUID } from 'node:crypto';
import { loadCoreModule } from './core-modules.js';

const HEALTH_STATES = new Set(['ok', 'auth_failed', 'rate_limited', 'unavailable', 'down', 'recovering']);

/** Share only an in-flight check; settlement always releases it. */
export function createReadinessCheck(read = readReadiness) {
  let pending = null;
  return () => {
    if (!pending) {
      pending = Promise.resolve().then(read).finally(() => { pending = null; });
    }
    return pending;
  };
}

/** Read on demand; runtime health is diagnostic and never an admission gate. */
export async function readReadiness({ load = loadCoreModule } = {}) {
  let supervisor = false;
  try {
    const { submit } = await load('am-sock-client.js');
    // An unsupported-version envelope is rejected before admission or writes.
    // Its existing correlated reply proves the supervisor event loop responds.
    const result = await submit({ version: 0, type: 'restart_all', requestId: randomUUID() }, { replyMaxMs: 1000 });
    supervisor = result.kind === 'rejected' && result.reply?.code === 'invalid_request';
  } catch { /* An unavailable IPC peer cannot establish readiness. */ }

  let sessionMode = null, sessionRunning = null;
  try {
    const { readSessionMode } = await load('config.js');
    const mode = readSessionMode().mode ?? 'single';
    if (['single', 'multi'].includes(mode)) sessionMode = mode;
  } catch { /* Unknown mode is not evidence that a single session is absent. */ }

  const runtimeHealth = {};
  try {
    const reader = await load('session-state-reader.js');
    if (sessionMode === 'single') {
      try {
        const identity = await reader.readLiveIdentity(null);
        if (typeof identity?.present === 'boolean') sessionRunning = identity.present;
      }
      catch { /* Observation failure is distinct from confirmed absence. */ }
    }
    for (const runtime of ['claude', 'codex']) {
      let record;
      try { record = await reader.readRuntimeHealth(runtime); } catch { record = { unreadable: true }; }
      const source = record?.missing ? 'missing' : record?.unreadable || !HEALTH_STATES.has(record?.health) ? 'unreadable' : 'record';
      runtimeHealth[runtime] = { source, health: source === 'record' ? record.health : null };
    }
  } catch {
    for (const runtime of ['claude', 'codex']) runtimeHealth[runtime] = { source: 'unreadable', health: null };
  }
  const reason = !supervisor ? 'supervisor_unavailable'
    : sessionMode === 'single' && sessionRunning === false ? 'session_not_running' : null;
  return { ready: reason === null, reason, session_mode: sessionMode,
    session_running: sessionRunning, runtime_health: runtimeHealth };
}
