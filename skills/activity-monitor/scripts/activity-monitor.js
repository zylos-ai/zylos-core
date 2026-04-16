#!/usr/bin/env node
/**
 * Activity Monitor v28 - RuntimeAdapter (multi-runtime) + Guardian + Heartbeat v4 + Health Check + Daily Tasks + Upgrade Check + Usage Monitor + ProcSampler
 *
 * v28 changes (file-backed usage monitor only):
 *   - Removed Claude/Codex usage sidecar probing from the runtime input path
 *   - Usage monitor now reads Claude snapshots from statusline/usage.json and Codex
 *     snapshots from usage-codex.json, with rollout fallback only for Codex
 *   - Added usage_monitor_enabled gate so usage polling remains opt-in
 *   - Logs the selected usage source and notification suppression decisions
 *
 * v27 changes (proactive API error scan):
 *   - monitorLoop scans tmux pane every 15s for fatal API errors (400, invalid_request_error)
 *     independently of heartbeat state — detects errors within 30s (2 consecutive scans)
 *     instead of waiting for the next periodic probe (up to 3 min) + 30s fast-detection window
 *   - Requires 2 consecutive detections to avoid false positives from conversation content
 *   - On confirmed detection: adapter.stop() → Guardian auto-restarts with fresh context
 *   - Skipped during launch grace period (same as periodic probes)
 *
 * v26 changes (launch grace period + stale heartbeat fix):
 *   - 3-minute grace period after agent launch: periodic heartbeat probes are skipped
 *     during this window to allow the new session to complete initialization (hooks,
 *     CLAUDE.md loading, session-start injection) before being expected to respond
 *   - Prevents false stuck_timeout kills on freshly launched sessions
 *   - Clear stale heartbeat-pending.json in startAgent() before launch to prevent
 *     old heartbeat timeout from pushing health to "recovering" after new session starts
 *
 * v25 changes (frozen process detection via /proc sampling):
 *   - New ProcSampler module: cross-platform context-switch sampling (Linux /proc, macOS top)
 *   - Detects frozen processes in 60s (6 samples × 10s interval) — independent of heartbeat
 *   - On frozen detection: adapter.stop() → Guardian auto-restarts on next loop
 *   - Heartbeat periodic probe interval increased from 3 min to 30 min (safety-net only)
 *   - proc-state.json written atomically for dispatcher to read
 *   - Dispatcher uses proc state for heartbeat auto-ack and verify_failed detection
 *
 * v24 changes (service recovery — auth retry backoff):
 *   - Auth failure now suppresses restart attempts for 3 minutes (authRetrySuppressedUntil)
 *     instead of retrying every second after the initial backoff delay is exceeded
 *   - User message signal clears the suppression for immediate retry
 *   - Suppression log is emitted once per 60s to avoid log spam
 *
 * v23 changes (service recovery — execSync timeout hardening — #319):
 *   - All execSync/execFileSync calls now have explicit timeouts to prevent
 *     indefinite blocking of the monitor loop if a subprocess hangs
 *   - tmux helpers (has-session, list-windows, capture-pane, send-keys, kill-session): 3000ms
 *   - pgrep calls in getRunningMaintenance(): 500ms
 *   - runC4Control() (node c4-control.js): 10000ms
 *   - sendRecoveryNotice() and context rotation notify (node c4-send.js): 15000ms
 *   - SQLite COUNT query in maybeCheckUsage(): 3000ms
 *
 * v22 changes (service recovery — auth + periodic probe):
 *   - checkAuth() in ClaudeAdapter/CodexAdapter is now a live probe (CLI subprocess / HTTP)
 *     instead of local file checks — detects revoked/expired tokens
 *   - startAgent() notifies owner (via C4 control enqueue) when auth fails, rate-limited to
 *     1 notification per hour to avoid spam
 *   - Replaced stuck detection (indirect activity signals → 300s threshold → probe) with
 *     a fixed 5-min periodic probe gated on active_tools === 0 (busy = hook counter > 0)
 *   - Guardian now calls engine.canRestart() instead of reading engine.health directly —
 *     separates Guardian (process liveness) from HeartbeatEngine (functional liveness)
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
 *   - Add usage monitoring for session / weekly plan consumption snapshots
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
 *   - Hook signals now feed monitor-owned activity state instead of preload polling
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
import { ProcSampler } from './proc-sampler.js';
import { readCodexUsageFromActiveRollout } from './usage-codex-rollout-reader.js';
import { shouldStartUsageCheck } from './usage-check-engine.js';
import { getInitialUsageCheckAt } from './usage-check-init.js';
import { isRuntimeHeartbeatEnabled } from './heartbeat-config.js';
import { getToolRules } from './tool-rules.js';
import {
  applyOrderedToolEvents,
  createToolLifecycleState,
  getSessionSnapshot,
  normalizeToolLifecycleState,
  pruneToolLifecycleState,
} from './tool-lifecycle.js';
import {
  createToolEventStreamState,
  readToolEventsIncrementalFromStream,
  rotateToolEventStream,
} from './tool-event-stream.js';
import {
  WATCHDOG_INTERRUPT_AVAILABLE_IN_SEC,
  evaluateToolWatchdogTransition
} from './tool-watchdog.js';
import {
  readClaudeUsageFromMonitorFiles,
  readCodexUsageFromMonitorFile
} from './usage-monitor-file-reader.js';
import { readTmuxInputState } from '../../comm-bridge/scripts/tmux-input-state.js';
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
  // Final fallback: discover via npm root -g.
  // Handles the post-upgrade case where PM2 has a stale env (no ZYLOS_PACKAGE_ROOT)
  // because the old upgrade code restarted services before deploying the new ecosystem config.
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf8', stdio: 'pipe', timeout: 5000 }).trim();
    const fallbackPath = path.join(npmRoot, 'zylos', 'cli', 'lib', 'runtime', 'index.js');
    if (fs.existsSync(fallbackPath)) return fallbackPath;
  } catch { /* ignore — throw below */ }
  throw new Error(
    '[activity-monitor] Cannot locate cli/lib/runtime/index.js. ' +
    'Ensure ZYLOS_PACKAGE_ROOT is set in the PM2 ecosystem config.'
  );
})();
const _runtimeDirPath = path.dirname(_runtimeIndexPath);
const _sessionHandoffPath = path.join(_runtimeDirPath, 'session-handoff.js');
const { getActiveAdapter } = await import(_runtimeIndexPath);
const { enqueueNewSession } = await import(_sessionHandoffPath);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Core runtime config
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const MONITOR_DIR = path.join(ZYLOS_DIR, 'activity-monitor');
const STATUS_FILE = path.join(MONITOR_DIR, 'agent-status.json');
const STATUSLINE_FILE = path.join(MONITOR_DIR, 'statusline.json');
const LOG_FILE = path.join(MONITOR_DIR, 'activity.log');
const HEALTH_CHECK_STATE_FILE = path.join(MONITOR_DIR, 'health-check-state.json');
const DAILY_UPGRADE_STATE_FILE = path.join(MONITOR_DIR, 'daily-upgrade-state.json');
const DAILY_MEMORY_COMMIT_STATE_FILE = path.join(MONITOR_DIR, 'daily-memory-commit-state.json');
const UPGRADE_CHECK_STATE_FILE = path.join(MONITOR_DIR, 'upgrade-check-state.json');
const PENDING_CHANNELS_FILE = path.join(MONITOR_DIR, 'pending-channels.jsonl');
const USER_MESSAGE_SIGNAL_FILE = path.join(MONITOR_DIR, 'user-message-signal.json');
const USAGE_STATE_FILE = path.join(MONITOR_DIR, 'usage.json');
const USAGE_CODEX_STATE_FILE = path.join(MONITOR_DIR, 'usage-codex.json');

// API activity snapshot — built by activity-monitor from Claude hook/session signals
const API_ACTIVITY_FILE = path.join(MONITOR_DIR, 'api-activity.json');
const HOOK_STATE_FILE = path.join(MONITOR_DIR, 'hook-state.json');
const TOOL_EVENTS_FILE = path.join(MONITOR_DIR, 'tool-events.jsonl');
const TOOL_EVENT_STREAM_STATE_FILE = path.join(MONITOR_DIR, 'tool-event-stream-state.json');
const SESSION_TOOL_STATE_FILE = path.join(MONITOR_DIR, 'session-tool-state.json');
const TOOL_WATCHDOG_STATE_FILE = path.join(MONITOR_DIR, 'tool-watchdog-state.json');
const FOREGROUND_SESSION_FILE = path.join(MONITOR_DIR, 'foreground-session.json');

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
const HEARTBEAT_INTERVAL = 7200;     // 2 hours (safety-net; active_tools-stuck edge case fallback)
const DOWN_DEGRADE_THRESHOLD = 3600; // 1 hour of continuous failure → enter DOWN
const DOWN_RETRY_INTERVAL = 3600;    // 60 min periodic retry in DOWN state
const SIGNAL_GRACE_PERIOD = 30;      // Wait 30s after agentRunning transitions before probing
const RATE_LIMIT_DEFAULT_COOLDOWN = 3600;  // 1 hour default when reset time can't be parsed
const USER_MESSAGE_RECOVERY_COOLDOWN = 60; // 1 min between user-message-triggered recoveries

// Periodic probe config — 30 min end-to-end health verification.
// ProcSampler (10s sampling) handles frozen-process detection; this probe catches cases
// where the process is alive but functionally broken (e.g., stuck API errors, auth expired).
// Previous 3-min interval caused excessive token consumption during idle periods.
const PERIODIC_PROBE_INTERVAL = 1800; // 30 min — reduced from 3 min to cut idle token usage
const LAUNCH_GRACE_PERIOD = 180;     // 3 min — skip periodic probes after fresh launch to allow initialization
const API_ERROR_SCAN_INTERVAL = 15;  // seconds between proactive tmux API error scans
const TOOL_EVENT_REORDER_WINDOW_MS = 2000;
const STATUSLINE_LAUNCH_GUARD_MS = 5000;
const STATUSLINE_ACTIVE_TOOL_CLEAR_GRACE_MS = 5000;
const TOOL_SESSION_TTL_MS = 3600_000;
const TOOL_EVENT_ROTATION_BYTES = 1024 * 1024;
const TOOL_EVENT_ROTATION_DRAIN_MS = 2000;

// Health check config
const HEALTH_CHECK_INTERVAL = 86400; // 24 hours

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

function readConfigString(key, fallback) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8'));
    const val = config[key];
    if (val !== undefined && val !== null) {
      const s = String(val).trim();
      if (s) return s;
    }
  } catch { }
  return fallback;
}

function readConfigBool(key, fallback) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8'));
    const val = config[key];
    if (val === true || val === 'true') return true;
    if (val === false || val === 'false') return false;
  } catch { }
  return fallback;
}

function readConfigObject() {
  try {
    return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

const USAGE_MONITOR_ENABLED = readConfigBool('usage_monitor_enabled', false);
const USAGE_CHECK_INTERVAL = readConfigInt('usage_check_interval', 3600);     // seconds between checks (default 1 hour)
const USAGE_IDLE_GATE = readConfigInt('usage_idle_gate', 30);                 // idle seconds required (default 30)
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
let lastPeriodicProbeAt = 0;
let lastLaunchAt = 0;
let lastApiErrorScanAt = 0;
let apiErrorConsecutiveHits = 0;  // consecutive scans that detected an API error
let authRetrySuppressedUntil = 0;
let startAgentInProgress = false;
let runtimeLaunchAtMs = 0;
let toolRules = [];
let toolLifecycleState = createToolLifecycleState();
let toolEventStreamState = createToolEventStreamState(TOOL_EVENTS_FILE);
let toolEventTail = '';
let toolEventRotatedTail = '';
let toolEventArrivalSeq = 0;
let toolEventReorderBuffer = [];
let watchdogState = null;
let lastStatuslineSyntheticClearAt = 0;

let adapter;         // initialized in init() via getActiveAdapter()
let engine;          // initialized in init()
let contextMonitor;  // initialized in init() if adapter provides one (Codex only)
let procSampler;     // initialized in init()

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
const C4_DB_PATH = resolveCommBridgeScript('c4-db.js');
const C4_SEND_PATH = resolveCommBridgeScript('c4-send.js');

function tmuxHasSession() {
  try {
    execSync(`tmux has-session -t "${adapter.sessionName}" 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
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
    execSync('pgrep -f "[r]estart-claude" > /dev/null 2>&1', { timeout: 500 });
    return 'restart-claude';
  } catch { }

  try {
    execSync('pgrep -f "[u]pgrade-claude" > /dev/null 2>&1', { timeout: 500 });
    return 'upgrade-claude';
  } catch { }

  try {
    execSync('pgrep -f "[c]laude.ai/install.sh" > /dev/null 2>&1', { timeout: 500 });
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

    execSync('sleep 1', { timeout: 1500 });
    waited += 1;
  }

  if (waited > 0 && waited < maxWait) {
    log(`Guardian: maintenance completed after ${waited}s`);
  }
}

// Startup prompt: Claude uses SessionStart hooks (session-start-prompt.js).
// For legacy Claude setups without that hook, fall back to C4 control.
// Codex path is handled inside CodexAdapter.launch() via startup instruction;
// do not enqueue the fallback here to avoid duplicate startup prompts.
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
  const content = 'reply to your human partner if they are waiting for your reply, then continue your ongoing tasks using the startup memory and C4 context already injected in this session, and do not query c4.db for recent conversations unless explicitly required.';
  const result = runC4Control([
    'enqueue',
    '--content', content,
    '--priority', '3',
    '--available-in', '3',
    '--no-ack-suffix'
  ]);
  if (result.ok) {
    const match = result.output.match(/control\s+(\d+)/i);
    log(`Startup control enqueued (fallback) id=${match?.[1] ?? '?'}`);
  } else {
    log(`Startup control enqueue failed (fallback): ${result.output}`);
  }
}

function enqueueContextRotationHandoff({ ratio = 0, used = 0, ceiling = 0 } = {}) {
  const pct = Math.round(ratio * 100);
  const usedTokens = Number.isFinite(used) ? used : 0;
  const ceilingTokens = Number.isFinite(ceiling) ? ceiling : 0;
  const ok = enqueueNewSession({
    ratio,
    used: usedTokens,
    ceiling: ceilingTokens,
    runtime: adapter.runtimeId,
    maxRetries: 3
  });
  if (ok) {
    log(`Context rotation handoff enqueued (pct=${pct}%)`);
    return true;
  }
  log(`Context rotation handoff enqueue failed (pct=${pct}%)`);
  return false;
}

/**
 * Check for a user-message signal file and clear auth suppression if found.
 * Called from offline/stopped branches (which return early before the main
 * signal-check code) so that user messages can trigger immediate auth retry.
 */
function maybeConsumeUserMessageSignal(currentTime) {
  try {
    if (!fs.existsSync(USER_MESSAGE_SIGNAL_FILE)) return;
    const signal = JSON.parse(fs.readFileSync(USER_MESSAGE_SIGNAL_FILE, 'utf8'));
    fs.unlinkSync(USER_MESSAGE_SIGNAL_FILE);
    if (signal.timestamp && (currentTime - signal.timestamp) < 60) {
      if (authRetrySuppressedUntil > 0) {
        log('Guardian: user message received, clearing auth retry suppression');
        authRetrySuppressedUntil = 0;
      }
      engine.notifyUserMessage(currentTime);
    }
  } catch { /* best-effort */ }
}

/**
 * Start the active runtime agent.
 * Clears stale state files, delegates launch to the RuntimeAdapter,
 * then enqueues the startup control prompt if no session-start hook is installed.
 */
async function startAgent() {
  // Prevent concurrent calls: auth check is async (up to 20s), so two ticks could
  // overlap. Guard ensures only one startAgent() runs at a time.
  if (startAgentInProgress) return;
  startAgentInProgress = true;

  try {
    if (isMaintenanceRunning()) {
      log('Guardian: Maintenance script detected, waiting for completion...');
      waitForMaintenance();
    }

    // Live auth check before restarting — avoids infinite restart loop on revoked/expired tokens.
    const authResult = adapter.checkAuth ? await adapter.checkAuth() : { ok: true };
    if (!authResult.ok) {
      log(`Guardian: auth failed (${authResult.reason ?? 'unknown'}), skipping restart. Next retry in 3 min.${authResult.output ? ' Output: ' + authResult.output : ''}`);
      authRetrySuppressedUntil = Date.now() + 180_000;
      engine.setHealth('auth_failed', authResult.reason ?? 'unknown');
      return;
    }

    // Auth passed — consume the restart budget and mark startup in progress.
    // Done here (after auth check) so auth failures don't consume backoff budget.
    authRetrySuppressedUntil = 0;
    consecutiveRestarts += 1;
    startupGrace = 30;
    notRunningCount = 0;

  log(`Guardian: Starting ${adapter.displayName}...`);
  lastLaunchAt = Math.floor(Date.now() / 1000);
  runtimeLaunchAtMs = Date.now();

  // Clear stale heartbeat pending from previous session — prevents a race where
  // the old heartbeat times out AFTER the new session starts, pushing health to
  // "recovering" when the process signal (false→true) was already consumed while
  // health was still "ok". Without this, health gets stuck in "recovering" with
  // no signal to trigger acceleration.
  try { engine.deps.clearHeartbeatPending(); } catch { }

  // Clear stale context temp files from a previous session
  try { fs.unlinkSync('/tmp/context-alert-cooldown'); } catch { }
  try { fs.unlinkSync('/tmp/context-compact-scheduled'); } catch { }

  // Reset tool lifecycle state — the new session gets a fresh event stream,
  // watchdog state, and foreground-session identity. Late old-session events
  // are still filtered by pid/session checks inside the watchdog path.
  try {
    resetToolLifecycleRuntimeState({ clearFiles: true });
    fs.writeFileSync(API_ACTIVITY_FILE, JSON.stringify({
      version: 3,
      active: false,
      active_tools: 0,
      in_prompt: false,
      updated_at: runtimeLaunchAtMs
    }));
    fs.writeFileSync(HOOK_STATE_FILE, JSON.stringify({ active_tools: 0 }));
  } catch { }

  // Fire-and-forget: launch() is intentionally not awaited. The monitor loop
  // must not block for the full startup duration (several seconds for the agent
  // to become interactive). startupGrace prevents re-entry for the next 30 ticks.
  adapter.launch().catch(err => {
    log(`Guardian: Failed to start ${adapter.displayName}: ${err.message}`);
  });

  // Claude legacy fallback only (Codex bootstrap prompt handles its own
  // session-start flow and triggers session-start-prompt.js itself).
  if (adapter.runtimeId === 'claude' && !hasStartupHook()) {
    enqueueStartupControl();
  }
  } finally {
    startAgentInProgress = false;
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

function atomicWriteJson(filePath, value) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function writeStatusFile(statusObj) {
  try {
    ensureStatusDir();
    const extra = {};
    if (engine.health === 'rate_limited') {
      extra.rate_limit_reset = engine.rateLimitResetTime || null;
      extra.cooldown_until = engine.cooldownUntil || null;
    }
    atomicWriteJson(STATUS_FILE, { ...statusObj, ...extra, health: engine.health });
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
    const output = execSync(`tmux list-windows -t "${adapter.sessionName}" -F '#{window_activity}' 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
    return parseInt(output.trim(), 10);
  } catch {
    return null;
  }
}

const CHECKPOINT_THRESHOLD = 30;  // must match c4-config.js CHECKPOINT_THRESHOLD
const MEMORY_SYNC_COOLDOWN_SECONDS = 600;  // 10 min — prevent re-inject while sync is running
let lastMemorySyncTriggerAt = 0;

function getUnsummarizedCount() {
  try {
    const output = execFileSync('node', [C4_DB_PATH, 'unsummarized'], {
      encoding: 'utf8', stdio: 'pipe', timeout: 5000
    });
    const range = JSON.parse(output);
    return range.count || 0;
  } catch {
    return 0;
  }
}

function runC4Control(args) {
  try {
    const output = execFileSync('node', [C4_CONTROL_PATH, ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 10000 }).trim();
    return { ok: true, output };
  } catch (err) {
    const stdout = err.stdout ? String(err.stdout).trim() : '';
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    return { ok: false, output: stdout || stderr || err.message };
  }
}

function readJsonFileSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best-effort.
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function getTmuxPanePid(sessionName) {
  try {
    const out = execSync(
      `tmux list-panes -t "${sessionName}" -F '#{pane_pid}' 2>/dev/null | head -1`,
      { encoding: 'utf8', timeout: 3000 }
    ).trim();
    const pid = Number.parseInt(out, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function getTmuxClaudePid(sessionName) {
  const panePid = getTmuxPanePid(sessionName);
  if (!panePid) return 0;

  try {
    const name = execSync(`ps -p ${panePid} -o comm= 2>/dev/null`, {
      encoding: 'utf8',
      timeout: 3000
    }).trim();
    if (name === 'claude') return panePid;
  } catch {
    // Ignore and fall through.
  }

  try {
    const out = execSync(`pgrep -P ${panePid} -f "claude" | head -1`, {
      encoding: 'utf8',
      timeout: 3000
    }).trim();
    const childPid = Number.parseInt(out, 10);
    return Number.isInteger(childPid) && childPid > 0 ? childPid : 0;
  } catch {
    return 0;
  }
}

function writeToolEventStreamState() {
  try {
    atomicWriteJson(TOOL_EVENT_STREAM_STATE_FILE, toolEventStreamState);
  } catch {
    // Best-effort.
  }
}

function writeSessionToolState(foregroundIdentity, foregroundSessionId) {
  try {
    const sessions = {};
    for (const sessionId of Object.keys(toolLifecycleState.sessions).sort()) {
      const snapshot = getSessionSnapshot(toolLifecycleState, sessionId, foregroundSessionId);
      if (!snapshot) continue;
      sessions[sessionId] = {
        ...snapshot,
        watchdog_candidate: snapshot.running_tools.find((tool) => {
          const rule = tool.rule_id ? toolRules.find((candidate) => candidate.id === tool.rule_id) : null;
          return Boolean(rule?.watchdog?.enabled);
        }) || null
      };
    }

    atomicWriteJson(SESSION_TOOL_STATE_FILE, {
      version: 1,
      foreground_source: foregroundIdentity?.source || null,
      foreground_session_id: foregroundSessionId || null,
      sessions,
      pending_completions: toolLifecycleState.pending_completions,
      pending_clear_hints: toolLifecycleState.pending_clear_hints,
    });
  } catch {
    // Best-effort.
  }
}

function writeApiActivitySnapshot(apiActivity) {
  try {
    atomicWriteJson(API_ACTIVITY_FILE, apiActivity);
  } catch {
    // Best-effort.
  }
}

function writeWatchdogState() {
  try {
    if (!watchdogState) {
      safeUnlink(TOOL_WATCHDOG_STATE_FILE);
      return;
    }
    atomicWriteJson(TOOL_WATCHDOG_STATE_FILE, watchdogState);
  } catch {
    // Best-effort.
  }
}

function loadPersistedToolEventStreamState() {
  const persisted = readJsonFileSafe(TOOL_EVENT_STREAM_STATE_FILE);
  if (!persisted || persisted.version !== 1) return null;
  try {
    if (!fs.existsSync(TOOL_EVENTS_FILE)) return null;
    const stat = fs.statSync(TOOL_EVENTS_FILE);
    const inode = Number(stat.ino) || 0;
    if (persisted.inode && persisted.inode !== inode) return null;
    if (stat.size < (Number(persisted.offset) || 0)) return null;

    const loaded = {
      ...createToolEventStreamState(TOOL_EVENTS_FILE),
      inode,
      offset: Number(persisted.offset) || 0,
      last_processed_at: Number(persisted.last_processed_at) || 0,
      last_rotation_at: Number(persisted.last_rotation_at) || 0,
    };

    const rotatedDrain = persisted.rotated_drain;
    if (rotatedDrain?.path) {
      if (fs.existsSync(rotatedDrain.path)) {
        const rotatedStat = fs.statSync(rotatedDrain.path);
        const rotatedInode = Number(rotatedStat.ino) || 0;
        const rotatedOffset = Number(rotatedDrain.offset) || 0;
        if ((!rotatedDrain.inode || rotatedDrain.inode === rotatedInode) && rotatedStat.size >= rotatedOffset) {
          loaded.rotated_drain = {
            path: rotatedDrain.path,
            inode: rotatedInode,
            offset: rotatedOffset,
            last_size: Math.max(Number(rotatedDrain.last_size) || 0, rotatedOffset),
            quiet_since: Number(rotatedDrain.quiet_since) || loaded.last_rotation_at || 0,
          };
        }
      }
    }

    if (!loaded.offset && !loaded.rotated_drain) return null;
    return loaded;
  } catch {
    return null;
  }
}

function resetToolLifecycleRuntimeState({ clearFiles = false } = {}) {
  toolLifecycleState = createToolLifecycleState();
  toolEventStreamState = createToolEventStreamState(TOOL_EVENTS_FILE);
  toolEventTail = '';
  toolEventRotatedTail = '';
  toolEventArrivalSeq = 0;
  toolEventReorderBuffer = [];
  lastStatuslineSyntheticClearAt = 0;
  watchdogState = null;

  if (clearFiles) {
    try {
      fs.writeFileSync(TOOL_EVENTS_FILE, '');
    } catch {
      // Best-effort.
    }
    safeUnlink(TOOL_EVENT_STREAM_STATE_FILE);
    safeUnlink(SESSION_TOOL_STATE_FILE);
    safeUnlink(TOOL_WATCHDOG_STATE_FILE);
    safeUnlink(FOREGROUND_SESSION_FILE);
    safeUnlink(`${TOOL_EVENTS_FILE}.old`);
    return;
  }

  // PM2 restart path: resume from persisted state to avoid full replay.
  // Both stream cursor and lifecycle state must load successfully;
  // if either is stale or missing, fall back to offset-0 full replay.
  const loadedStreamState = loadPersistedToolEventStreamState();
  if (!loadedStreamState) return;

  const loadedSessionState = readJsonFileSafe(SESSION_TOOL_STATE_FILE);
  if (!loadedSessionState || loadedSessionState.version !== 1) return;

  toolEventStreamState = loadedStreamState;
  toolLifecycleState = normalizeToolLifecycleState(loadedSessionState);
}

function readForegroundSessionRecord() {
  const data = readJsonFileSafe(FOREGROUND_SESSION_FILE);
  if (!data || !data.session_id) return null;
  return {
    sessionId: String(data.session_id),
    claudePid: Number(data.claude_pid) || 0,
    source: data.source || 'session_start',
    observedAt: Number(data.observed_at) || 0,
  };
}

function readStatuslineRecord() {
  try {
    if (!fs.existsSync(STATUSLINE_FILE)) return null;
    const stat = fs.statSync(STATUSLINE_FILE);
    const data = JSON.parse(fs.readFileSync(STATUSLINE_FILE, 'utf8'));
    if (!data?.session_id) return null;
    return {
      sessionId: String(data.session_id),
      observedAt: Math.floor(stat.mtimeMs),
    };
  } catch {
    return null;
  }
}

function canTreatPaneAsRecovered(interactiveState) {
  return Boolean(
    interactiveState?.captureOk &&
    interactiveState.promptVisible &&
    !interactiveState.usageOverlay &&
    !interactiveState.inProgressCapture &&
    (interactiveState.inputState === 'empty' || interactiveState.inputState === 'has_content')
  );
}

function resolveTrustedForegroundIdentity(currentTmuxClaudePid) {
  const early = readForegroundSessionRecord();
  const statusline = readStatuslineRecord();
  const launchGuardFloor = Math.max(0, runtimeLaunchAtMs - STATUSLINE_LAUNCH_GUARD_MS);

  const earlyTrusted = Boolean(
    early &&
    early.observedAt >= launchGuardFloor &&
    isPidAlive(early.claudePid) &&
    (!currentTmuxClaudePid || early.claudePid === currentTmuxClaudePid)
  );

  const statuslineFresh = Boolean(
    statusline &&
    statusline.observedAt >= launchGuardFloor
  );

  if (statuslineFresh && currentTmuxClaudePid > 0) {
    return {
      trusted: true,
      sessionId: statusline.sessionId,
      claudePid: currentTmuxClaudePid,
      source: earlyTrusted && early.sessionId === statusline.sessionId
        ? 'session_start+statusline'
        : 'statusline',
      observedAt: statusline.observedAt,
      blockReason: null,
    };
  }

  if (earlyTrusted) {
    return {
      trusted: true,
      sessionId: early.sessionId,
      claudePid: early.claudePid,
      source: early.source || 'session_start',
      observedAt: early.observedAt,
      blockReason: null,
    };
  }

  if (statusline && !statuslineFresh) {
    return {
      trusted: false,
      sessionId: statusline.sessionId,
      claudePid: 0,
      source: 'statusline',
      observedAt: statusline.observedAt,
      blockReason: 'stale_statusline',
    };
  }

  if (statusline && currentTmuxClaudePid <= 0) {
    return {
      trusted: false,
      sessionId: statusline.sessionId,
      claudePid: 0,
      source: 'statusline',
      observedAt: statusline.observedAt,
      blockReason: 'missing_tmux_claude_pid',
    };
  }

  return {
    trusted: false,
    sessionId: null,
    claudePid: 0,
    source: null,
    observedAt: 0,
    blockReason: 'missing_foreground_identity',
  };
}

function getToolEventPriority(eventName) {
  switch (eventName) {
    case 'prompt':
      return 10;
    case 'pre_tool':
      return 20;
    case 'post_tool':
    case 'post_tool_failure':
      return 30;
    case 'stop':
    case 'stop_failure':
    case 'idle':
      return 40;
    case 'session_clear_hint':
      return 50;
    default:
      return 100;
  }
}

function sortToolEvents(events) {
  events.sort((left, right) => {
    if (left.ts !== right.ts) return left.ts - right.ts;
    const priorityDiff = getToolEventPriority(left.event) - getToolEventPriority(right.event);
    if (priorityDiff !== 0) return priorityDiff;
    return (left._arrival_seq || 0) - (right._arrival_seq || 0);
  });
}

function readToolEventsIncremental(nowMs) {
  const result = readToolEventsIncrementalFromStream({
    filePath: TOOL_EVENTS_FILE,
    streamState: toolEventStreamState,
    activeTail: toolEventTail,
    rotatedTail: toolEventRotatedTail,
    arrivalSeq: toolEventArrivalSeq,
    nowMs,
    drainQuietMs: TOOL_EVENT_ROTATION_DRAIN_MS,
    log,
  });
  toolEventStreamState = result.streamState;
  toolEventTail = result.activeTail;
  toolEventRotatedTail = result.rotatedTail;
  toolEventArrivalSeq = result.arrivalSeq;
  return result.events;
}

function maybeBuildStatuslineClearHint(currentTmuxClaudePid, interactiveState) {
  const statusline = readStatuslineRecord();
  if (!statusline?.sessionId) return null;
  if (statusline.observedAt < Math.max(0, runtimeLaunchAtMs - STATUSLINE_LAUNCH_GUARD_MS)) return null;
  if (statusline.observedAt <= lastStatuslineSyntheticClearAt) return null;
  if (!canTreatPaneAsRecovered(interactiveState)) return null;
  const session = getSessionSnapshot(toolLifecycleState, statusline.sessionId, statusline.sessionId);
  const runningTools = session?.running_tools || [];
  if (runningTools.length === 0) return null;
  const newestStartedAt = Number(runningTools[runningTools.length - 1]?.started_at) || 0;
  if (newestStartedAt > 0 && statusline.observedAt < (newestStartedAt + STATUSLINE_ACTIVE_TOOL_CLEAR_GRACE_MS)) {
    return null;
  }
  lastStatuslineSyntheticClearAt = statusline.observedAt;
  return {
    ts: statusline.observedAt,
    pid: currentTmuxClaudePid || 0,
    session_id: statusline.sessionId,
    event: 'session_clear_hint',
    reason: 'statusline_turn_complete',
    match_slack_ms: TOOL_EVENT_REORDER_WINDOW_MS,
    _arrival_seq: ++toolEventArrivalSeq,
  };
}

function collectLiveSessionPids() {
  const livePids = new Set();
  for (const session of Object.values(toolLifecycleState.sessions)) {
    const pid = Number(session?.pid) || 0;
    if (isPidAlive(pid)) livePids.add(pid);
  }
  return livePids;
}

function maybeRotateToolEventStream(nowMs, foregroundSessionId) {
  try {
    if (!fs.existsSync(TOOL_EVENTS_FILE)) return;
    const stat = fs.statSync(TOOL_EVENTS_FILE);
    if (stat.size < TOOL_EVENT_ROTATION_BYTES) return;

    const hasAnyActiveTools = Object.keys(toolLifecycleState.sessions).some((sessionId) => {
      const snapshot = getSessionSnapshot(toolLifecycleState, sessionId, foregroundSessionId);
      return Boolean(snapshot?.running_tools?.length);
    });
    const hasPendingBuffers = toolLifecycleState.pending_completions.length > 0 || toolLifecycleState.pending_clear_hints.length > 0;
    if (
      hasAnyActiveTools ||
      hasPendingBuffers ||
      toolEventReorderBuffer.length > 0 ||
      toolEventTail ||
      toolEventRotatedTail ||
      toolEventStreamState.rotated_drain
    ) {
      return;
    }

    toolEventStreamState = rotateToolEventStream({
      filePath: TOOL_EVENTS_FILE,
      nowMs,
    });
    toolEventTail = '';
    toolEventRotatedTail = '';
    writeToolEventStreamState();
    log('Tool event stream: rotated event log');
  } catch (err) {
    log(`Tool event stream rotation failed: ${err.message}`);
  }
}

function processToolLifecycle(nowMs, currentTmuxClaudePid, interactiveState) {
  const newEvents = readToolEventsIncremental(nowMs);
  const syntheticClear = maybeBuildStatuslineClearHint(currentTmuxClaudePid, interactiveState);
  if (syntheticClear) newEvents.push(syntheticClear);
  if (newEvents.length > 0) {
    toolEventReorderBuffer.push(...newEvents);
    sortToolEvents(toolEventReorderBuffer);
  }

  const flushBefore = nowMs - TOOL_EVENT_REORDER_WINDOW_MS;
  const flushable = [];
  const deferred = [];
  for (const event of toolEventReorderBuffer) {
    if ((event.ts || 0) <= flushBefore) {
      flushable.push(event);
    } else {
      deferred.push(event);
    }
  }
  toolEventReorderBuffer = deferred;

  if (flushable.length > 0) {
    applyOrderedToolEvents(toolLifecycleState, flushable, { nowMs });
  }

  pruneToolLifecycleState(toolLifecycleState, {
    nowMs,
    livePids: collectLiveSessionPids(),
    sessionTtlMs: TOOL_SESSION_TTL_MS
  });

  writeToolEventStreamState();
}

function getRuleById(ruleId) {
  if (!ruleId) return null;
  return toolRules.find((rule) => rule.id === ruleId) || null;
}

function buildApiActivity(foregroundIdentity, currentTmuxClaudePid) {
  const sessionId = foregroundIdentity?.trusted ? foregroundIdentity.sessionId : null;
  const session = sessionId ? getSessionSnapshot(toolLifecycleState, sessionId, sessionId) : null;
  const runningTools = session?.running_tools || [];
  const oldestActiveTool = runningTools[0] || null;
  const watchdogCandidate = runningTools.find((tool) => {
    const rule = getRuleById(tool.rule_id);
    return Boolean(rule?.watchdog?.enabled);
  }) || null;
  const pid = foregroundIdentity?.claudePid || session?.pid || currentTmuxClaudePid || 0;

  return {
    version: 3,
    pid,
    sessionId: sessionId || null,
    scope: sessionId ? 'foreground' : null,
    foreground_identity: {
      session_id: foregroundIdentity?.sessionId || null,
      source: foregroundIdentity?.source || null,
      trusted: Boolean(foregroundIdentity?.trusted),
      observed_at: foregroundIdentity?.observedAt || 0,
    },
    event: session?.last_event || null,
    tool: watchdogCandidate?.name || oldestActiveTool?.name || session?.last_completed_tool?.name || null,
    active: Boolean(runningTools.length > 0 || session?.in_prompt),
    active_tools: runningTools.length,
    in_prompt: Boolean(session?.in_prompt),
    updated_at: session?.last_event_at || 0,
    oldest_active_tool: oldestActiveTool ? {
      event_id: oldestActiveTool.event_id,
      name: oldestActiveTool.name,
      rule_id: oldestActiveTool.rule_id,
      started_at: oldestActiveTool.started_at,
      summary: oldestActiveTool.summary,
    } : null,
    watchdog_candidate_tool: watchdogCandidate ? {
      event_id: watchdogCandidate.event_id,
      name: watchdogCandidate.name,
      rule_id: watchdogCandidate.rule_id,
      started_at: watchdogCandidate.started_at,
      summary: watchdogCandidate.summary,
    } : null,
    last_completed_tool: session?.last_completed_tool || null,
  };
}

function clearWatchdogState() {
  if (!watchdogState) return;
  watchdogState = null;
  writeWatchdogState();
}

function applySyntheticClearHint(sessionId, pid, reason, nowMs) {
  applyOrderedToolEvents(toolLifecycleState, [{
    ts: nowMs,
    pid: pid || 0,
    session_id: sessionId,
    event: 'session_clear_hint',
    reason,
    match_slack_ms: TOOL_EVENT_REORDER_WINDOW_MS,
  }], { nowMs });
}

function evaluateToolWatchdog({ nowMs, foregroundIdentity, apiActivity, interactiveState }) {
  const state = {
    watchdogState,
    runtimeLaunchAtMs,
    launchGracePeriodSec: LAUNCH_GRACE_PERIOD,
    engineHealth: engine.health,
  };

  const phase = evaluateToolWatchdogTransition({
    nowMs,
    foregroundIdentity,
    apiActivity,
    interactiveState,
    state,
    deps: {
      canTreatPaneAsRecovered,
      getRuleById,
      clearWatchdogState: () => {
        watchdogState = null;
        state.watchdogState = null;
        writeWatchdogState();
      },
      writeWatchdogState: () => {
        watchdogState = state.watchdogState;
        writeWatchdogState();
      },
      applySyntheticClearHint,
      enqueueInterrupt: (interruptKey) => runC4Control([
        'enqueue',
        '--content', `[KEYSTROKE]${interruptKey}`,
        '--priority', '0',
        '--bypass-state',
        '--available-in', String(WATCHDOG_INTERRUPT_AVAILABLE_IN_SEC),
        '--no-ack-suffix'
      ]),
      triggerRecovery: (reason) => engine.triggerRecovery(reason),
      log,
    }
  });

  watchdogState = state.watchdogState;
  return phase;
}

function sendRecoveryNotice(channel, endpoint) {
  try {
    execFileSync('node', [C4_SEND_PATH, channel, endpoint, 'Hey! I was temporarily unavailable but I\'m back online now. If you sent me something while I was away, could you send it again? Thanks!'], { stdio: 'pipe', timeout: 15000 });
    return true;
  } catch (err) {
    log(`Recovery notice failed for ${channel}:${endpoint} (${err.message})`);
    return false;
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
    '--no-ack-suffix'
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
    '--no-ack-suffix'
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
    const stateFile = getUsageStateFile();
    if (!fs.existsSync(stateFile)) return null;
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch { }
  return null;
}

function writeUsageState(data) {
  try {
    fs.writeFileSync(getUsageStateFile(), JSON.stringify(data, null, 2));
  } catch (err) {
    log(`Usage monitor: failed to write state (${err.message})`);
  }
}

function getUsageStateFile() {
  if (adapter?.runtimeId === 'codex') return USAGE_CODEX_STATE_FILE;
  return USAGE_STATE_FILE;
}

function getPendingWorkCount() {
  try {
    const dbPath = path.join(ZYLOS_DIR, 'comm-bridge', 'c4.db');
    if (!fs.existsSync(dbPath)) return 0;

    const out = execSync(
      `sqlite3 "${dbPath}" "SELECT ((SELECT COUNT(*) FROM control_queue WHERE status='pending') + (SELECT COUNT(*) FROM conversations WHERE direction='in' AND status='pending'))" 2>/dev/null`,
      { encoding: 'utf8', timeout: 3000 }
    ).trim();

    return parseInt(out || '0', 10) || 0;
  } catch {
    return 0;
  }
}

function maybeCleanupUsageProbeSessions() {
  // Sidecar probing was removed for issue #470.
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

  if (usage.weeklySonnet !== undefined && usage.weeklySonnet !== null) {
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
    '--available-in', '5',
    '--no-ack-suffix'
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
function maybeCheckUsage(claudeState, idleSeconds, currentTime, apiActivity) {
  if (!USAGE_MONITOR_ENABLED) return;
  if (adapter.runtimeId !== 'claude' && adapter.runtimeId !== 'codex') return;

  const promptUpdatedAt = apiActivity?.updated_at
    ? Math.floor(apiActivity.updated_at / 1000) : 0;
  const shouldStart = shouldStartUsageCheck({
    runtimeId: adapter.runtimeId,
    allowedRuntimeIds: ['claude', 'codex'],
    claudeState,
    idleSeconds,
    currentTime,
    lastUsageCheckAt,
    checkInterval: { seconds: USAGE_CHECK_INTERVAL, idleGate: USAGE_IDLE_GATE },
    inPrompt: adapter.runtimeId === 'claude' ? Boolean(apiActivity?.in_prompt) : false,
    promptUpdatedAt,
    localHour: getLocalHour(),
    activeHoursStart: USAGE_ACTIVE_HOURS_START,
    activeHoursEnd: USAGE_ACTIVE_HOURS_END,
    pendingQueueCount: getPendingWorkCount(),
    lockBusy: false,
    backoffUntil: 0,
    circuitUntil: 0,
  });
  if (!shouldStart) return;

  let snapshot = null;
  let source = null;
  if (adapter.runtimeId === 'claude') {
    snapshot = readClaudeUsageFromMonitorFiles({
      statuslineFile: STATUSLINE_FILE,
      usageStateFile: USAGE_STATE_FILE
    });
    source = snapshot?.statusShape || 'none';
  } else {
    snapshot = readCodexUsageFromMonitorFile({
      usageStateFile: USAGE_CODEX_STATE_FILE
    });
    source = snapshot?.statusShape || 'usage-codex-missing';

    if (!snapshot) {
      const rolloutStatus = readCodexUsageFromActiveRollout();
      if (rolloutStatus) {
        snapshot = {
          sessionPercent: rolloutStatus.sessionPercent,
          sessionResets: rolloutStatus.sessionResets,
          weeklyAllPercent: rolloutStatus.weeklyAllPercent,
          weeklyAllResets: rolloutStatus.weeklyAllResets,
          weeklySonnetPercent: null,
          weeklySonnetResets: null,
          fiveHourPercent: rolloutStatus.fiveHourPercent,
          fiveHourResets: rolloutStatus.fiveHourResets,
          statusShape: 'rollout_fallback'
        };
        source = snapshot.statusShape;
        log('Usage monitor (codex): usage-codex.json unavailable, falling back to rollout reader');
      }
    }
  }

  if (!snapshot) {
    log(`Usage monitor (${adapter.runtimeId}): no local usage snapshot available`);
    lastUsageCheckAt = currentTime;
    return;
  }

  const usage = {
    session: snapshot.sessionPercent,
    sessionResets: snapshot.sessionResets,
    weeklyAll: snapshot.weeklyAllPercent,
    weeklyAllResets: snapshot.weeklyAllResets,
    weeklySonnet: snapshot.weeklySonnetPercent,
    weeklySonnetResets: snapshot.weeklySonnetResets,
    fiveHour: snapshot.fiveHourPercent,
    fiveHourResets: snapshot.fiveHourResets
  };
  const prevState = loadUsageState();
  const now = new Date().toISOString();
  const tierMetric = usage.weeklyAll ?? usage.session;
  const tier = getUsageTier(tierMetric ?? 0);
  const prevTier = prevState?.lastNotifiedTier;
  const prevNotifiedAt = prevState?.lastNotifiedAt ? Math.floor(new Date(prevState.lastNotifiedAt).getTime() / 1000) : 0;
  const tierEscalated = prevTier !== tier && tierRank(tier) > tierRank(prevTier);
  const cooldownExpired = (currentTime - prevNotifiedAt) >= USAGE_NOTIFY_COOLDOWN;

  const usageData = {
    lastCheck: now,
    lastCheckEpoch: currentTime,
    session: { percent: usage.session, resets: usage.sessionResets },
    weeklyAll: { percent: usage.weeklyAll, resets: usage.weeklyAllResets },
    weeklySonnet: { percent: usage.weeklySonnet, resets: usage.weeklySonnetResets },
    fiveHour: { percent: usage.fiveHour, resets: usage.fiveHourResets },
    tier,
    statusShape: source,
    lastNotifiedTier: prevTier || null,
    lastNotifiedAt: prevState?.lastNotifiedAt || null
  };

  log(
    `Usage monitor (${adapter.runtimeId}): source=${source} session=${usage.session ?? 'null'}% ` +
    `5h=${usage.fiveHour ?? 'null'}% weekly=${usage.weeklyAll ?? 'null'}% tier=${tier}`
  );

  if (tier !== 'ok' && usage.weeklyAll !== null && usage.weeklyAll !== undefined) {
    if (tierEscalated || cooldownExpired) {
      log(`Usage monitor (${adapter.runtimeId}): notifying owner for tier=${tier}`);
      const message = formatUsageNotification(usage, tier);
      sendUsageNotification(message);
      usageData.lastNotifiedTier = tier;
      usageData.lastNotifiedAt = now;
    } else {
      log(`Usage monitor (${adapter.runtimeId}): suppressing notification (cooldown active, tier=${tier})`);
    }
  }

  writeUsageState(usageData);
  lastUsageCheckAt = currentTime;
  return;
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

    // Check for user message signal — clears auth suppression for immediate retry.
    maybeConsumeUserMessageSignal(currentTime);

    // Delegate restart permission to HeartbeatEngine (e.g. won't restart during rate_limited).
    // Counter mutations (consecutiveRestarts, startupGrace, notRunningCount) are handled
    // inside startAgent() after auth check passes — not here.
    const restartDelay = Math.min(BASE_RESTART_DELAY * Math.pow(2, consecutiveRestarts), MAX_RESTART_DELAY);
    if (engine.canRestart() && notRunningCount >= restartDelay) {
      if (Date.now() < authRetrySuppressedUntil) {
        if (notRunningCount % 60 === 0) log(`Guardian: auth retry suppressed for ${Math.ceil((authRetrySuppressedUntil - Date.now()) / 1000)}s`);
      } else {
        log(`Guardian: Session not found for ${notRunningCount}s, attempting to start ${adapter.displayName}...`);
        startAgent();
      }
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
      message: `${adapter.displayName} not running in tmux`,
      runtime_launch_at: runtimeLaunchAtMs
    });

    if (adapter.runtimeId === 'claude') {
      clearWatchdogState();
      writeApiActivitySnapshot({
        version: 3,
        pid: 0,
        sessionId: null,
        scope: null,
        foreground_identity: {
          session_id: null,
          source: null,
          trusted: false,
          observed_at: 0,
        },
        event: 'stop',
        tool: null,
        active: false,
        active_tools: 0,
        in_prompt: false,
        updated_at: Date.now(),
        oldest_active_tool: null,
        watchdog_candidate_tool: null,
        last_completed_tool: null,
      });
    }

    if (state !== lastState) {
      log(`State: STOPPED (${adapter.displayName} not running in tmux session)`);
    }

    // Check for user message signal — clears auth suppression for immediate retry.
    maybeConsumeUserMessageSignal(currentTime);

    // Delegate restart permission to HeartbeatEngine (e.g. won't restart during rate_limited).
    // Counter mutations (consecutiveRestarts, startupGrace, notRunningCount) are handled
    // inside startAgent() after auth check passes — not here.
    const restartDelay = Math.min(BASE_RESTART_DELAY * Math.pow(2, consecutiveRestarts), MAX_RESTART_DELAY);
    if (engine.canRestart() && notRunningCount >= restartDelay) {
      if (Date.now() < authRetrySuppressedUntil) {
        if (notRunningCount % 60 === 0) log(`Guardian: auth retry suppressed for ${Math.ceil((authRetrySuppressedUntil - Date.now()) / 1000)}s`);
      } else {
        log(`Guardian: Agent not running for ${notRunningCount}s, attempting to start ${adapter.displayName}...`);
        startAgent();
      }
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

  const currentTmuxClaudePid = adapter.runtimeId === 'claude'
    ? getTmuxClaudePid(adapter.sessionName)
    : 0;
  const interactiveState = adapter.runtimeId === 'claude'
    ? readTmuxInputState({ sessionName: adapter.sessionName })
    : null;

  let apiActivity = null;
  let foregroundIdentity = null;
  let watchdogStatus = { watchdog_phase: 'idle', watchdog_block_reason: null };

  if (adapter.runtimeId === 'claude') {
    const toolNowMs = Date.now();
    processToolLifecycle(toolNowMs, currentTmuxClaudePid, interactiveState);
    foregroundIdentity = resolveTrustedForegroundIdentity(currentTmuxClaudePid);
    apiActivity = buildApiActivity(foregroundIdentity, currentTmuxClaudePid);
    watchdogStatus = evaluateToolWatchdog({
      nowMs: toolNowMs,
      foregroundIdentity,
      apiActivity,
      interactiveState
    });
    if (watchdogStatus.api_activity_dirty) {
      apiActivity = buildApiActivity(foregroundIdentity, currentTmuxClaudePid);
    }
    writeSessionToolState(foregroundIdentity, foregroundIdentity?.trusted ? foregroundIdentity.sessionId : null);
    writeApiActivitySnapshot(apiActivity);
    maybeRotateToolEventStream(toolNowMs, foregroundIdentity?.trusted ? foregroundIdentity.sessionId : null);
  }

  const apiUpdatedSec = apiActivity?.updated_at ? Math.floor(apiActivity.updated_at / 1000) : 0;
  const activeTools = apiActivity?.active_tools ?? 0;
  const thinking = apiActivity?.active === true || activeTools > 0;

  // Hook freshness: if api-activity.json hasn't been updated in 60s, treat active_tools
  // as stale. Prevents stale hook state from driving destructive ProcSampler restarts
  // and also gates heartbeat auto-ack in the dispatcher (via proc-state.json).
  const hookFresh = apiUpdatedSec > 0 && (currentTime - apiUpdatedSec) < 60;
  const confirmedActive = activeTools > 0 && hookFresh;

  // /proc context-switch sampling: tick every loop iteration (internally gated to 10s).
  // Only counts frozen time when agent has confirmed active tools (fresh hook + active_tools > 0),
  // since an idle agent naturally has zero context switches.
  procSampler.tick(currentTime, { isActive: confirmedActive });
  if (procSampler.isFrozen()) {
    log(`Guardian: Process frozen (0 ctx_switch delta for ${procSampler.getState().frozenCount}s while active_tools > 0), killing session`);
    adapter.stop();
    procSampler.reset();
    // Guardian will detect offline on next tick and call startAgent().
    lastState = 'frozen';
    return;
  }

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
    source,
    runtime_launch_at: runtimeLaunchAtMs,
    active_tool_name: apiActivity?.watchdog_candidate_tool?.name || apiActivity?.oldest_active_tool?.name || null,
    active_tool_running_seconds: apiActivity?.watchdog_candidate_tool?.started_at
      ? Math.max(0, Math.floor((Date.now() - apiActivity.watchdog_candidate_tool.started_at) / 1000))
      : (apiActivity?.oldest_active_tool?.started_at
          ? Math.max(0, Math.floor((Date.now() - apiActivity.oldest_active_tool.started_at) / 1000))
          : 0),
    active_tool_summary: apiActivity?.watchdog_candidate_tool?.summary || apiActivity?.oldest_active_tool?.summary || null,
    active_tool_rule_id: apiActivity?.watchdog_candidate_tool?.rule_id || null,
    active_tool_session_id: apiActivity?.sessionId || null,
    watchdog_episode_key: watchdogState?.episode_key || null,
    watchdog_phase: watchdogStatus.watchdog_phase,
    watchdog_last_action_at: watchdogState?.last_action_at || null,
    watchdog_block_reason: watchdogStatus.watchdog_block_reason,
    foreground_session_source: foregroundIdentity?.source || null,
    foreground_session_observed_at: foregroundIdentity?.observedAt || 0,
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
    maybeConsumeUserMessageSignal(currentTime);
  }

  // Periodic probe: 30-min end-to-end health check. Complementary to ProcSampler:
  // ProcSampler detects frozen processes, periodic probe catches functional failures
  // (API errors, auth expired, stuck prompts) where the process is alive but broken.
  // Gated by heartbeatEnabled — disabled by default (same config as primary heartbeat).
  // Skip during launch grace period — new sessions need time to initialize hooks/CLAUDE.md
  // before they can respond to heartbeats.
  if (engine.heartbeatEnabled && engine.health === 'ok') {
    const withinGracePeriod = lastLaunchAt > 0 && (currentTime - lastLaunchAt) < LAUNCH_GRACE_PERIOD;
    if (!withinGracePeriod && activeTools === 0 && (currentTime - lastPeriodicProbeAt) >= PERIODIC_PROBE_INTERVAL) {
      const ok = engine.requestImmediateProbe('periodic_30min');
      if (ok) lastPeriodicProbeAt = currentTime;
    }
  }

  // Proactive API error scan: detect fatal API errors (e.g. 400 from corrupted image)
  // in the tmux pane independently of heartbeat state. Requires 2 consecutive detections
  // (30s apart) to avoid false positives from conversation content mentioning API errors.
  // Skipped during launch grace period (session still initializing).
  if (engine.health === 'ok' && engine.deps.detectApiError) {
    const withinGrace = lastLaunchAt > 0 && (currentTime - lastLaunchAt) < LAUNCH_GRACE_PERIOD;
    if (!withinGrace && (currentTime - lastApiErrorScanAt) >= API_ERROR_SCAN_INTERVAL) {
      lastApiErrorScanAt = currentTime;
      const apiError = engine.deps.detectApiError();
      if (apiError.detected) {
        apiErrorConsecutiveHits++;
        if (apiErrorConsecutiveHits >= 2) {
          log(`Proactive API error scan: "${apiError.pattern}" detected ${apiErrorConsecutiveHits} consecutive times. Killing session for restart.`);
          adapter.stop();
          apiErrorConsecutiveHits = 0;
        } else {
          log(`Proactive API error scan: "${apiError.pattern}" detected (${apiErrorConsecutiveHits}/2, confirming on next scan)`);
        }
      } else {
        apiErrorConsecutiveHits = 0;
      }
    }
  }

  engine.processHeartbeat(true, currentTime);
  maybeEnqueueHealthCheck(true, currentTime);
  if (engine.health === 'ok') {
    if (readConfigBool('daily_upgrade_enabled', false)) {
      upgradeScheduler.maybeTrigger();
    }
    upgradeCheckScheduler.maybeTrigger();
  }
  memoryCommitScheduler.maybeTrigger();
  if (engine.health === 'ok') {
    maybeCheckUsage(state, idleSeconds, currentTime, apiActivity);
  }
  lastState = state;
}

function init() {
  // Strip stale TMUX env var — PM2 dump can carry over the old tmux session
  // reference from before a reboot, causing child tmux commands to fail with
  // "error creating /tmp/tmux-<uid>/default (No such file or directory)".
  delete process.env.TMUX;

  if (!fs.existsSync(MONITOR_DIR)) {
    fs.mkdirSync(MONITOR_DIR, { recursive: true });
  }

  // Load the active runtime adapter (claude or codex, from config.json)
  adapter = getActiveAdapter();
  const config = readConfigObject();
  const heartbeatEnabled = isRuntimeHeartbeatEnabled({ runtimeId: adapter.runtimeId, config });
  toolRules = getToolRules({ runtimeId: adapter.runtimeId, config });
  resetToolLifecycleRuntimeState();
  watchdogState = readJsonFileSafe(TOOL_WATCHDOG_STATE_FILE);

  // Initialize ProcSampler for frozen-process detection via context-switch sampling.
  // sessionName comes from the adapter (claude-main or codex-main).
  procSampler = new ProcSampler({ sessionName: adapter.sessionName, log });

  const initialStatus = loadInitialHealth();
  const initialHealth = initialStatus.health;
  runtimeLaunchAtMs = Number(initialStatus.runtime_launch_at) || Date.now();

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
    heartbeatEnabled,
    heartbeatInterval: HEARTBEAT_INTERVAL,
    downDegradeThreshold: DOWN_DEGRADE_THRESHOLD,
    downRetryInterval: DOWN_RETRY_INTERVAL,
    signalGracePeriod: SIGNAL_GRACE_PERIOD,
    rateLimitDefaultCooldown: RATE_LIMIT_DEFAULT_COOLDOWN,
    userMessageRecoveryCooldown: USER_MESSAGE_RECOVERY_COOLDOWN
  });

  if (!heartbeatEnabled && adapter.runtimeId === 'codex') {
    log('Heartbeat: disabled for codex (set `zylos config set codex_heartbeat_enabled true` to re-enable)');
  }

  // Rehydrate rate-limit state from persisted status file on PM2 restart
  if (initialHealth === 'rate_limited' && initialStatus.cooldown_until) {
    engine.cooldownUntil = initialStatus.cooldown_until;
    engine.rateLimitResetTime = initialStatus.rate_limit_reset || '';
  }

  const dailyUpgradeEnabled = readConfigBool('daily_upgrade_enabled', false);
  if (!dailyUpgradeEnabled) {
    log('Daily upgrade: disabled (set `zylos config set daily_upgrade_enabled true` to enable)');
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
  const usageState = loadUsageState();
  lastUsageCheckAt = getInitialUsageCheckAt({
    runtimeId: adapter.runtimeId,
    usageState,
    nowEpoch: Math.floor(Date.now() / 1000)
  });
  log(`Usage monitor (${adapter.runtimeId}): enabled=${USAGE_MONITOR_ENABLED}`);

  // Start context monitor if the adapter provides one (Codex polling-based monitor).
  // Claude uses the statusLine hook instead — no adapter-provided monitor.
  contextMonitor = adapter.getContextMonitor?.() ?? null;
  if (contextMonitor) {
    contextMonitor.startPolling({
      intervalMs: 30_000,
      onExceed: async ({ used, ceiling, ratio }) => {
        const pct = Math.round(ratio * 100);
        log(`Context at ${pct}% (${used}/${ceiling}), requesting new-session handoff`);
        enqueueContextRotationHandoff({ ratio, used, ceiling });
      },
      onEarlyThreshold: async ({ used, ceiling, ratio }) => {
        const pct = Math.round(ratio * 100);
        const thresholdPct = Math.round(contextMonitor.threshold * 100);
        // Cooldown: prevent re-inject while sync is still running
        const now = Math.floor(Date.now() / 1000);
        if ((now - lastMemorySyncTriggerAt) < MEMORY_SYNC_COOLDOWN_SECONDS) {
          return;
        }
        const unsummarizedCount = getUnsummarizedCount();
        if (unsummarizedCount <= CHECKPOINT_THRESHOLD) {
          log(`Early memory sync skipped at ${pct}%: unsummarized=${unsummarizedCount} <= ${CHECKPOINT_THRESHOLD}`);
          return;
        }
        log(`Context at ${pct}% (approaching ${thresholdPct}% threshold), triggering early memory sync (unsummarized=${unsummarizedCount})`);
        try {
          execFileSync('node', [C4_CONTROL_PATH, 'enqueue',
            '--content', `Context usage at ${pct}% (approaching ${thresholdPct}% session-switch threshold). Run Memory Sync now as a background task so it completes before the session switch. Launch a background subagent for memory sync following ~/zylos/.claude/skills/zylos-memory/SKILL.md. Do NOT wait for completion — continue normal work.`,
            '--priority', '2',
            '--no-ack-suffix'
          ], { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 });
          lastMemorySyncTriggerAt = now;
          log(`Early memory sync enqueued at ${pct}%`);
        } catch (err) {
          log(`Failed to enqueue early memory sync: ${err.message}`);
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
      execSync(`tmux kill-session -t "${OTHER_SESSION}" 2>/dev/null`, { stdio: 'pipe', timeout: 3000 });
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
log(`=== Activity Monitor Started (v25 - RuntimeAdapter: ${adapter.displayName} | Guardian + Heartbeat v4 + ProcSampler + LiveAuth + DailyTasks + UpgradeCheck + UsageMonitor): ${new Date().toISOString()} tz=${timezone} ===`);

// Use self-scheduling loop instead of setInterval to prevent concurrent
// invocations: async monitorLoop + setInterval can overlap if isRunning()
// takes >INTERVAL ms (e.g., under high system load), causing state variable races.
(async function scheduleLoop() {
  await monitorLoop().catch(err => log(`Monitor loop error: ${err.message}`));
  setTimeout(scheduleLoop, INTERVAL);
})();
