import { randomUUID } from 'node:crypto';
import { loadCoreModule } from './core-modules.js';

const { SUPPORTED_RUNTIMES } = await loadCoreModule('runtime/descriptors.js');

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

  // Mode is diagnostic. Supervisor response establishes readiness even
  // before migration and when there are no running sessions.
  let sessionMode = 'unreadable';
  try {
    const { readSessionMode } = await load('config.js');
    const { mode } = readSessionMode();
    const effective = mode ?? 'single';
    if (['single', 'multi'].includes(effective)) sessionMode = effective;
  } catch { /* Keep the unreadable mode diagnostic. */ }

  const runtimeHealth = {};
  try {
    const reader = await load('session-state-reader.js');
    for (const runtime of SUPPORTED_RUNTIMES) {
      let record;
      try { record = await reader.readRuntimeHealth(runtime); } catch { record = { unreadable: true }; }
      const source = record?.missing ? 'missing' : record?.unreadable || !HEALTH_STATES.has(record?.health) ? 'unreadable' : 'record';
      runtimeHealth[runtime] = { source, health: source === 'record' ? record.health : null };
    }
  } catch {
    for (const runtime of SUPPORTED_RUNTIMES) runtimeHealth[runtime] = { source: 'unreadable', health: null };
  }
  return { ready: supervisor, reason: supervisor ? null : 'supervisor_unavailable', session_mode: sessionMode,
    session_running: null, runtime_health: runtimeHealth };
}
