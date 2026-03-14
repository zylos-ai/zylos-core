#!/usr/bin/env node
/**
 * Activity Monitor v21 - RuntimeAdapter (multi-runtime) + Guardian + Heartbeat v4 + Health Check + Daily Tasks + Upgrade Check + Usage Monitor
 *
 * v21 changes (multi-runtime support — #311):
 *   - RuntimeAdapter abstraction: getActiveAdapter() reads runtime from config.json
 *   - Replaced startClaude/killTmuxSession/isClaudeRunning/sendToTmux/isClaudeLoggedIn
 *     with adapter.launch/stop/isRunning/sendMessage/checkAuth
 *   - HeartbeatEngine deps now merged from adapter.getHeartbeatDeps() (probe) + fixed deps
 *   - SESSION, CLAUDE_BIN, and all Claude-specific inline logic removed from this file
 *   - monitorLoop is now async (await adapter.isRunning() each tick)
 *
 * v20 changes (behavioral rate limit detection — #256):
 *   - Rate-limit detection moved from proactive tmux scan to heartbeat failure callback
 *   - Dual-signal: heartbeat must fail (behavioral) AND tmux must show rate-limit text
 *   - Eliminates false positives from conversation content containing "rate limit"
 *   - Removed overly broad /rate limit/i pattern
 *
 * v19 changes (RATE_LIMITED state + user message triggered recovery — #233):
 *   - New RATE_LIMITED health state: no kill+restart, waits for cooldown
 *   - Parse reset time from rate-limit prompt (e.g., "resets 7am")
 *   - User message triggered recovery: incoming message during rate_limited
 *     clears cooldown timer (5min cooldown between triggers)
 *   - Channel bot messaging: shows "I've hit my usage limit" with reset time
 *
 * v18 changes (exponential backoff + process signal acceleration — #177):
 *   - Exponential backoff: min(3600, 60 × 5^(n-1)) → 1m, 5m, 25m, 60m cap
 *   - Infinite retries in recovering state (no max restart failures limit)
 *   - DOWN degradation: after 1 hour of continuous failure (configurable)
 *   - DOWN retry interval: 60 min (up from 30 min)
 *   - Process signal acceleration: agentRunning false→true + 30s grace → immediate probe
 *
 * v17 changes (plan usage monitoring — #206):
 *   - Add usage monitoring: periodically checks /usage via tmux capture during idle
 *   - State machine: idle → sent → waiting → capture → idle
 *   - Parses session, weekly (all models), weekly (Sonnet) percentages
 *   - Threshold notifications: 70% warning, 85% high, 95% critical
 *   - Only checks during active hours (8–23) when Claude is idle ≥30s and C4 queue empty
 *   - Persists usage data to ~/zylos/activity-monitor/usage.json
 *   - 2-hour notification cooldown per tier, escalation bypasses cooldown
 *
 * v16 changes (prefer credentials.json over .env OAUTH_TOKEN — fixes #211):
 *   - Add hasCredentialsFile(): checks ~/.claude/.credentials.json for OAuth refresh token
 *   - startClaude(): skip .env OAUTH_TOKEN injection when credentials.json is available
 *   - isClaudeLoggedIn(): check credentials.json first, before falling back to .env
 *   - Prevents 401 errors caused by expired static tokens overriding auto-refreshable ones
 *
 * v15 changes (Intl.DateTimeFormat memory leak fix):
 *   - Hoist Intl.DateTimeFormat instances to module level (reuse instead of per-call new)
 *   - Fixes unbounded native memory growth (~18 MB / 1000 calls) from V8/ICU leak
 *
 * v14 changes (env cleanup + backoff + exit logging + PATH fix):
 *   - Pass PATH to tmux session via -e flag (tmux server may not inherit caller's PATH)
 *   - Strip CLAUDECODE/CLAUDE_CODE_ENTRYPOINT env vars before starting Claude in tmux
 *     (prevents "already running" detection when PM2 inherits Claude's env)
 *   - Fix startupGrace bypass: grace period now checked in offline branch too
 *   - Add exponential backoff for restart retries (5s → 10s → 20s → 40s → 60s cap)
 *   - Log Claude exit codes to claude-exit.log for post-mortem debugging
 *   - Critical guardian events now also written to stdout (visible in PM2 logs)
 *
 * v13 changes (statusLine-based context monitoring):
 *   - Removed periodic context polling (enqueueContextCheck)
 *   - Context monitoring now handled by statusLine hook + context-monitor.js
 *   - Event-driven: zero turn cost, triggers only when threshold hit
 *
 * v11 changes (Hook-based activity tracking):
 *   - Replaced non-functional fetch-preload with Claude Code hooks
 *   - hook-activity.js writes api-activity.json on tool/stop/idle events
 *   - Stuck detection: triggers immediate probe when no activity for STUCK_THRESHOLD
 *   - Removed verify phase: single heartbeat failure → recovery
 *   - Safety-net heartbeat interval relaxed to 2 hours
 *
 * Run with PM2: pm2 start activity-monitor.js --name activity-monitor
 */

import { execSync, execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { HeartbeatEngine } from './heartbeat-engine.js';
import { DailySchedule } from './daily-schedule.js';
// activity-monitor runs as a deployed skill at ~/zylos/.claude/skills/activity-monitor/scripts/.
// A relative import to cli/lib/runtime/ resolves correctly in the repo (dev) but NOT from
// the deployed path — the CLI lives in the globally installed zylos npm package.
// ZYLOS_PACKAGE_ROOT is set by the PM2 ecosystem config to the installed package root.
// Dev fallback: 3 levels up from skills/activity-monitor/scripts/ = repo root (checked explicitly).
const _runtimeIndexPath = (() => {
  if (process.env.ZYLOS_PACKAGE_ROOT) {
    return path.join(process.env.ZYLOS_PACKAGE_ROOT, 'cli', 'lib', 'runtime', 'index.js');
  }
  const devPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname), '../../../cli/lib/runtime/index.js'
  );
  if (fs.existsSync(devPath)) return devPath;
  throw new Error(
    '[activity-monitor] Cannot locate cli/lib/runtime/index.js. ' +
    'Ensure ZYLOS_PACKAGE_ROOT is set in the PM2 ecosystem config.'
  );
})();
const { getActiveAdapter } = await import(_runtimeIndexPath);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Core runtime config
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const MONITOR_DIR = path.join(ZYLOS_DIR, 'activity-monitor');
const STATUS_FILE = path.join(MONITOR_DIR, 'agent-status.json');
const LOG_FILE = path.join(MONITOR_DIR, 'activity.log');
const HEALTH_CHECK_STATE_FILE = path.join(MONITOR_DIR, 'health-check-state.json');
const DAILY_UPGRADE_STATE_FILE = path.join(MONITOR_DIR, 'daily-upgrade-state.json');
const DAILY_MEMORY_COMMIT_STATE_FILE = path.join(MONITOR_DIR, 'daily-memory-commit-state.json');
const UPGRADE_CHECK_STATE_FILE = path.join(MONITOR_DIR, 'upgrade-check-state.json');
const PENDING_CHANNELS_FILE = path.join(MONITOR_DIR, 'pending-channels.jsonl');
const USER_MESSAGE_SIGNAL_FILE = path.join(MONITOR_DIR, 'user-message-signal.json');
const USAGE_STATE_FILE = path.join(MONITOR_DIR, 'usage.json');

// API activity file — written by hook-activity.js (Claude Code hooks)
const API_ACTIVITY_FILE = path.join(MONITOR_DIR, 'api-activity.json');
const HOOK_STATE_FILE = path.join(MONITOR_DIR, 'hook-state.json');

// Conversation directory - auto-detect based on working directory
const ZYLOS_PATH = ZYLOS_DIR.replace(/\//g, '-');
const CONV_DIR = path.join(os.homedir(), '.claude', 'projects', ZYLOS_PATH);

// Activity monitor cadence
const INTERVAL = 1000;
const IDLE_THRESHOLD = 3;
const LOG_MAX_LINES = 500;
const BASE_RESTART_DELAY = 5;
const MAX_RESTART_DELAY = 60;
const BACKOFF_RESET_THRESHOLD = 60; // Claude must stay running this long before backoff resets

// Heartbeat liveness config (v3)
const HEARTBEAT_INTERVAL = 7200;     // 2 hours (safety-net; stuck detection is the primary mechanism)
const DOWN_DEGRADE_THRESHOLD = 3600; // 1 hour of continuous failure → enter DOWN
const DOWN_RETRY_INTERVAL = 3600;    // 60 min periodic retry in DOWN state
const SIGNAL_GRACE_PERIOD = 30;      // Wait 30s after agentRunning transitions before probing
const RATE_LIMIT_DEFAULT_COOLDOWN = 3600;  // 1 hour default when reset time can't be parsed
const USER_MESSAGE_RECOVERY_COOLDOWN = 60; // 1 min between user-message-triggered recoveries

// Stuck detection config
const STUCK_THRESHOLD = 300;         // 5 min of no activity → trigger immediate probe
const STUCK_PROBE_COOLDOWN = 600;    // 10 min between stuck probes

// Health check config
const HEALTH_CHECK_INTERVAL = 21600; // 6 hours

// Usage monitoring config — configurable via zylos config (config.json), with sensible defaults.
// Example: zylos config set usage_warn_threshold 60
const CONFIG_DIR = path.join(ZYLOS_DIR, '.zylos');

function readConfigInt(key, fallback) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8'));
    const val = config[key];
    if (val !== undefined && val !== null) {
      const n = parseInt(String(val), 10);
      if (!Number.isNaN(n)) return n;
    }
  } catch { }
  return fallback;
}

const USAGE_CHECK_INTERVAL = readConfigInt('usage_check_interval', 3600);     // seconds between checks (default 1 hour)
const USAGE_IDLE_GATE = readConfigInt('usage_idle_gate', 30);                 // idle seconds required (default 30)
const USAGE_CAPTURE_WAIT = readConfigInt('usage_capture_wait', 5);            // seconds to wait for UI render
const USAGE_WARN_THRESHOLD = readConfigInt('usage_warn_threshold', 80);       // weekly % → warning
const USAGE_HIGH_THRESHOLD = readConfigInt('usage_high_threshold', 90);       // weekly % → high alert
const USAGE_CRITICAL_THRESHOLD = readConfigInt('usage_critical_threshold', 95); // weekly % → critical alert
const USAGE_NOTIFY_COOLDOWN = readConfigInt('usage_notify_cooldown', 14400);  // seconds between same-tier notifications (4 hours)
const USAGE_ACTIVE_HOURS_START = readConfigInt('usage_active_hours_start', 8); // check only during 8:00–23:00
const USAGE_ACTIVE_HOURS_END = readConfigInt('usage_active_hours_end', 23);

// Daily tasks config
const DAILY_UPGRADE_HOUR = 5;        // 5:00 AM local time
const DAILY_MEMORY_COMMIT_HOUR = 3;  // 3:00 AM local time
const DAILY_UPGRADE_CHECK_HOUR = 6;  // 6:00 AM local time
const DAILY_COMMIT_SCRIPT = path.join(__dirname, '..', '..', 'zylos-memory', 'scripts', 'daily-commit.js');

// State
let lastTruncateDay = '';
let notRunningCount = 0;
let consecutiveRestarts = 0;
let stableRunningSince = 0;
let lastState = '';
let startupGrace = 0;
let idleSince = 0;
let lastStuckProbeAt = 0;
let lastDeadApiPid = null;

let adapter;         // initialized in init() via getActiveAdapter()
let engine;          // initialized in init()
let contextMonitor;  // initialized in init() if adapter provides one (Codex only)

// Usage monitoring state machine: 'idle' → 'sent' → 'waiting' → 'capture' → 'idle'
let usageCheckPhase = 'idle';
let usageCheckWaitCount = 0;
let lastUsageCheckAt = 0;

// Timezone: reuse scheduler's tz.js (.env TZ → process.env.TZ → UTC)
import { loadTimezone } from '../../scheduler/scripts/tz.js';

const timezone = loadTimezone();

// Reuse Intl.DateTimeFormat instances — creating new ones per call leaks native
// ICU memory that V8's GC never reclaims, causing unbounded RSS growth (~18 MB
// per 1 000 instantiations).
const hourFormatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false });
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone });

function getLocalHour() {
  return parseInt(hourFormatter.format(new Date()), 10);
}

function getLocalDate() {
  return dateFormatter.format(new Date());
}

function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `[${timestamp}] ${message}`;
  if (!fs.existsSync(MONITOR_DIR)) {
    fs.mkdirSync(MONITOR_DIR, { recursive: true });
  }
  fs.appendFileSync(LOG_FILE, line + '\n');
  // Critical events also to stdout (visible in PM2 logs)
  if (/^(Guardian|Heartbeat|State:|=== Activity)/.test(message)) {
    console.log(line);
  }
}

function truncateLog() {
  if (!fs.existsSync(LOG_FILE)) return;
  const content = fs.readFileSync(LOG_FILE, 'utf8');
  const lines = content.split('\n');
  if (lines.length > LOG_MAX_LINES) {
    fs.writeFileSync(LOG_FILE, lines.slice(-LOG_MAX_LINES).join('\n'));
    log(`Log truncated to ${LOG_MAX_LINES} lines`);
  }
}

function checkDailyTruncate() {
  const today = new Date().toISOString().substring(0, 10);
  if (today !== lastTruncateDay) {
    truncateLog();
    lastTruncateDay = today;
  }
}

function runCommand(cmd, silent = false) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: silent ? 'pipe' : 'inherit' }).trim();
  } catch {
    return null;
  }
}

function resolveCommBridgeScript(fileName) {
  const prodPath = path.join(ZYLOS_DIR, '.claude', 'skills', 'comm-bridge', 'scripts', fileName);
  if (fs.existsSync(prodPath)) {
    return prodPath;
  }

  const devPath = path.join(__dirname, '..', '..', 'comm-bridge', 'scripts', fileName);
  if (fs.existsSync(devPath)) {
    return devPath;
  }

  return prodPath;
}

const C4_CONTROL_PATH = resolveCommBridgeScript('c4-control.js');
const C4_SEND_PATH = resolveCommBridgeScript('c4-send.js');

function tmuxHasSession() {
  try {
    execSync(`tmux has-session -t "${adapter.sessionName}" 2>/dev/null`, { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

// TODO: Add Codex-specific maintenance process detection when Codex maintenance
// scripts exist (e.g. restart-codex, upgrade-codex). Currently only Claude
// maintenance scripts are detected; Codex maintenance runs would not be guarded.
function getRunningMaintenance() {
  try {
    execSync('pgrep -f "[r]estart-claude" > /dev/null 2>&1');
    return 'restart-claude';
  } catch { }

  try {
    execSync('pgrep -f "[u]pgrade-claude" > /dev/null 2>&1');
    return 'upgrade-claude';
  } catch { }

  try {
    execSync('pgrep -f "[c]laude.ai/install.sh" > /dev/null 2>&1');
    return 'upgrade (curl install.sh)';
  } catch { }

  return null;
}

function isMaintenanceRunning() {
  return getRunningMaintenance() !== null;
}

function waitForMaintenance() {
  const maxWait = 300;
  let waited = 0;
  let scriptName = getRunningMaintenance();
  if (!scriptName) return;

  log(`Guardian: Detected ${scriptName} running, waiting for completion...`);
  while (true) {
    scriptName = getRunningMaintenance();
    if (!scriptName) break;

    if (waited >= maxWait) {
      log(`Guardian: Warning - ${scriptName} still running after ${maxWait}s, proceeding anyway`);
      break;
    }

    if (waited > 0 && waited % 30 === 0) {
      log(`Guardian: Still waiting for ${scriptName}... (${waited}s)`);
    }

    execSync('sleep 1');
    waited += 1;
  }

  if (waited > 0 && waited < maxWait) {
    log(`Guardian: maintenance completed after ${waited}s`);
  }
}

// Startup prompt: prefer session start hook (session-start-prompt.js) which
// injects directly into session context. Fall back to C4 control for existing
// installations that haven't received the new hook via `zylos init`.
// Non-Claude runtimes don't use Claude settings.json hooks — always fall back to C4.
function hasStartupHook() {
  if (adapter.runtimeId !== 'claude') return false;
  try {
    const settingsPath = path.join(ZYLOS_DIR, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const matchers = settings?.hooks?.SessionStart;
    if (!Array.isArray(matchers)) return false;
    return matchers.some(m =>
      Array.isArray(m?.hooks) && m.hooks.some(
        h => h?.type === 'command' && typeof h.command === 'string'
          && /(?:^|[\\/])session-start-prompt\.js(?:["'\s]|$)/.test(h.command)
      )
    );
  } catch {
    return false;
  }
}

function enqueueStartupControl() {
  const content = 'reply to your human partner if they are waiting your reply, and continue your work if you have ongoing task according to the previous conversations.';
  const result = runC4Control([
    'enqueue',
    '--content', content,
    '--priority', '3',
    '--require-idle',
    '--available-in', '3',
    '--ack-deadline', '600'
  ]);
  if (result.ok) {
    const match = result.output.match(/control\s+(\d+)/i);
    log(`Startup control enqueued (fallback) id=${match?.[1] ?? '?'}`);
  } else {
    log(`Startup control enqueue failed (fallback): ${result.output}`);
  }
}

/**
 * Start the active runtime agent.
 * Clears stale state files, delegates launch to the RuntimeAdapter,
 * then enqueues the startup control prompt if no session-start hook is installed.
 */
async function startAgent() {
  if (isMaintenanceRunning()) {
    log('Guardian: Maintenance script detected, waiting for completion...');
    waitForMaintenance();
  }

  // Skip startup if not authenticated — avoids interactive login prompts in tmux
  const authResult = adapter.checkAuth ? await adapter.checkAuth() : { ok: true };
  if (!authResult.ok) {
    log(`Guardian: ${adapter.displayName} not authenticated (${authResult.reason ?? 'unknown'}), skipping startup`);
    return;
  }

  log(`Guardian: Starting ${adapter.displayName}...`);

  // Clear stale context temp files from a previous session
  try { fs.unlinkSync('/tmp/context-alert-cooldown'); } catch { }
  try { fs.unlinkSync('/tmp/context-compact-scheduled'); } catch { }

  // Reset hook activity state — prevents stale data causing false busy detection
  try {
    fs.writeFileSync(API_ACTIVITY_FILE, JSON.stringify({ version: 2, active: false, active_tools: 0, updated_at: Date.now() }));
    fs.writeFileSync(HOOK_STATE_FILE, JSON.stringify({ active_tools: 0 }));
  } catch { }

  // Fire-and-forget: launch() is intentionally not awaited. The monitor loop
  // must not block for the full startup duration (several seconds for the agent
  // to become interactive). startupGrace prevents re-entry for the next 30 ticks.
  adapter.launch().catch(err => {
    log(`Guardian: Failed to start ${adapter.displayName}: ${err.message}`);
  });

  // Enqueue startup prompt (fires with --available-in 3 delay — no need to
  // wait for launch to complete before enqueueing).
  if (!hasStartupHook()) {
    enqueueStartupControl();
  }
}

function ensureStatusDir() {
  if (!fs.existsSync(MONITOR_DIR)) {
    fs.mkdirSync(MONITOR_DIR, { recursive: true });
  }
}

function loadInitialHealth() {
  try {
    if (!fs.existsSync(STATUS_FILE)) return { health: 'ok' };
    const status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    if (status && typeof status.health === 'string') {
      return status;
    }
  } catch { }
  return { health: 'ok' };
}

function writeStatusFile(statusObj) {
  try {
    ensureStatusDir();
    const extra = {};
    if (engine.health === 'rate_limited') {
      extra.rate_limit_reset = engine.rateLimitResetTime || null;
      extra.cooldown_until = engine.cooldownUntil || null;
    }
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...statusObj, ...extra, health: engine.health }, null, 2));
  } catch {
    // Best-effort.
  }
}

function getConversationFileModTime() {
  try {
    const files = fs.readdirSync(CONV_DIR)
      .filter(f => f.endsWith('.jsonl') && !f.includes('agent-'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(CONV_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > 0) {
      return Math.floor(files[0].mtime / 1000);
    }
  } catch { }
  return null;
}

function getTmuxActivity() {
  try {
    const output = execSync(`tmux list-windows -t "${adapter.sessionName}" -F '#{window_activity}' 2>/dev/null`, { encoding: 'utf8' });
    return parseInt(output.trim(), 10);
  } catch {
    return null;
  }
}

function runC4Control(args) {
  try {
    const output = execFileSync('node', [C4_CONTROL_PATH, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
    return { ok: true, output };
  } catch (err) {
    const stdout = err.stdout ? String(err.stdout).trim() : '';
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    return { ok: false, output: stdout || stderr || err.message };
  }
}

function readApiActivity() {
  try {
    if (!fs.existsSync(API_ACTIVITY_FILE)) return null;
    const activity = JSON.parse(fs.readFileSync(API_ACTIVITY_FILE, 'utf8'));
    const pid = Number(activity?.pid);

    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
      } catch (err) {
        if (err?.code !== 'EPERM') {
          if (lastDeadApiPid !== pid) {
            log(`Hook activity ignored: stale pid ${pid} not running (${API_ACTIVITY_FILE})`);
          }
          lastDeadApiPid = pid;
          return null;
        }
      }

      if (lastDeadApiPid === pid) {
        lastDeadApiPid = null;
      }
    }

    return activity;
  } catch {
    return null;
  }
}

function sendRecoveryNotice(channel, endpoint) {
  try {
    execFileSync('node', [C4_SEND_PATH, channel, endpoint, 'Hey! I was temporarily unavailable but I\'m back online now. If you sent me something while I was away, could you send it again? Thanks!'], { stdio: 'pipe' });
    return true;
  } catch (err) {
    log(`Recovery notice failed for ${channel}:${endpoint} (${err.message})`);
    return false;
  }
}

/**
 * Query the C4 database for the most recently active user channel.
 * Returns { channel, endpoint } with the msg: component stripped so the
 * result can be used for proactive (non-reply) sends.
 *
 * @returns {{ channel: string, endpoint: string } | null}
 */
async function getLastActiveChannel() {
  try {
    const dbPath = path.join(ZYLOS_DIR, 'comm-bridge', 'c4.db');
    // Use better-sqlite3 (JS layer) — avoids dependency on the sqlite3 system CLI,
    // which may be absent in some Docker environments.
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare(
        "SELECT channel, endpoint_id FROM conversations WHERE direction='in' ORDER BY id DESC LIMIT 1"
      ).get();
      if (!row) return null;
      // Strip msg:... and req:... so we send a new standalone message, not a thread reply.
      // Matches c4-receive.js normalisation: /\|(msg|req):[^|]+/g
      const endpoint = row.endpoint_id.replace(/\|(msg|req):[^|]+/g, '');
      return row.channel && endpoint ? { channel: row.channel, endpoint } : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function notifyPendingChannels() {
  if (!fs.existsSync(PENDING_CHANNELS_FILE)) {
    return;
  }

  const dedup = new Map();
  try {
    const lines = fs.readFileSync(PENDING_CHANNELS_FILE, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (!record.channel || !record.endpoint) continue;
        dedup.set(`${record.channel}::${record.endpoint}`, record);
      } catch {
        // Ignore malformed line.
      }
    }
  } catch (err) {
    log(`Pending channel load failed: ${err.message}`);
    return;
  }

  const failed = [];
  for (const record of dedup.values()) {
    const ok = sendRecoveryNotice(record.channel, record.endpoint);
    if (!ok) failed.push(record);
  }

  // Only clear successfully sent notifications; re-queue failed ones
  try {
    if (failed.length > 0) {
      const remaining = failed.map(r => JSON.stringify(r)).join('\n') + '\n';
      fs.writeFileSync(PENDING_CHANNELS_FILE, remaining);
    } else {
      fs.writeFileSync(PENDING_CHANNELS_FILE, '');
    }
  } catch (err) {
    log(`Pending channel cleanup failed: ${err.message}`);
  }

  log(`Recovery notification: ${dedup.size - failed.length} sent, ${failed.length} failed`);
}

// --- Health Check ---

function loadHealthCheckState() {
  try {
    if (!fs.existsSync(HEALTH_CHECK_STATE_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(HEALTH_CHECK_STATE_FILE, 'utf8'));
    if (parsed && typeof parsed.last_check_at === 'number') {
      return parsed;
    }
  } catch { }
  return null;
}

function writeHealthCheckState(lastCheckAt) {
  try {
    if (!fs.existsSync(MONITOR_DIR)) {
      fs.mkdirSync(MONITOR_DIR, { recursive: true });
    }
    fs.writeFileSync(HEALTH_CHECK_STATE_FILE, JSON.stringify({
      last_check_at: lastCheckAt,
      last_check_human: new Date(lastCheckAt * 1000).toISOString().replace('T', ' ').substring(0, 19)
    }, null, 2));
  } catch (err) {
    log(`Health check: failed to write state (${err.message})`);
  }
}

function enqueueHealthCheck() {
  const content = [
    'System health check. Check PM2 services (pm2 jlist), disk space (df -h), and memory (free -m).',
    'If any issues found, use your judgment to notify whoever is most likely to help — check your memory for a designated owner or ops person, otherwise pick the person you normally work with.',
    'Log results to ~/zylos/logs/health.log.'
  ].join(' ');

  const result = runC4Control([
    'enqueue',
    '--content', content,
    '--priority', '3',
    '--ack-deadline', '600'
  ]);

  if (!result.ok) {
    log(`Health check enqueue failed: ${result.output}`);
    return false;
  }

  const match = result.output.match(/control\s+(\d+)/i);
  if (!match) {
    log(`Health check enqueue parse failed: ${result.output}`);
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  writeHealthCheckState(now);
  log(`Health check enqueued id=${match[1]}`);
  return true;
}

function maybeEnqueueHealthCheck(agentRunning, currentTime) {
  if (!agentRunning) return;
  if (engine.health !== 'ok') return;

  const state = loadHealthCheckState();
  const lastCheckAt = state?.last_check_at ?? 0;

  if ((currentTime - lastCheckAt) >= HEALTH_CHECK_INTERVAL) {
    enqueueHealthCheck();
  }
}

// ---------------------------------------------------------------------------
// Daily Upgrade
// ---------------------------------------------------------------------------

function loadDailyUpgradeState() {
  try {
    if (!fs.existsSync(DAILY_UPGRADE_STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(DAILY_UPGRADE_STATE_FILE, 'utf8'));
  } catch { }
  return null;
}

function writeDailyUpgradeState(date) {
  try {
    if (!fs.existsSync(MONITOR_DIR)) {
      fs.mkdirSync(MONITOR_DIR, { recursive: true });
    }
    fs.writeFileSync(DAILY_UPGRADE_STATE_FILE, JSON.stringify({
      last_date: date,
      updated_at: new Date().toISOString()
    }, null, 2));
  } catch (err) {
    log(`Daily upgrade: failed to write state (${err.message})`);
  }
}

function enqueueDailyUpgradeControl() {
  // Only applicable for Claude Code runtime — no equivalent upgrade skill for other runtimes.
  if (adapter.runtimeId !== 'claude') return false;
  const content = 'Daily upgrade. Use the upgrade-claude skill to upgrade Claude Code to the latest version.';
  const result = runC4Control([
    'enqueue',
    '--content', content,
    '--priority', '3',
    '--ack-deadline', '600'
  ]);

  if (!result.ok) {
    log(`Daily upgrade enqueue failed: ${result.output}`);
    return false;
  }

  const match = result.output.match(/control\s+(\d+)/i);
  if (!match) {
    log(`Daily upgrade enqueue parse failed: ${result.output}`);
    return false;
  }

  log(`Daily upgrade enqueued id=${match[1]} (tz=${timezone})`);
  return true;
}

let upgradeScheduler;      // initialized in init()
let memoryCommitScheduler; // initialized in init()
let upgradeCheckScheduler; // initialized in init()

// ---------------------------------------------------------------------------
// Daily Memory Commit
// ---------------------------------------------------------------------------

function loadMemoryCommitState() {
  try {
    if (!fs.existsSync(DAILY_MEMORY_COMMIT_STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(DAILY_MEMORY_COMMIT_STATE_FILE, 'utf8'));
  } catch { }
  return null;
}

function writeMemoryCommitState(date) {
  try {
    if (!fs.existsSync(MONITOR_DIR)) {
      fs.mkdirSync(MONITOR_DIR, { recursive: true });
    }
    fs.writeFileSync(DAILY_MEMORY_COMMIT_STATE_FILE, JSON.stringify({
      last_date: date,
      updated_at: new Date().toISOString()
    }, null, 2));
  } catch (err) {
    log(`Daily memory commit: failed to write state (${err.message})`);
  }
}

function executeDailyMemoryCommit() {
  try {
    const output = execFileSync('node', [DAILY_COMMIT_SCRIPT], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (output.trim()) {
      log(`Daily memory commit: ${output.trim()}`);
    }
    return true;
  } catch (err) {
    const detail = err?.stderr?.toString?.().trim() || err.message;
    log(`Daily memory commit failed: ${detail}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Daily Upgrade Check
// ---------------------------------------------------------------------------

function loadUpgradeCheckState() {
  try {
    if (!fs.existsSync(UPGRADE_CHECK_STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(UPGRADE_CHECK_STATE_FILE, 'utf8'));
  } catch { }
  return null;
}

function writeUpgradeCheckState(date) {
  try {
    if (!fs.existsSync(MONITOR_DIR)) {
      fs.mkdirSync(MONITOR_DIR, { recursive: true });
    }
    fs.writeFileSync(UPGRADE_CHECK_STATE_FILE, JSON.stringify({
      last_date: date,
      updated_at: new Date().toISOString()
    }, null, 2));
  } catch (err) {
    log(`Upgrade check: failed to write state (${err.message})`);
  }
}

const UPGRADE_CHECK_SCRIPT = path.join(__dirname, 'upgrade-check.js');

function executeUpgradeCheck() {
  // Spawn in a detached child process to avoid blocking the monitor loop.
  // The child handles GitHub API calls, version comparison, and C4 notification.
  try {
    const child = spawn('node', [UPGRADE_CHECK_SCRIPT], {
      stdio: 'ignore',
      detached: true
    });
    child.unref();
    log('Upgrade check: spawned background process');
    return true;
  } catch (err) {
    log(`Upgrade check: failed to spawn (${err.message})`);
    return false;
  }
}

// --- Usage Monitoring ---

function loadUsageState() {
  try {
    if (!fs.existsSync(USAGE_STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(USAGE_STATE_FILE, 'utf8'));
  } catch { }
  return null;
}

function writeUsageState(data) {
  try {
    fs.writeFileSync(USAGE_STATE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log(`Usage monitor: failed to write state (${err.message})`);
  }
}

function captureTmuxPane() {
  try {
    return execSync(`tmux capture-pane -t "${adapter.sessionName}" -p 2>/dev/null`, { encoding: 'utf8' });
  } catch {
    return null;
  }
}

function sendTmuxKeys(keys) {
  try {
    execSync(`tmux send-keys -t "${adapter.sessionName}" ${keys} 2>/dev/null`);
  } catch { /* best-effort */ }
}

function parseUsageFromPane(paneContent) {
  if (!paneContent) return null;

  // Match patterns like "5% used" near category labels
  const result = {};

  // Current session
  const sessionMatch = paneContent.match(/Current session[\s\S]*?(\d+)%\s*used/i);
  if (sessionMatch) result.session = parseInt(sessionMatch[1], 10);

  // Current week (all models)
  const weekAllMatch = paneContent.match(/Current week \(all models\)[\s\S]*?(\d+)%\s*used/i);
  if (weekAllMatch) result.weeklyAll = parseInt(weekAllMatch[1], 10);

  // Current week (Sonnet only)
  const weekSonnetMatch = paneContent.match(/Current week \(Sonnet[^)]*\)[\s\S]*?(\d+)%\s*used/i);
  if (weekSonnetMatch) result.weeklySonnet = parseInt(weekSonnetMatch[1], 10);

  // Reset times
  const resetMatches = [...paneContent.matchAll(/Resets\s+(.+?)(?:\n|$)/gi)];
  if (resetMatches.length >= 1) result.sessionResets = resetMatches[0][1].trim();
  if (resetMatches.length >= 2) result.weeklyAllResets = resetMatches[1][1].trim();
  if (resetMatches.length >= 3) result.weeklySonnetResets = resetMatches[2][1].trim();

  // Must have at least one valid reading
  if (result.session === undefined && result.weeklyAll === undefined) return null;
  return result;
}

function getUsageTier(weeklyPercent) {
  if (weeklyPercent >= USAGE_CRITICAL_THRESHOLD) return 'critical';
  if (weeklyPercent >= USAGE_HIGH_THRESHOLD) return 'high';
  if (weeklyPercent >= USAGE_WARN_THRESHOLD) return 'warning';
  return 'ok';
}

function formatUsageNotification(usage, tier) {
  const weekly = usage.weeklyAll ?? 0;
  const session = usage.session ?? 0;
  const resets = usage.weeklyAllResets || 'unknown';

  const tierLabels = {
    warning: '⚠️ Usage Warning',
    high: '🔶 Usage High',
    critical: '🔴 Usage Critical'
  };

  const lines = [
    tierLabels[tier] || 'Usage Alert',
    '',
    `Weekly (all models): ${weekly}% used`,
    `Session: ${session}% used`
  ];

  if (usage.weeklySonnet !== undefined) {
    lines.push(`Weekly (Sonnet): ${usage.weeklySonnet}% used`);
  }

  lines.push(`Resets: ${resets}`);

  if (tier === 'critical') {
    lines.push('', 'Approaching plan limit. Consider reducing activity to avoid interruption.');
  } else if (tier === 'high') {
    lines.push('', 'Usage is elevated. Monitor closely.');
  }

  return lines.join('\n');
}

function sendUsageNotification(message) {
  // Enqueue as a control message — Claude will relay to the owner via C4.
  // This avoids hardcoding owner channel/endpoint in the monitor.
  const content = `Usage alert received from activity monitor. Please forward this to the owner via their preferred DM channel:\n\n${message}`;
  const result = runC4Control([
    'enqueue',
    '--content', content,
    '--priority', '1',
    '--require-idle',
    '--available-in', '5'
  ]);
  if (result.ok) {
    log(`Usage monitor: notification enqueued (${result.output})`);
  } else {
    log(`Usage monitor: notification enqueue failed (${result.output})`);
  }
}

/**
 * Usage check state machine — called from monitorLoop every second.
 * Only progresses when Claude is idle with no pending work.
 */
function maybeCheckUsage(claudeState, idleSeconds, currentTime) {
  // /usage is a Claude Code-only slash command — skip for other runtimes
  if (adapter.runtimeId !== 'claude') return;

  // Abort in-progress check if Claude becomes busy (e.g., message arrived
  // during the wait window). The /usage UI may be overlaid or dismissed —
  // send Escape defensively to clean up, then reset.
  if (usageCheckPhase !== 'idle' && claudeState !== 'idle') {
    log('Usage monitor: aborting check — Claude became busy');
    sendTmuxKeys('Escape');
    usageCheckPhase = 'idle';
    return;
  }

  // Phase: sent/waiting/capture — continue the state machine
  if (usageCheckPhase === 'sent') {
    usageCheckPhase = 'waiting';
    usageCheckWaitCount = 0;
    return;
  }

  if (usageCheckPhase === 'waiting') {
    usageCheckWaitCount += 1;
    if (usageCheckWaitCount >= USAGE_CAPTURE_WAIT) {
      usageCheckPhase = 'capture';
    }
    return;
  }

  if (usageCheckPhase === 'capture') {
    const paneContent = captureTmuxPane();
    usageCheckPhase = 'idle';

    // Always dismiss the /usage dialog — it may show usage data, a rate-limit
    // error, or any other overlay. Escape is safe to send regardless.
    sendTmuxKeys('Escape');

    const usage = parseUsageFromPane(paneContent);
    if (!usage) {
      log('Usage monitor: failed to parse /usage output (rate-limited or unavailable)');
      // Prevent retrying too quickly
      lastUsageCheckAt = Math.floor(Date.now() / 1000);
      return;
    }

    const prevState = loadUsageState();
    const now = new Date().toISOString();
    const weeklyPercent = usage.weeklyAll ?? 0;
    const tier = getUsageTier(weeklyPercent);

    const usageData = {
      lastCheck: now,
      lastCheckEpoch: currentTime,
      session: { percent: usage.session, resets: usage.sessionResets },
      weeklyAll: { percent: usage.weeklyAll, resets: usage.weeklyAllResets },
      weeklySonnet: { percent: usage.weeklySonnet, resets: usage.weeklySonnetResets },
      tier,
      lastNotifiedTier: prevState?.lastNotifiedTier || null,
      lastNotifiedAt: prevState?.lastNotifiedAt || null
    };

    log(`Usage monitor: session=${usage.session}% weekly=${usage.weeklyAll}% sonnet=${usage.weeklySonnet}% tier=${tier}`);

    // Check if we should notify
    if (tier !== 'ok') {
      const prevTier = prevState?.lastNotifiedTier;
      const prevNotifiedAt = prevState?.lastNotifiedAt ? Math.floor(new Date(prevState.lastNotifiedAt).getTime() / 1000) : 0;
      const tierEscalated = prevTier !== tier && tierRank(tier) > tierRank(prevTier);
      const cooldownExpired = (currentTime - prevNotifiedAt) >= USAGE_NOTIFY_COOLDOWN;

      if (tierEscalated || cooldownExpired) {
        const message = formatUsageNotification(usage, tier);
        sendUsageNotification(message);
        usageData.lastNotifiedTier = tier;
        usageData.lastNotifiedAt = now;
      }
    }

    writeUsageState(usageData);
    lastUsageCheckAt = currentTime;
    return;
  }

  // Phase: idle — check if we should start a new usage check
  if (claudeState !== 'idle') return;
  if (idleSeconds < USAGE_IDLE_GATE) return;
  if ((currentTime - lastUsageCheckAt) < USAGE_CHECK_INTERVAL) return;

  // Only check during active hours
  const hour = getLocalHour();
  if (hour < USAGE_ACTIVE_HOURS_START || hour >= USAGE_ACTIVE_HOURS_END) return;

  // Check if C4 queue has pending messages (don't interrupt if work is about to arrive)
  try {
    const dbPath = path.join(ZYLOS_DIR, 'comm-bridge', 'c4.db');
    if (fs.existsSync(dbPath)) {
      const count = execSync(
        `sqlite3 "${dbPath}" "SELECT COUNT(*) FROM control_queue WHERE status='pending'" 2>/dev/null`,
        { encoding: 'utf8' }
      ).trim();
      if (parseInt(count, 10) > 0) return; // Messages pending, skip check
    }
  } catch { /* proceed anyway */ }

  // Start the check: send /usage to Claude
  log('Usage monitor: initiating /usage check');
  sendTmuxKeys('"/usage"');
  execSync('sleep 0.3');
  sendTmuxKeys('Enter');
  usageCheckPhase = 'sent';
}

function tierRank(tier) {
  const ranks = { ok: 0, warning: 1, high: 2, critical: 3 };
  return ranks[tier] ?? 0;
}

async function monitorLoop() {
  const currentTime = Math.floor(Date.now() / 1000);
  const currentTimeHuman = new Date().toISOString().replace('T', ' ').substring(0, 19);

  checkDailyTruncate();

  if (!tmuxHasSession()) {
    // Grace period: after starting Claude, wait for tmux session to appear
    if (startupGrace > 0) {
      startupGrace -= 1;
      engine.processHeartbeat(false, currentTime);
      return;
    }

    const state = 'offline';
    notRunningCount += 1;
    stableRunningSince = 0;

    writeStatusFile({
      state,
      since: currentTime,
      last_check: currentTime,
      last_check_human: currentTimeHuman,
      idle_seconds: 0,
      not_running_seconds: notRunningCount,
      message: 'tmux session not found'
    });

    if (state !== lastState) {
      log('State: OFFLINE (tmux session not found)');
    }

    // Don't restart while rate-limited — restarting can't fix rate limits.
    // The engine will handle recovery via cooldown timer.
    const restartDelay = Math.min(BASE_RESTART_DELAY * Math.pow(2, consecutiveRestarts), MAX_RESTART_DELAY);
    if (engine.health !== 'rate_limited' && notRunningCount >= restartDelay) {
      consecutiveRestarts += 1;
      log(`Guardian: Session not found for ${notRunningCount}s, starting ${adapter.displayName}... (attempt ${consecutiveRestarts}, next delay ${Math.min(BASE_RESTART_DELAY * Math.pow(2, consecutiveRestarts), MAX_RESTART_DELAY)}s)`);
      startAgent();
      startupGrace = 30;
      notRunningCount = 0;
    }

    engine.processHeartbeat(false, currentTime);
    maybeEnqueueHealthCheck(false, currentTime);

    memoryCommitScheduler.maybeTrigger();
    lastState = state;
    return;
  }

  let agentRunning = false;
  try {
    agentRunning = await adapter.isRunning();
  } catch (err) {
    log(`Guardian: adapter.isRunning() threw: ${err.message}`);
  }
  if (!agentRunning) {
    if (startupGrace > 0) {
      startupGrace -= 1;
      engine.processHeartbeat(false, currentTime);
      return;
    }

    const state = 'stopped';
    notRunningCount += 1;
    stableRunningSince = 0;

    writeStatusFile({
      state,
      since: currentTime,
      last_check: currentTime,
      last_check_human: currentTimeHuman,
      idle_seconds: 0,
      not_running_seconds: notRunningCount,
      message: `${adapter.displayName} not running in tmux`
    });

    if (state !== lastState) {
      log(`State: STOPPED (${adapter.displayName} not running in tmux session)`);
    }

    // Don't restart while rate-limited — restarting can't fix rate limits.
    const restartDelay = Math.min(BASE_RESTART_DELAY * Math.pow(2, consecutiveRestarts), MAX_RESTART_DELAY);
    if (engine.health !== 'rate_limited' && notRunningCount >= restartDelay) {
      consecutiveRestarts += 1;
      log(`Guardian: Agent not running for ${notRunningCount}s, starting ${adapter.displayName}... (attempt ${consecutiveRestarts}, next delay ${Math.min(BASE_RESTART_DELAY * Math.pow(2, consecutiveRestarts), MAX_RESTART_DELAY)}s)`);
      startAgent();
      startupGrace = 30;
      notRunningCount = 0;
    }

    engine.processHeartbeat(false, currentTime);
    maybeEnqueueHealthCheck(false, currentTime);

    memoryCommitScheduler.maybeTrigger();
    lastState = state;
    return;
  }

  startupGrace = 0;
  notRunningCount = 0;

  // Only reset backoff after Claude stays running for BACKOFF_RESET_THRESHOLD seconds.
  // Prevents flapping (brief start → immediate crash) from clearing the counter.
  if (consecutiveRestarts > 0) {
    if (stableRunningSince === 0) {
      stableRunningSince = currentTime;
    } else if (currentTime - stableRunningSince >= BACKOFF_RESET_THRESHOLD) {
      consecutiveRestarts = 0;
      stableRunningSince = 0;
    }
  }

  let activity = adapter.runtimeId === 'claude' ? getConversationFileModTime() : null;
  let source = 'conv_file';

  if (!activity) {
    activity = getTmuxActivity();
    source = 'tmux_activity';
  }

  if (!activity) {
    activity = currentTime;
    source = 'default';
  }

  // Read API activity from hook-activity.js (may be null if no hooks fired yet)
  const apiActivity = readApiActivity();
  const apiUpdatedSec = apiActivity?.updated_at ? Math.floor(apiActivity.updated_at / 1000) : 0;
  const activeTools = apiActivity?.active_tools ?? 0;
  const thinking = apiActivity?.active === true || activeTools > 0;

  // Merge activity sources: use API timestamp when it indicates active work
  // (PreToolUse/UserPromptSubmit set active=true). Don't extend activity on
  // Stop/Notification events (active=false) — those signal idle, not work.
  if (apiActivity?.active && apiUpdatedSec > activity) {
    activity = apiUpdatedSec;
    source = 'api_hook';
  }

  const inactiveSeconds = currentTime - activity;

  // State determination uses all available signals:
  // 1. active_tools > 0 → tools in flight, definitely busy
  // 2. recent activity (< IDLE_THRESHOLD) → busy
  // 3. otherwise → idle
  const state = (activeTools > 0 || inactiveSeconds < IDLE_THRESHOLD) ? 'busy' : 'idle';

  if (state === 'idle' && lastState !== 'idle') {
    idleSince = currentTime;
  } else if (state === 'busy') {
    idleSince = 0;
  }

  const idleSeconds = state === 'idle' ? currentTime - idleSince : 0;

  writeStatusFile({
    state,
    thinking,
    last_activity: activity,
    last_api_activity: apiUpdatedSec || undefined,
    active_tools: activeTools,
    last_check: currentTime,
    last_check_human: currentTimeHuman,
    idle_seconds: idleSeconds,
    inactive_seconds: inactiveSeconds,
    source
  });

  if (state !== lastState) {
    if (state === 'busy') {
      log(`State: BUSY (last activity ${inactiveSeconds}s ago)`);
    } else {
      log('State: IDLE (entering idle state)');
    }
  }

  // Rate-limit detection is now handled inside HeartbeatEngine.onHeartbeatFailure
  // via the detectRateLimit dep callback (dual-signal: heartbeat failure + tmux text).
  // This eliminates false positives from conversation content matching rate-limit patterns.

  // User message triggered recovery: when a user sends a message while unavailable,
  // c4-receive writes a signal file. Read and consume it to trigger/accelerate recovery.
  if (engine.health !== 'ok') {
    try {
      if (fs.existsSync(USER_MESSAGE_SIGNAL_FILE)) {
        const signal = JSON.parse(fs.readFileSync(USER_MESSAGE_SIGNAL_FILE, 'utf8'));
        fs.unlinkSync(USER_MESSAGE_SIGNAL_FILE);
        if (signal.timestamp && (currentTime - signal.timestamp) < 60) {
          engine.notifyUserMessage(currentTime);
        }
      }
    } catch { /* best-effort */ }
  }

  // Stuck detection: if no observable activity from any source for STUCK_THRESHOLD,
  // trigger an immediate heartbeat probe with a shorter timeout.
  if (engine.health === 'ok') {
    const lastAnyActivity = Math.max(activity, apiUpdatedSec);
    const stuckSeconds = currentTime - lastAnyActivity;

    if (stuckSeconds >= STUCK_THRESHOLD && (currentTime - lastStuckProbeAt) >= STUCK_PROBE_COOLDOWN) {
      const ok = engine.requestImmediateProbe(`no_activity_for_${stuckSeconds}s`);
      // Approach C: full cooldown on success, short retry (60s) on failure
      lastStuckProbeAt = ok ? currentTime : currentTime - STUCK_PROBE_COOLDOWN + 60;
    }
  }

  engine.processHeartbeat(true, currentTime);
  maybeEnqueueHealthCheck(true, currentTime);
  if (engine.health === 'ok') {
    upgradeScheduler.maybeTrigger();
    upgradeCheckScheduler.maybeTrigger();
  }
  memoryCommitScheduler.maybeTrigger();
  if (engine.health === 'ok') {
    maybeCheckUsage(state, idleSeconds, currentTime);
  }
  lastState = state;
}

/**
 * Read core memory files and return a condensed snapshot string for injection
 * into AGENTS.md on Codex session rotation. Gives the new session context from
 * the previous session so autonomous work is not silently interrupted.
 *
 * @returns {string} Snapshot content, or empty string if memory dir is absent.
 */
function _readMemorySnapshot() {
  const memDir = path.join(ZYLOS_DIR, 'memory');
  const files = ['identity.md', 'state.md', 'references.md'];
  const parts = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(memDir, file), 'utf8').trim();
      if (content) parts.push(`## ${file}\n\n${content}`);
    } catch { /* file absent — skip */ }
  }
  return parts.length
    ? `# Memory Snapshot (auto-injected on session rotation)\n\n${parts.join('\n\n')}`
    : '';
}

function init() {
  if (!fs.existsSync(MONITOR_DIR)) {
    fs.mkdirSync(MONITOR_DIR, { recursive: true });
  }

  // Load the active runtime adapter (claude or codex, from config.json)
  adapter = getActiveAdapter();

  const initialStatus = loadInitialHealth();
  const initialHealth = initialStatus.health;

  // Merge runtime-specific heartbeat deps (enqueueHeartbeat, getHeartbeatStatus,
  // detectRateLimit, readHeartbeatPending, clearHeartbeatPending) from the adapter,
  // with the remaining non-runtime deps (killTmuxSession, notifyPendingChannels, log).
  engine = new HeartbeatEngine({
    ...(adapter.getHeartbeatDeps() ?? {}),
    killTmuxSession: () => adapter.stop(),
    notifyPendingChannels,
    log,
  }, {
    initialHealth,
    heartbeatInterval: HEARTBEAT_INTERVAL,
    downDegradeThreshold: DOWN_DEGRADE_THRESHOLD,
    downRetryInterval: DOWN_RETRY_INTERVAL,
    signalGracePeriod: SIGNAL_GRACE_PERIOD,
    rateLimitDefaultCooldown: RATE_LIMIT_DEFAULT_COOLDOWN,
    userMessageRecoveryCooldown: USER_MESSAGE_RECOVERY_COOLDOWN
  });

  // Rehydrate rate-limit state from persisted status file on PM2 restart
  if (initialHealth === 'rate_limited' && initialStatus.cooldown_until) {
    engine.cooldownUntil = initialStatus.cooldown_until;
    engine.rateLimitResetTime = initialStatus.rate_limit_reset || '';
  }

  upgradeScheduler = new DailySchedule({
    getLocalHour,
    getLocalDate,
    loadState: loadDailyUpgradeState,
    writeState: writeDailyUpgradeState,
    execute: enqueueDailyUpgradeControl,
    log
  }, {
    hour: DAILY_UPGRADE_HOUR,
    name: 'daily-upgrade'
  });

  memoryCommitScheduler = new DailySchedule({
    getLocalHour,
    getLocalDate,
    loadState: loadMemoryCommitState,
    writeState: writeMemoryCommitState,
    execute: executeDailyMemoryCommit,
    log
  }, {
    hour: DAILY_MEMORY_COMMIT_HOUR,
    name: 'daily-memory-commit'
  });

  upgradeCheckScheduler = new DailySchedule({
    getLocalHour,
    getLocalDate,
    loadState: loadUpgradeCheckState,
    writeState: writeUpgradeCheckState,
    execute: executeUpgradeCheck,
    log
  }, {
    hour: DAILY_UPGRADE_CHECK_HOUR,
    name: 'daily-upgrade-check'
  });

  // Restore usage check timestamp from persisted state.
  // On fresh installs (no usage.json), default to current time so the first
  // check waits a full interval — prevents /usage from firing immediately
  // after Claude's first startup.
  const usageState = loadUsageState();
  lastUsageCheckAt = usageState?.lastCheckEpoch || Math.floor(Date.now() / 1000);

  // Start context monitor if the adapter provides one (Codex polling-based monitor).
  // Claude uses the statusLine hook instead — no adapter-provided monitor.
  contextMonitor = adapter.getContextMonitor?.() ?? null;
  if (contextMonitor) {
    contextMonitor.startPolling({
      intervalMs: 30_000,
      onExceed: async ({ used, ceiling, ratio }) => {
        const pct = Math.round(ratio * 100);
        log(`Context at ${pct}% (${used}/${ceiling}), triggering session rotation`);
        // Codex has no skill-invocation mechanism (no /clear equivalent).
        // The activity monitor directly stops and relaunches to start a fresh session.
        // Read core memory files first so the new session has continuity.
        try {
          const memorySnapshot = _readMemorySnapshot();

          // Notify the last active channel before stopping — mirrors Claude's behaviour
          // where the agent notifies users before initiating a context rotation.
          // Done here (infrastructure level) rather than relying on the new session to
          // self-report, which was unreliable in practice.
          const lastChannel = await getLastActiveChannel();
          if (lastChannel) {
            try {
              execFileSync('node', [C4_SEND_PATH, lastChannel.channel, lastChannel.endpoint,
                '上下文快满了，正在切换新 session，记忆完整保留，稍等片刻…'], { stdio: 'pipe' });
              log(`Rotation notice sent to ${lastChannel.channel}:${lastChannel.endpoint}`);
            } catch (notifyErr) {
              log(`Rotation notice failed (non-fatal): ${notifyErr.message}`);
            }
          }

          // Reset guardian counters before stopping so the guardian does not
          // treat the intentional stop as a crash and launch a second session
          // while adapter.launch() is still starting the new one.
          startupGrace = 30;
          notRunningCount = 0;
          adapter.stop();
          await new Promise(r => setTimeout(r, 2000));
          await adapter.launch({ memorySnapshot });
          log(`Codex session rotated (context ${pct}% exceeded threshold)`);
        } catch (err) {
          log(`Codex session rotation failed: ${err.message}`);
        }
      }
    });
    log(`Context monitor started (${adapter.displayName})`);
  }

  if (initialHealth !== 'ok') {
    log(`Startup with health=${initialHealth}; will verify immediately when ${adapter.displayName} is running`);
  }

  // Startup cleanup: kill the other runtime's tmux session if it exists.
  // Runs on every startup (not just runtime switches) — if the other session is
  // absent (normal case) the kill fails silently. The 10 s delay gives a running
  // agent time to finish its current response before being terminated.
  const OTHER_SESSION = adapter.runtimeId === 'codex' ? 'claude-main' : 'codex-main';
  setTimeout(() => {
    try {
      execSync(`tmux kill-session -t "${OTHER_SESSION}" 2>/dev/null`, { stdio: 'pipe' });
      log(`Startup cleanup: killed stale ${OTHER_SESSION} session from previous runtime`);
    } catch { /* session didn't exist — normal startup, no-op */ }
  }, 10_000);
}

try {
  init();
} catch (err) {
  // init() failure (e.g. unknown runtime in config.json) must not crash the PM2 process
  // into a tight restart loop. Log and exit cleanly so PM2 backs off via its restart policy.
  console.error(`[activity-monitor] Fatal: init() failed: ${err.message}`);
  process.exit(1);
}
log(`=== Activity Monitor Started (v21 - RuntimeAdapter: ${adapter.displayName} | Guardian + Heartbeat v4 + Hook Activity + DailyTasks + UpgradeCheck + UsageMonitor): ${new Date().toISOString()} tz=${timezone} ===`);

// Use self-scheduling loop instead of setInterval to prevent concurrent
// invocations: async monitorLoop + setInterval can overlap if isRunning()
// takes >INTERVAL ms (e.g., under high system load), causing state variable races.
(async function scheduleLoop() {
  await monitorLoop().catch(err => log(`Monitor loop error: ${err.message}`));
  setTimeout(scheduleLoop, INTERVAL);
})();
