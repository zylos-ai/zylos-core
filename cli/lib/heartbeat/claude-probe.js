/**
 * claude-probe.js — HeartbeatEngine probe for Claude Code runtime.
 *
 * Implements the runtime-specific deps subset for HeartbeatEngine:
 *   enqueueHeartbeat, getHeartbeatStatus, detectRateLimit,
 *   readHeartbeatPending, clearHeartbeatPending
 *
 * Mechanism:
 *   - enqueueHeartbeat: enqueues a C4 control message with an ACK deadline.
 *     Claude Code's ACK (via c4-control.js ack --id <id>) marks it done.
 *   - getHeartbeatStatus: queries C4 control for the message status.
 *   - detectRateLimit: captures the tmux pane and matches Anthropic usage-limit UI patterns.
 *
 * Usage:
 *   const probe = createClaudeProbe({ pendingFile, tmuxSession });
 *   // Merge with remaining HeartbeatEngine deps (killTmuxSession, etc.) in Phase 7.
 */

import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const C4_CONTROL = path.join(ZYLOS_DIR, '.claude/skills/comm-bridge/scripts/c4-control.js');

const RATE_LIMIT_PATTERNS = [
  /out of extra usage/i,
  /you['']re out of .* usage/i,
  /usage limit reached/i,
  /you['']ve hit your limit/i,
];

/**
 * Create a Claude Code heartbeat probe.
 *
 * @param {object} opts
 * @param {string}  opts.pendingFile       - Path to heartbeat-pending.json
 * @param {string}  [opts.tmuxSession='claude-main']
 * @param {number}  [opts.ackDeadline=300]      - ACK deadline for normal heartbeats (seconds)
 * @param {number}  [opts.stuckAckDeadline=120] - ACK deadline for stuck-phase heartbeats
 * @returns {object} Partial HeartbeatEngine deps
 */
export function createClaudeProbe({
  pendingFile,
  tmuxSession = 'claude-main',
  ackDeadline = 300,
  stuckAckDeadline = 120,
}) {
  return {

    // ── HeartbeatEngine probe deps ──────────────────────────────────────────

    /**
     * Enqueue a heartbeat control message via C4 and record the pending state.
     * @param {string} phase - 'normal' | 'stuck'
     * @returns {boolean}
     */
    enqueueHeartbeat(phase) {
      const deadline = phase === 'stuck' ? stuckAckDeadline : ackDeadline;
      try {
        const out = execFileSync('node', [C4_CONTROL, 'enqueue',
          '--content', 'Heartbeat check.',
          '--priority', '0',
          '--bypass-state',
          '--ack-deadline', String(deadline),
        ], { encoding: 'utf8', stdio: 'pipe', timeout: 15_000 });

        const match = out.match(/control\s+(\d+)/i);
        if (!match) return false;

        const controlId = parseInt(match[1], 10);
        return _writePending(pendingFile, {
          control_id: controlId,
          phase,
          created_at: Math.floor(Date.now() / 1000),
        });
      } catch {
        return false;
      }
    },

    /**
     * Query C4 for the ACK status of a heartbeat control message.
     * @param {number} controlId
     * @returns {string} 'done' | 'pending' | 'timeout' | 'not_found' | 'error'
     */
    getHeartbeatStatus(controlId) {
      try {
        const out = execFileSync('node', [C4_CONTROL, 'get', '--id', String(controlId)], {
          encoding: 'utf8', stdio: 'pipe', timeout: 10_000,
        });
        const match = out.match(/status=([a-z_]+)/i);
        return match ? match[1].toLowerCase() : 'error';
      } catch (e) {
        if (e.stdout?.toLowerCase().includes('not found') ||
            e.message?.toLowerCase().includes('not found')) {
          return 'not_found';
        }
        return 'error';
      }
    },

    /**
     * Detect Claude Code usage-limit (rate-limit) UI prompts in the tmux pane.
     * Dual-signal: heartbeat failure must also occur before triggering recovery.
     *
     * @returns {{ detected: boolean, cooldownUntil?: number, resetTime?: string }}
     */
    detectRateLimit() {
      const pane = _captureTmuxPane(tmuxSession);
      if (!pane) return { detected: false };

      const detected = RATE_LIMIT_PATTERNS.some(p => p.test(pane));
      if (!detected) return { detected: false };

      let resetTime = '';
      const timeMatch = pane.match(/resets?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
      if (timeMatch) resetTime = timeMatch[1].trim();

      const now = Math.floor(Date.now() / 1000);
      let cooldownUntil = now + 3600; // default 1 hour
      if (resetTime) {
        const parsed = _parseResetTime(resetTime);
        if (parsed > now) cooldownUntil = parsed;
      }

      return { detected: true, cooldownUntil, resetTime };
    },

    // ── Pending state management ─────────────────────────────────────────────

    /**
     * Read pending heartbeat state from disk.
     * @returns {{ control_id: number, phase: string, created_at: number } | null}
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
 * Parse a time string like "7am", "7:30am", "3pm" into epoch seconds.
 * Assumes local timezone; if the time is in the past, assumes tomorrow.
 */
function _parseResetTime(timeStr) {
  const match = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!match) return 0;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2] || '0', 10);
  const ampm = match[3].toLowerCase();

  if (ampm === 'pm' && hours !== 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;

  const now = new Date();
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);

  return Math.floor(target.getTime() / 1000);
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
