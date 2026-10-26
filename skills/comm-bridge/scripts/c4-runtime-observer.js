import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCoreConfigModule } from './core-config-loader.js';
import { isIdentityError, unavailableCommand } from './tmux-protocol.js';

let coreModules;
function loadCoreRuntime() {
  return coreModules ??= (async () => {
    const lib = path.dirname(resolveCoreConfigModule());
    return Promise.all([
      import(pathToFileURL(path.join(lib, 'runtime/tmux-connection.js')).href),
      import(pathToFileURL(path.join(lib, 'runtime/session-target.js')).href),
    ]);
  })().catch(error => {
    coreModules = undefined;
    throw error;
  });
}

// Private construction seam for isolated transports. Each observation owns one
// executor, pins one target, and uses guarded asynchronous command timeouts.
export function createCoreObserver({ tmux = {} } = {}) {
  async function observe(method, options) {
    const { sessionGroup = null, sessionMode } = options ?? {};
    if (!['single', 'multi'].includes(sessionMode)) throw Object.assign(new Error('Invalid session mode'), { code: 'INVALID_ARGS' });
    const [{ openTmuxConnection }, { observeSessionTarget, revalidateSessionTarget, readTargetRuntime }] = await loadCoreRuntime();
    let connection;
    try {
      connection = await openTmuxConnection(tmux);
      const target = await observeSessionTarget({ sessionGroup: sessionMode === 'single' ? null : sessionGroup, connection });
      if (!target.present) return method === 'running' ? { hasProcess: false } : null;
      let processState;
      if (method === 'running') {
        // F2 describes launch intent. Running status needs actual process evidence.
        processState = await readTargetRuntime({ connection, paneId: target.paneId, rawF2: {} });
      }
      await revalidateSessionTarget({ connection, target });
      if (method === 'running') {
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
      if (error.code === 'TMUX_NO_SERVER') return method === 'running' ? { hasProcess: false } : null;
      if (method === 'target' && isIdentityError(error)) {
        throw Object.assign(new Error('Target identity changed during observation'), {code:'TARGET_NOT_READY'});
      }
      if (error.code === 'TMUX_COMMAND_FAILED') {
        throw unavailableCommand(error, 'Cannot inspect tmux target');
      }
      throw error;
    } finally { await connection?.close(); }
  }
  return {
    observeCoreTarget: options => observe('target', options),
    observeCoreRunning: options => observe('running', options),
  };
}

const observer = createCoreObserver();
export const observeCoreTarget = options => observer.observeCoreTarget(options);
export const observeCoreRunning = options => observer.observeCoreRunning(options);
