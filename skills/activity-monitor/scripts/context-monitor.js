#!/usr/bin/env node
/**
 * Context Monitor — statusLine handler for Claude Code
 *
 * Receives JSON from Claude Code's statusLine feature via stdin after every turn.
 * - Writes status to ~/zylos/activity-monitor/statusline.json for external queries
 * - Tracks session cost: logs final cost to cost-log.jsonl when session changes
 * - Triggers new-session handoff when context usage exceeds threshold
 *
 * Replaces the old polling-based check-context mechanism:
 * - Old: activity-monitor polls hourly → enqueues /context command (costs a turn) → parses output
 * - New: Claude writes status after every turn → this script reacts instantly, zero turn cost
 *
 * Configured in ~/zylos/.claude/settings.json:
 *   "statusLine": { "type": "command", "command": "node ~/zylos/.claude/skills/activity-monitor/scripts/context-monitor.js" }
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const AM_DIR = path.join(ZYLOS_DIR, 'activity-monitor');
const STATUS_FILE = path.join(AM_DIR, 'statusline.json');
const STATE_FILE = path.join(AM_DIR, 'context-monitor-state.json');
const COST_LOG_FILE = path.join(AM_DIR, 'cost-log.jsonl');
const C4_CONTROL = path.join(ZYLOS_DIR, '.claude/skills/comm-bridge/scripts/c4-control.js');

// Thresholds
const RESTART_THRESHOLD = 80;   // Trigger new-session at this percentage
const COOLDOWN_SECONDS = 300;   // Re-trigger after 5 minutes if still above threshold

// Early memory sync: inject at 80% of session-switch threshold so memory sync
// completes in the background before new-session fires.  (e.g. 80% × 0.8 = 64%)
const MEMORY_SYNC_RATIO = 0.8;
const MEMORY_SYNC_THRESHOLD = Math.round(RESTART_THRESHOLD * MEMORY_SYNC_RATIO);
const MEMORY_SYNC_COOLDOWN_SECONDS = 600;  // 10 min — only inject once per window

// Ensure data directory exists once at startup
let dirReady = false;
function ensureDirOnce() {
  if (dirReady) return;
  if (!fs.existsSync(AM_DIR)) fs.mkdirSync(AM_DIR, { recursive: true });
  dirReady = true;
}

// Read JSON from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    main(input);
  } catch (err) {
    // Silent failure — statusLine errors must not break Claude
    try {
      const preview = input.substring(0, 200).replace(/\n/g, '\\n');
      log(`ERROR: ${err.message} (input length: ${input.length}, preview: ${preview})`);
    } catch {}
  }
});

function main(raw) {
  if (!raw || !raw.trim()) return;

  // Parse status JSON
  const status = JSON.parse(raw);

  // Ensure data directory exists
  ensureDirOnce();

  // Always write status file for external queries
  atomicWrite(STATUS_FILE, JSON.stringify(status, null, 2));

  // Track session cost and context percentage
  trackSessionCost(status);

  // Check context percentage
  const usedPct = status.context_window?.used_percentage;
  if (usedPct == null) return;

  // Early memory sync injection: when usage reaches 80% of the session-switch
  // threshold, prompt Claude to run memory sync in the background.  By the time
  // the session switch fires, sync should already be done (or nearly done).
  if (usedPct >= MEMORY_SYNC_THRESHOLD && usedPct < RESTART_THRESHOLD) {
    maybeEnqueueMemorySync(usedPct);
    return;
  }

  // Session-switch threshold
  if (usedPct < RESTART_THRESHOLD) return;

  // Check cooldown
  const now = Math.floor(Date.now() / 1000);
  const state = loadState();
  if (state && (now - state.last_trigger_at) < COOLDOWN_SECONDS) return;

  // Enqueue new-session control message with bypass_state so dispatcher
  // delivers it even when health !== 'ok' (fixes #274: context rotation deadlock)
  const MAX_RETRIES = 3;
  let enqueued = false;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      execFileSync('node', [C4_CONTROL, 'enqueue',
        '--content', `Context usage at ${usedPct}%, exceeding ${RESTART_THRESHOLD}% threshold. Use the new-session skill to start a fresh session.`,
        '--priority', '1',
        '--bypass-state',
        '--no-ack-suffix'
      ], { encoding: 'utf8', stdio: 'pipe' });

      enqueued = true;
      log(`Triggered new-session: context at ${usedPct}%`);
      break;
    } catch (err) {
      log(`Failed to enqueue new-session (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
    }
  }

  // Only update cooldown after successful enqueue to avoid silent 5-min gap on failure
  if (enqueued) {
    saveState({
      ...state,
      last_trigger_at: now,
      used_percentage: usedPct,
    });
  }
}

/**
 * Enqueue early memory sync when context approaches the session-switch threshold.
 * Uses its own cooldown so it fires at most once per window.
 */
function maybeEnqueueMemorySync(usedPct) {
  const now = Math.floor(Date.now() / 1000);
  const state = loadState();
  if (state && state.last_memory_sync_trigger_at &&
      (now - state.last_memory_sync_trigger_at) < MEMORY_SYNC_COOLDOWN_SECONDS) {
    return;
  }

  const MAX_RETRIES = 3;
  let enqueued = false;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      execFileSync('node', [C4_CONTROL, 'enqueue',
        '--content', `Context usage at ${usedPct}% (approaching ${RESTART_THRESHOLD}% session-switch threshold). Run Memory Sync now as a background task so it completes before the session switch. Launch a background subagent for memory sync following ~/zylos/.claude/skills/zylos-memory/SKILL.md. Do NOT wait for completion — continue normal work.`,
        '--priority', '2',
        '--no-ack-suffix'
      ], { encoding: 'utf8', stdio: 'pipe' });

      enqueued = true;
      log(`Triggered early memory sync: context at ${usedPct}% (threshold: ${MEMORY_SYNC_THRESHOLD}%)`);
      break;
    } catch (err) {
      log(`Failed to enqueue memory sync (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
    }
  }

  if (enqueued) {
    saveState({
      ...state,
      last_memory_sync_trigger_at: now,
    });
  }
}

/**
 * Track session cost: detect session changes and log the previous session's final cost.
 * State file stores current session_id and last_cost; when session_id changes,
 * the previous session's cost is appended to cost-log.jsonl.
 */
function trackSessionCost(status) {
  const sessionId = status.session_id;
  const costUsd = status.cost?.total_cost_usd;
  const usedPct = status.context_window?.used_percentage;
  if (!sessionId) return;

  const state = loadState();

  // Session changed — log previous session's final cost
  if (state && state.session_id && state.session_id !== sessionId) {
    if (state.last_cost != null) {
      const entry = {
        session_id: state.session_id,
        cost_usd: state.last_cost,
        ended_at: new Date().toISOString(),
        context_used_pct: state.used_percentage ?? null,
      };
      try {
        fs.appendFileSync(COST_LOG_FILE, JSON.stringify(entry) + '\n');
        log(`Session cost logged: ${state.session_id} = $${state.last_cost}`);
      } catch (err) {
        log(`Failed to write cost log: ${err.message}`);
      }
    }

    // Reset cost for new session — don't carry over previous session's cost
    saveState({
      ...state,
      session_id: sessionId,
      last_cost: costUsd ?? null,
      used_percentage: usedPct ?? null,
      last_logged_session_id: state.session_id,
    });
    return;
  }

  // Same session — update cost and context percentage
  saveState({
    ...state,
    session_id: sessionId,
    last_cost: costUsd ?? state?.last_cost,
    used_percentage: usedPct ?? state?.used_percentage,
  });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(state) {
  ensureDirOnce();
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Atomic write: write to temp file then rename.
 * Prevents corruption from concurrent reads or interrupted writes.
 */
function atomicWrite(filePath, data) {
  const tmp = filePath + `.tmp.${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

function log(msg) {
  try {
    ensureDirOnce();
    const logFile = path.join(AM_DIR, 'context-monitor.log');
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}
