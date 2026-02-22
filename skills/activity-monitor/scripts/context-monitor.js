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
const RESTART_THRESHOLD = 70;   // Trigger restart at this percentage
const COOLDOWN_SECONDS = 600;   // Don't re-trigger within 10 minutes

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
      fs.appendFileSync(
        path.join(AM_DIR, 'context-monitor.log'),
        `${new Date().toISOString()} ERROR: ${err.message} (input length: ${input.length}, preview: ${preview})\n`
      );
    } catch {}
  }
});

function main(raw) {
  if (!raw || !raw.trim()) return;

  // Parse status JSON
  const status = JSON.parse(raw);

  // Always write status file for external queries
  ensureDir(AM_DIR);
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));

  // Track session cost
  trackSessionCost(status);

  // Check context threshold
  const usedPct = status.context_window?.used_percentage;
  if (usedPct == null || usedPct < RESTART_THRESHOLD) return;

  // Check cooldown
  const now = Math.floor(Date.now() / 1000);
  const state = loadState();
  if (state && (now - state.last_trigger_at) < COOLDOWN_SECONDS) return;

  // Save state FIRST to prevent re-triggering
  saveState({
    ...state,
    last_trigger_at: now,
    used_percentage: usedPct,
  });

  // Enqueue new-session control message (non require-idle, priority 1)
  try {
    execFileSync('node', [C4_CONTROL, 'enqueue',
      '--content', `Context usage at ${usedPct}%, exceeding 70% threshold. Use the new-session skill to start a fresh session.`,
      '--priority', '1',
      '--ack-deadline', '600'
    ], { encoding: 'utf8', stdio: 'pipe' });

    log(`Triggered new-session: context at ${usedPct}%`);
  } catch (err) {
    log(`Failed to enqueue new-session: ${err.message}`);
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
  if (!sessionId) return;

  const state = loadState();

  // Session changed — log previous session's final cost
  if (state && state.session_id && state.session_id !== sessionId && state.last_cost != null) {
    const entry = {
      session_id: state.session_id,
      cost_usd: state.last_cost,
      ended_at: new Date().toISOString(),
      context_used_pct: state.used_percentage || null,
    };
    try {
      ensureDir(AM_DIR);
      fs.appendFileSync(COST_LOG_FILE, JSON.stringify(entry) + '\n');
      log(`Session cost logged: ${state.session_id} = $${state.last_cost}`);
    } catch (err) {
      log(`Failed to write cost log: ${err.message}`);
    }
  }

  // Update state with current session data
  saveState({
    ...state,
    session_id: sessionId,
    last_cost: costUsd ?? state?.last_cost,
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
  ensureDir(path.dirname(STATE_FILE));
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(msg) {
  try {
    const logFile = path.join(AM_DIR, 'context-monitor.log');
    ensureDir(path.dirname(logFile));
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}
