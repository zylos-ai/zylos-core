import fs from 'node:fs/promises';
import path from 'node:path';
import { groupRunDir, legacyRunDir, RUN_FILES, zylosRoot } from '../../../../cli/lib/session-group-paths.js';
import { buildInstructionFile } from '../../../../cli/lib/runtime/instruction-builder.js';
import { getSessionAdapter } from '../../../../cli/lib/runtime/index.js';
import { openTmuxConnection, tmuxError } from '../../../../cli/lib/runtime/tmux-connection.js';
import { observeSessionTarget } from '../../../../cli/lib/runtime/session-target.js';
import { createSinglePreparation, createLegacyMigration } from './resident.js';

// Only stale derived samples and pre-existing lifecycle caches are reset.
// F3 remains until the startup hook replaces it; F6 history belongs to M4.
const lifecycleCaches = ['tool-event-stream-state.json', 'session-tool-state.json', 'foreground-session.json'];

export function createLifecycleProviders({ env = process.env, tmux = {}, now = Date.now,
  diagnostic = () => {}, log = () => {}, checkMaintenance, sleep,
  open = openTmuxConnection, observe = observeSessionTarget, readProcessTree,
  adapter = runtime => getSessionAdapter(runtime, { env, tmux }),
  buildInstructions = runtime => buildInstructionFile(runtime, { zylosDir: zylosRoot(env) }),
  readLegacyStatus: statusOverride,
} = {}) {
  const origin = groupRunDir('origin', env);
  async function removeOriginFiles(names) {
    // Attempt every cache independently, while retaining permission/I/O errors
    // for the best-effort preparation diagnostic.
    const results = await Promise.allSettled(names.map(name => fs.unlink(path.join(origin, name))));
    const failure = results.find(result => result.status === 'rejected' && result.reason.code !== 'ENOENT');
    if (failure) throw failure.reason;
  }
  const prepareSingle = createSinglePreparation({
    checkMaintenance, sleep, now, log,
    clearStaleState: () => removeOriginFiles([RUN_FILES.AGENT_STATUS, RUN_FILES.STATUSLINE]),
    resetToolLifecycle: () => removeOriginFiles(lifecycleCaches),
    buildInstructionFile: buildInstructions,
  });

  async function readLegacy(tmuxName) {
    let connection;
    try {
      connection = await open(tmux);
      return await observe({ tmuxName, connection, readReady: async () => null, readProcessTree });
    } catch (error) {
      if (error.code === 'TMUX_NO_SERVER') return { present: false, tmuxName };
      throw error;
    } finally { await connection?.close(); }
  }
  async function readLegacyStatus() {
    let handle;
    try {
      handle = await fs.open(path.join(legacyRunDir(env), RUN_FILES.AGENT_STATUS), 'r');
      const value = JSON.parse(await handle.readFile('utf8'));
      const stat = await handle.stat();
      if (now() - stat.mtimeMs > 5000) return null;
      return value && typeof value.state === 'string' && Number.isFinite(value.idle_seconds) ? value : null;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    } finally { await handle?.close(); }
  }
  async function sendExit(live) {
    if (!['claude', 'codex'].includes(live.runtime)) throw tmuxError('RUNTIME_UNSUPPORTED', 'Legacy runtime is unknown');
    let connection;
    try {
      connection = await open(tmux);
      // Legacy sessions have no runId; observe binds the object without the
      // READY requirement imposed by resolveSessionTarget on new sessions.
      const target = await observe({ tmuxName: live.tmuxName, connection, readReady: async () => null, readProcessTree });
      if (!target.present || ['serverGeneration', 'tmuxSessionId', 'paneId'].some(key => target[key] !== live[key])) {
        throw tmuxError('TARGET_GONE', 'Legacy target was replaced before exit');
      }
      if (target.runId !== live.runId || target.runtime !== live.runtime) throw tmuxError('RUNID_MISMATCH', 'Legacy runtime identity changed');
      const runtimeAdapter = adapter(target.runtime);
      await runtimeAdapter.sendText({ target, connection, text: '/exit' });
      await runtimeAdapter.sendKeys({ target, connection, keys: ['Enter'] });
    } finally { await connection?.close(); }
  }
  const migration = createLegacyMigration({ readLegacy, readLegacyStatus: statusOverride ?? readLegacyStatus,
    sendExit, getSessionAdapter: adapter, diagnostic, now });
  return { prepareSingle, ...migration };
}
