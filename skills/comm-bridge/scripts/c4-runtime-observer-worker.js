import { workerData } from 'node:worker_threads';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function observe() {
  const { sessionGroup = null, sessionMode } = workerData.options ?? {};
  if (!['single', 'multi'].includes(sessionMode)) throw Object.assign(new Error('Invalid session mode'), { code: 'INVALID_ARGS' });
  const lib = path.dirname(workerData.coreConfigPath);
  const [{ openTmuxConnection }, { observeSessionTarget, revalidateSessionTarget, readTargetRuntime }] = await Promise.all([
    import(pathToFileURL(path.join(lib, 'runtime/tmux-connection.js')).href),
    import(pathToFileURL(path.join(lib, 'runtime/session-target.js')).href),
  ]);
  let connection;
  try {
    connection = await openTmuxConnection(workerData.tmux);
    const target = await observeSessionTarget({ sessionGroup: sessionMode === 'single' ? null : sessionGroup, connection });
    if (!target.present) return workerData.method === 'running' ? { hasProcess: false } : null;
    let processState;
    if (workerData.method === 'running') {
      // F2 describes launch intent. Running status needs actual process evidence.
      processState = await readTargetRuntime({ connection, paneId: target.paneId, rawF2: {} });
    }
    await revalidateSessionTarget({ connection, target });
    if (workerData.method === 'running') {
      const scopeMatches = sessionMode === 'single'
        ? !Object.hasOwn(target.rawF2, 'ZYLOS_SESSION_GROUP')
        : target.rawF2.ZYLOS_SESSION_GROUP === sessionGroup;
      return {
        hasProcess: processState.runtimeObservation === 'present' ? true : processState.runtimeObservation === 'absent' ? false : null,
        identityVerified: Boolean(scopeMatches && target.runId &&
          (processState.runtimeObservation !== 'present' || processState.runtime === target.launchConfig?.runtime)),
        ready: target.ready, launchConfig: target.launchConfig, runId: target.runId,
      };
    }
    return { runId: target.runId, runtime: target.runtime,
      sessionGroup: target.rawF2.ZYLOS_SESSION_GROUP,
      currentSession: target.f3,
      tmuxTarget: { serverGeneration: target.serverGeneration, sessionId: target.tmuxSessionId, paneId: target.paneId } };
  } catch (error) {
    if (error.code === 'TMUX_NO_SERVER') return workerData.method === 'running' ? { hasProcess: false } : null;
    throw error;
  } finally { connection?.close(); }
}

const control = new Int32Array(workerData.shared, 0, 2);
const bytes = new Uint8Array(workerData.shared, 8);
let result;
try { result = { value: await observe() }; }
catch (error) { result = { error: { message: error.message, code: error.code ?? 'TARGET_SNAPSHOT_UNKNOWN', ...(typeof error.cause === 'string' ? { cause: error.cause } : {}) } }; }
let encoded = new TextEncoder().encode(JSON.stringify(result));
if (encoded.length > bytes.length) encoded = new TextEncoder().encode(JSON.stringify({ error: { message: 'Target observation exceeds size limit', code: 'TARGET_SNAPSHOT_UNKNOWN' } }));
bytes.set(encoded);
Atomics.store(control, 1, encoded.length);
Atomics.store(control, 0, 1);
Atomics.notify(control, 0);
