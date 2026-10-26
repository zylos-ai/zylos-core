import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { LEGACY_TMUX_NAMES } from '../../../../cli/lib/session-group-paths.js';

const exec = promisify(execFile);
export async function runningMaintenance({ execute = exec } = {}) {
  for (const pattern of ['[r]estart-claude', '[u]pgrade-claude', '[c]laude.ai/install.sh']) {
    try { await execute('pgrep', ['-f', pattern], { timeout: 500 }); return pattern; }
    catch (error) { if (error.code !== 1) throw error; }
  }
  return null;
}

/** Lifecycle cleanup is provided by the owner of the per-origin files, rather
 * than invoking the old machine-wide guardian reset during legacy migration. */
export function createSinglePreparation({ checkMaintenance = runningMaintenance, clearStaleState,
  resetToolLifecycle, buildInstructionFile, now = Date.now, sleep = delay, log = () => {} }) {
  for (const fn of [clearStaleState, resetToolLifecycle, buildInstructionFile]) {
    if (typeof fn !== 'function') throw new TypeError('Single preparation requires lifecycle and instruction providers');
  }
  return async function prepareSingle(runtime) {
    const started = now();
    while (await checkMaintenance()) {
      if (now() - started >= 300000) { log('Maintenance still active after 300 seconds; continuing startup'); break; }
      await sleep(Math.min(1000, 300000 - (now() - started)));
    }
    // These are best-effort cleanups, as in the guardian being replaced.
    try { await clearStaleState(runtime); } catch (error) { log(`Stale-state cleanup: ${error.message}`); }
    try { await resetToolLifecycle(runtime); } catch (error) { log(`Tool lifecycle reset: ${error.message}`); }
    await buildInstructionFile(runtime);
  };
}

/** Legacy observation has its own identity/state providers. It never reads the
 * new origin state and never treats a failed observation as confirmed absence. */
export function createLegacyMigration({ readLegacy, readLegacyStatus, sendExit, getSessionAdapter,
  diagnostic = () => {}, now = Date.now, idleSeconds = 3 }) {
  const startedAt = now();
  async function findLegacySessions() {
    const result = [];
    for (const tmuxName of LEGACY_TMUX_NAMES) {
      try {
        const live = await readLegacy(tmuxName);
        if (live.present) result.push({ tmuxName, live, exitSent: false, stopped: false });
      } catch { result.push({ tmuxName, live: null, exitSent: false, stopped: false }); }
    }
    return result;
  }
  async function advanceLegacy(entries) {
    // Each legacy target progresses independently from group scheduling.
    await Promise.all(entries.filter(entry => !entry.stopped).map(async entry => {
      try {
        const live = await readLegacy(entry.tmuxName); entry.live = live;
        if (!live.present) {
          entry.stopped = true;
          diagnostic('legacy_tmux_stopped', { tmuxName: entry.tmuxName, reason: entry.forced ? 'forced' : 'exited' }); return;
        }
        if (now() - startedAt < 300000) {
          if (!entry.exitSent) {
            const status = await readLegacyStatus(entry.tmuxName);
            if (status?.state === 'idle' && status.idle_seconds >= idleSeconds) {
              await sendExit(live); entry.exitSent = true;
            }
          }
          return;
        }
        if (!['claude', 'codex'].includes(live.runtime)) {
          diagnostic('stop_unconfirmed', { tmuxName: entry.tmuxName, reason: 'runtime_unknown' }); return;
        }
        await getSessionAdapter(live.runtime).stop({ tmuxName: entry.tmuxName, expectedRunId: live.runId ?? null });
        entry.forced = true; entry.stopped = true;
        diagnostic('legacy_tmux_stopped', { tmuxName: entry.tmuxName, reason: 'forced' });
      } catch (error) { diagnostic('legacy_stop_unconfirmed', { tmuxName: entry.tmuxName, reason: error.code ?? error.message }); }
    }));
  }
  return { findLegacySessions, advanceLegacy };
}
