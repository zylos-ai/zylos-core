/**
 * codex-probe.js — HeartbeatEngine probe for OpenAI Codex CLI runtime.
 *
 * Implements the runtime-specific deps subset for HeartbeatEngine:
 *   enqueueHeartbeat, getHeartbeatStatus, detectRateLimit, detectApiError,
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

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectApiErrorText } from './api-error-patterns.js';
import { tmuxCapturePaneText } from '../runtime/tmux-helpers.js';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const C4_CONTROL = path.join(ZYLOS_DIR, '.claude/skills/comm-bridge/scripts/c4-control.js');
const AUTH_FAILURE_PATTERNS = [
  /MCP client for [`'"]?codex_apps[`'"]? failed to start/i,
  /HTTP\s+401/i,
  /token_expired/i,
  /access token could not be refreshed/i,
  /refresh token was already used/i,
  /log out and sign in again/i,
  /authentication failed/i,
  /not logged in/i,
  /invalid api key/i,
  /unauthorized/i,
];

/**
 * Create a Codex CLI heartbeat probe.
 *
 * @param {object} opts
 * @param {string}  opts.pendingFile       - Path to codex-heartbeat-pending.json
 * @param {number}  [opts.ackDeadline=300]      - ACK deadline for normal heartbeats (seconds)
 * @param {number}  [opts.recoveryAckDeadline=120] - ACK deadline for recovery heartbeats
 * @returns {object} Partial HeartbeatEngine deps
 */
export function createCodexProbe({
  pendingFile,
  tmuxSession = 'codex-main',
  ackDeadline = 300,
  recoveryAckDeadline = 120,
}) {
  return {

    // ── HeartbeatEngine probe deps ──────────────────────────────────────────

    /**
     * Enqueue a heartbeat control message via C4 and record the pending state.
     * @param {string} phase
     * @returns {boolean}
     */
    enqueueHeartbeat(phase) {
      const deadline = _getAckDeadline(phase, { ackDeadline, recoveryAckDeadline });
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
     * Codex CLI (OpenAI) does not have Anthropic-style per-plan usage limits.
     * Always returns not-detected.
     *
     * @returns {{ detected: false }}
     */
    detectRateLimit() {
      return { detected: false };
    },

    /**
     * Detect auth-failure text in the Codex pane. HealthEngine verifies this
     * with the adapter's live checkAuth probe before changing health state.
     *
     * @returns {{ detected: boolean, pattern?: string }}
     */
    detectAuthFailure() {
      const pane = tmuxCapturePaneText(tmuxSession);
      if (!pane) return { detected: false };

      for (const p of AUTH_FAILURE_PATTERNS) {
        const match = pane.match(p);
        if (match) {
          return { detected: true, pattern: match[0] };
        }
      }
      return { detected: false };
    },

    /**
     * Detect fatal API/context errors in the Codex pane. Used by HealthEngine
     * to recover from sticky contexts such as oversized many-image requests.
     *
     * @returns {{ detected: boolean, pattern?: string }}
     */
    detectApiError() {
      const pane = tmuxCapturePaneText(tmuxSession);
      return detectApiErrorText(pane);
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

function _getAckDeadline(phase, { ackDeadline, recoveryAckDeadline }) {
  if (phase === 'recovery' || phase === 'post_restart') return recoveryAckDeadline;
  return ackDeadline;
}

// ── Private helpers ──────────────────────────────────────────────────────────

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
