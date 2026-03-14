/**
 * codex-probe.js — HeartbeatEngine probe for OpenAI Codex CLI runtime.
 *
 * Implements the runtime-specific deps subset for HeartbeatEngine:
 *   enqueueHeartbeat, getHeartbeatStatus, detectRateLimit,
 *   readHeartbeatPending, clearHeartbeatPending
 *
 * Mechanism — dual-signal probe:
 *   1. Send "Heartbeat check." via tmux stdin injection.
 *   2. Record baseline: rollout JSONL mtime + tmux pane line count.
 *   3. On check: if EITHER signal changed since baseline → agent responded → 'done'.
 *      Neither changed within deadline → 'timeout' → HeartbeatEngine triggers recovery.
 *
 * Why dual-signal:
 *   - Rollout mtime alone: false alarm if Codex is idle (no new events = not stuck)
 *   - Tmux pane alone: rollout format changes could blind the health check
 *   - Together: independent signals make false positives near-impossible
 *
 * Usage:
 *   const probe = createCodexProbe({ pendingFile, tmuxSession, sqliteFile });
 *   // Merge with remaining HeartbeatEngine deps (killTmuxSession, etc.) in Phase 7.
 */

import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const CODEX_DIR = path.join(HOME, '.codex');
const DEFAULT_SQLITE = path.join(CODEX_DIR, 'state_5.sqlite');

/**
 * Create a Codex CLI heartbeat probe.
 *
 * @param {object} opts
 * @param {string}  opts.pendingFile       - Path to codex-heartbeat-pending.json
 * @param {string}  [opts.tmuxSession='codex-main']
 * @param {string}  [opts.sqliteFile]      - Path to state_5.sqlite (defaults to ~/.codex/state_5.sqlite)
 * @param {number}  [opts.ackDeadline=300]      - Response deadline for normal heartbeats (seconds)
 * @param {number}  [opts.stuckAckDeadline=120] - Response deadline for stuck-phase heartbeats
 * @returns {object} Partial HeartbeatEngine deps
 */
export function createCodexProbe({
  pendingFile,
  tmuxSession = 'codex-main',
  sqliteFile = DEFAULT_SQLITE,
  ackDeadline = 300,
  stuckAckDeadline = 120,
}) {
  // Record creation time so SQLite queries ignore threads from prior sessions.
  // Matches the start-time filter used in CodexContextMonitor._getActiveRolloutPath().
  const _startTime = Math.floor(Date.now() / 1000);

  return {

    // ── HeartbeatEngine probe deps ──────────────────────────────────────────

    /**
     * Send a heartbeat ping via tmux and record dual-signal baselines.
     *
     * Baselines captured:
     *   - rollout_path + rollout_mtime: active JSONL file modification time
     *   - pane_line_count: non-empty lines in tmux pane (detects any new output)
     *
     * @param {string} phase - 'normal' | 'stuck'
     * @returns {boolean}
     */
    enqueueHeartbeat(phase) {
      const probeId = Date.now();
      const deadline = phase === 'stuck' ? stuckAckDeadline : ackDeadline;

      // Capture rollout baseline before injecting (mtime changes only when agent writes)
      const rolloutPath = _getActiveRolloutPath(sqliteFile, _startTime);
      const rolloutMtime = rolloutPath ? _getMtime(rolloutPath) : 0;

      // Inject heartbeat message
      if (!_sendTmuxMessage(tmuxSession, 'Heartbeat check.')) return false;

      // Capture pane baseline AFTER injection so the injected line is already
      // included in the count — only subsequent output from the agent triggers 'done'.
      const paneContent = _captureTmuxPane(tmuxSession) || '';
      const paneLineCount = paneContent.split('\n').filter(l => l.trim()).length;

      return _writePending(pendingFile, {
        control_id: probeId,
        phase,
        created_at: Math.floor(Date.now() / 1000),
        deadline,
        rollout_path: rolloutPath,
        rollout_mtime_baseline: rolloutMtime,
        pane_line_count_baseline: paneLineCount,
      });
    },

    /**
     * Check if the Codex agent has responded since the probe was sent.
     * Returns 'done' if either signal changed; 'pending' while waiting;
     * 'timeout' after deadline.
     *
     * @param {number} probeId
     * @returns {string} 'done' | 'pending' | 'timeout' | 'error'
     */
    getHeartbeatStatus(probeId) {
      let pending;
      try {
        pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
        if (pending.control_id !== probeId) return 'error';
      } catch {
        return 'error';
      }

      const now = Math.floor(Date.now() / 1000);
      const age = now - (pending.created_at || 0);

      // Signal 1: rollout JSONL file has new entries
      if (pending.rollout_path) {
        const currentMtime = _getMtime(pending.rollout_path);
        if (currentMtime > pending.rollout_mtime_baseline) return 'done';
      }

      // Signal 2: tmux pane output changed since baseline.
      // Use !== (not >) because on a busy terminal the visible line count can
      // decrease as lines scroll off-screen — a decrease still means new output.
      const currentPane = _captureTmuxPane(tmuxSession) || '';
      const currentLineCount = currentPane.split('\n').filter(l => l.trim()).length;
      if (currentLineCount !== pending.pane_line_count_baseline) return 'done';

      // Check deadline
      if (age > (pending.deadline ?? ackDeadline)) return 'timeout';

      return 'pending';
    },

    /**
     * Codex CLI (OpenAI) does not have Anthropic-style per-plan usage limits.
     * Always returns not-detected.
     *
     * @returns {{ detected: false }}
     */
    detectRateLimit() {
      return { detected: false };
    },

    // ── Pending state management ─────────────────────────────────────────────

    /**
     * Read pending heartbeat state from disk.
     * @returns {object | null}
     */
    readHeartbeatPending() {
      try {
        return JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
      } catch {
        return null;
      }
    },

    /**
     * Clear the pending heartbeat state file.
     */
    clearHeartbeatPending() {
      try { fs.unlinkSync(pendingFile); } catch { /* already gone */ }
    },
  };
}

// ── Private helpers ──────────────────────────────────────────────────────────

function _captureTmuxPane(session) {
  try {
    return execSync(`tmux capture-pane -p -t "${session}" 2>/dev/null`, { encoding: 'utf8' });
  } catch {
    return null;
  }
}

/**
 * Send a message to a tmux session via buffer paste.
 * Reuses the same technique as CodexAdapter.sendMessage().
 *
 * @param {string} session
 * @param {string} text
 * @returns {boolean}
 */
function _sendTmuxMessage(session, text) {
  const id = `${Date.now()}-${process.pid}`;
  const bufName = `zylos-hb-${id}`;
  let tmpFile;
  try {
    tmpFile = path.join(os.tmpdir(), `zylos-hb-${id}.txt`);
    fs.writeFileSync(tmpFile, text);
    execSync(`tmux load-buffer -b "${bufName}" "${tmpFile}" 2>/dev/null`);
    execSync(`sleep 0.1`);
    execSync(`tmux paste-buffer -b "${bufName}" -t "${session}" 2>/dev/null`);
    execSync(`sleep 0.1`);
    execSync(`tmux send-keys -t "${session}" Enter 2>/dev/null`);
    return true;
  } catch {
    return false;
  } finally {
    try { if (tmpFile) fs.unlinkSync(tmpFile); } catch { }
    try { execSync(`tmux delete-buffer -b "${bufName}" 2>/dev/null`); } catch { }
  }
}

/**
 * Get the active Codex rollout JSONL path from SQLite threads table.
 *
 * Filters to threads updated after startTime (epoch seconds) so stale threads
 * from a previous session are never selected after a restart — matching the
 * same guard used in CodexContextMonitor._getActiveRolloutPath().
 *
 * @param {string} sqliteFile
 * @param {number} startTime - Epoch seconds; only threads updated at or after this are considered
 * @returns {string | null}
 */
function _getActiveRolloutPath(sqliteFile, startTime) {
  try {
    const sql = `SELECT rollout_path FROM threads
                 WHERE archived = 0
                   AND updated_at >= ${startTime}
                 ORDER BY updated_at DESC
                 LIMIT 1;`;
    const out = execFileSync('sqlite3', [sqliteFile, sql], {
      encoding: 'utf8', stdio: 'pipe', timeout: 5_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Get file modification time in seconds since epoch.
 * Returns 0 if the file doesn't exist or stat fails.
 * @param {string} filePath
 * @returns {number}
 */
function _getMtime(filePath) {
  try {
    return Math.floor(fs.statSync(filePath).mtimeMs / 1000);
  } catch {
    return 0;
  }
}

function _writePending(file, data) {
  try {
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
