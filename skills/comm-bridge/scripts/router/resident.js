import { loadCoreModule } from './core-modules.js';
const { LEGACY_TMUX_NAMES } = await loadCoreModule('session-group-paths.js');

/** Legacy observation has its own identity/state providers. It never reads the
 * new origin state and never treats a failed observation as confirmed absence. */
export function createLegacyMigration({ readLegacy, readLegacyStatus, sendExit, getSessionAdapter,
  readUpgradeMarker = async () => null, readUpgradeJournal = async () => null,
  diagnostic = () => {}, now = Date.now, idleSeconds = 3 }) {
  const startedAt = now();
  // The upgrade that started the router is the one whose active marker exists
  // when the legacy sessions are found. Without it only the deadline applies.
  let upgrade = null;
  async function findLegacySessions() {
    const result = [];
    for (const tmuxName of LEGACY_TMUX_NAMES) {
      try {
        const live = await readLegacy(tmuxName);
        if (live.present) result.push({ tmuxName, live, exitSent: false, stopped: false });
      } catch { result.push({ tmuxName, live: null, exitSent: false, stopped: false }); }
    }
    if (result.length) {
      try { upgrade = await readUpgradeMarker(); } catch { upgrade = null; }
    }
    return result;
  }
  /** Terminal cleanup removes the marker after its final journal write, so an
   * absent marker plus a completed journal means the upgrade command has no
   * recovery work left. Any unreadable record is treated as not finished. */
  async function upgradeFinished() {
    if (!upgrade) return false;
    try {
      if (await readUpgradeMarker() !== null) return false;
      const journal = await readUpgradeJournal(upgrade.transactionDir);
      return journal?.transactionId === upgrade.transactionId && journal.phase === 'upgrade_complete'
        && journal.cleanup?.complete === true;
    } catch { return false; }
  }
  async function advanceLegacy(entries) {
    const pending = entries.filter(entry => !entry.stopped);
    if (!pending.length) return;
    const finished = await upgradeFinished();
    // Each legacy target progresses independently from group scheduling.
    await Promise.all(pending.map(async entry => {
      try {
        const live = await readLegacy(entry.tmuxName); entry.live = live;
        if (!live.present) {
          entry.stopped = true;
          diagnostic('legacy_tmux_stopped', { tmuxName: entry.tmuxName, reason: entry.forced ? 'forced' : 'exited' }); return;
        }
        const exitTimedOut = entry.exitSent && now() - entry.exitSentAt >= 60000;
        let reason = exitTimedOut ? 'exit_timeout' : 'startup_timeout';
        // A Claude already sent /exit keeps its sixty seconds.
        const closeNow = finished && (live.runtime === 'codex' || live.runtime === 'claude' && !entry.exitSent);
        if (!exitTimedOut && now() - startedAt < 300000) {
          if (!closeNow) {
            if (!entry.exitSent) await sendExitWhenIdle(entry, live);
            return;
          }
          // After the upgrade an idle Claude still exits gracefully; a busy
          // Claude and Codex are stopped without waiting for the deadline.
          if (live.runtime === 'claude' && await sendExitWhenIdle(entry, live)) return;
          reason = 'upgrade_complete';
        }
        if (!['claude', 'codex'].includes(live.runtime)) {
          diagnostic('stop_unconfirmed', { tmuxName: entry.tmuxName, reason: 'runtime_unknown' }); return;
        }
        if (!entry.exitForcedLogged) {
          entry.exitForcedLogged = true;
          diagnostic('legacy_exit_forced', { tmuxName: entry.tmuxName, reason });
        }
        await getSessionAdapter(live.runtime).stop({ tmuxName: entry.tmuxName, expectedRunId: live.runId ?? null });
        entry.forced = true; entry.stopped = true;
        diagnostic('legacy_tmux_stopped', { tmuxName: entry.tmuxName, reason: 'forced' });
      } catch (error) { diagnostic('legacy_stop_unconfirmed', { tmuxName: entry.tmuxName, reason: error.code ?? error.message }); }
    }));
  }
  async function sendExitWhenIdle(entry, live) {
    const status = await readLegacyStatus(entry.tmuxName);
    if (status?.state !== 'idle' || !(status.idle_seconds >= idleSeconds)) return false;
    await sendExit(live); entry.exitSent = true; entry.exitSentAt = now();
    return true;
  }
  return { findLegacySessions, advanceLegacy };
}
