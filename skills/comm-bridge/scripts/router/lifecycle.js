import { loadCoreModule } from './core-modules.js';
import fs from 'node:fs/promises';
import path from 'node:path';
const { legacyRunDir, RUN_FILES, zylosRoot } = await loadCoreModule('session-group-paths.js');
const { getSessionAdapter } = await loadCoreModule('runtime/index.js');
const { openTmuxConnection, tmuxError } = await loadCoreModule('runtime/tmux-connection.js');
const { observeSessionTarget } = await loadCoreModule('runtime/session-target.js');
import { createLegacyMigration } from './resident.js';

// Same identifier rule the upgrade uses for its transaction directories.
const UPGRADE_TRANSACTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;

export function createLifecycleProviders({ env = process.env, tmux = {}, now = Date.now,
  diagnostic = () => {},
  open = openTmuxConnection, observe = observeSessionTarget, readProcessTree,
  adapter = runtime => getSessionAdapter(runtime, { env, tmux }),
  readLegacyStatus: statusOverride,
} = {}) {
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
  // Upgrade records are read-only here; the upgrade owns their lifecycle.
  async function readRecord(file) {
    let handle;
    try {
      handle = await fs.open(file, 'r');
      if ((await handle.stat()).size > 1024 * 1024) throw new Error(`Upgrade record is too large: ${file}`);
      return JSON.parse(await handle.readFile('utf8'));
    } finally { await handle?.close(); }
  }
  async function readUpgradeMarker() {
    const root = await fs.realpath(zylosRoot(env));
    let marker;
    try { marker = await readRecord(path.join(root, '.zylos', 'upgrade', 'active.json')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const id = marker?.transactionId;
    if (marker?.formatVersion !== 1 || typeof id !== 'string' || !UPGRADE_TRANSACTION_ID.test(id)
      || marker.transactionDir !== path.join(root, '.backup', 'self-upgrade', id)) throw new Error('Invalid active upgrade marker');
    return { transactionId: id, transactionDir: marker.transactionDir };
  }
  const readUpgradeJournal = transactionDir => readRecord(path.join(transactionDir, 'journal.json'));
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
  return createLegacyMigration({ readLegacy, readLegacyStatus: statusOverride ?? readLegacyStatus,
    sendExit, getSessionAdapter: adapter, readUpgradeMarker, readUpgradeJournal, diagnostic, now });
}
