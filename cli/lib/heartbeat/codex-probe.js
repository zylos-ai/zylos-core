/**
 * codex-probe.js — HeartbeatEngine probe for OpenAI Codex CLI runtime.
 *
 * Implements the runtime-specific deps subset for HeartbeatEngine:
 *   enqueueHeartbeat, getHeartbeatStatus, detectRateLimit,
 *   readHeartbeatPending, clearHeartbeatPending
 *
 * Mechanism — C4 control queue (same as Claude):
 *   - enqueueHeartbeat: enqueues a C4 control message with an ACK deadline.
 *     Codex's ACK (via c4-control.js ack --id <id>) marks it done.
 *   - getHeartbeatStatus: queries C4 control for the message status.
 *
 * This replaces the previous dual-signal tmux injection approach which caused
 * kill-restart loops (rollout_path null after restart) and disrupted user
 * conversations (Codex treated injected text as new prompts).
 *
 * C4 delivery flow:
 *   1. Probe enqueues heartbeat → control_queue in DB
 *   2. c4-dispatcher reads queue → delivers to Codex via tmux
 *   3. Codex processes heartbeat → executes ack command
 *   4. Probe checks C4 status → done/pending/timeout
 *
 * Auto-ack (optional, requires hooks):
 *   When Codex has UserPromptSubmit hooks writing api-activity.json,
 *   the dispatcher can auto-ack heartbeats while Codex is busy,
 *   avoiding unnecessary interruption.
 *
 * Usage:
 *   const probe = createCodexProbe({ pendingFile });
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const C4_CONTROL = path.join(ZYLOS_DIR, '.claude/skills/comm-bridge/scripts/c4-control.js');

/**
 * Create a Codex CLI heartbeat probe.
 *
 * @param {object} opts
 * @param {string}  opts.pendingFile       - Path to codex-heartbeat-pending.json
 * @param {number}  [opts.ackDeadline=300]      - ACK deadline for normal heartbeats (seconds)
 * @param {number}  [opts.stuckAckDeadline=120] - ACK deadline for stuck-phase heartbeats
 * @returns {object} Partial HeartbeatEngine deps
 */
export function createCodexProbe({
  pendingFile,
  tmuxSession = 'codex-main',
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
      const content = `Heartbeat check. [phase=${phase}]`;
      try {
        const out = execFileSync('node', [C4_CONTROL, 'enqueue',
          '--content', content,
          // Priority 0 = highest. Must not be lowered — heartbeat must jump
          // the queue ahead of conversation messages to avoid false timeout kills.
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
     * Detect OpenAI/Codex limit failures shown in the tmux pane.
     * This covers both temporary throttling (TPM/RPM) and harder quota/billing
     * failures that should not be reported to users as a generic "unhealthy".
     *
     * @returns {{ detected: boolean, cooldownUntil?: number, resetTime?: string, reason?: string, detail?: string }}
     */
    detectRateLimit() {
      const pane = _captureTmuxPane(tmuxSession, 10);
      if (!pane) return { detected: false };
      return detectCodexLimitFromPane(pane);
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

function _captureTmuxPane(session, lastLines = 0) {
  try {
    const startArg = lastLines > 0 ? `-S -${lastLines} ` : '';
    return execSync(`tmux capture-pane -p ${startArg}-t "${session}" 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
  } catch {
    return null;
  }
}

export function detectCodexLimitFromPane(pane) {
  if (!pane || typeof pane !== 'string') return { detected: false };

  // Confirmed pattern from Codex CLI (OpenAI):
  // "■ You've hit your usage limit. To get more access now, send a request to your admin or try again at Apr 2nd, 2026\n2:41 AM."
  // Require surrounding context (admin/try again) to avoid false positives from
  // conversation content that merely quotes/discusses the usage limit text.
  if (/you[''\u2019]ve hit your usage limit[\s\S]*?(?:send a request to your admin|try again)/i.test(pane)) {
    const now = Math.floor(Date.now() / 1000);
    const resetTime = _parseCodexResetTime(pane);
    const cooldownUntil = resetTime.epoch || (now + 3600);
    return {
      detected: true,
      cooldownUntil,
      resetTime: resetTime.display,
      reason: 'codex_usage_limit',
      detail: _extractRelevantLine(pane)
    };
  }

  return { detected: false };
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

function _extractRelevantLine(pane) {
  const lines = pane.split('\n').map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (/you['']ve hit your usage limit/i.test(line)) {
      return line.slice(0, 300);
    }
  }
  return '';
}

/**
 * Parse reset time from Codex usage limit message.
 * Format: "try again at Apr 2nd, 2026\n2:41 AM."
 * The date and time may span two lines in the tmux capture.
 */
function _parseCodexResetTime(pane) {
  // Match "try again at <date>\n<time>" across lines
  const match = pane.match(/try again at\s+([A-Z][a-z]{2}\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4})\s*\.?\s*\n?\s*(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
  if (!match) return { display: '', epoch: 0 };

  const dateStr = match[1].replace(/(\d{1,2})(?:st|nd|rd|th)/, '$1'); // "Apr 2, 2026"
  const timeStr = match[2].trim(); // "2:41 AM"
  const display = `${match[1]} ${timeStr}`;

  const parsed = new Date(`${dateStr} ${timeStr}`);
  const epoch = isNaN(parsed.getTime()) ? 0 : Math.floor(parsed.getTime() / 1000);

  return { display, epoch };
}
