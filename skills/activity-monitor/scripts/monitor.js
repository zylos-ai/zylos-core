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
 *   - context rotation notify (node c4-send.js): 15000ms
 *   - SQLite COUNT query in maybeCheckUsage(): 3000ms
 *
 * v22 changes (service recovery — auth + periodic probe):
 *   - checkAuth() in ClaudeAdapter/CodexAdapter is now a live probe (CLI subprocess / HTTP)
 *     instead of local file checks — detects revoked/expired tokens
 *   - startAgent() notifies owner (via C4 control enqueue) when auth fails, rate-limited to
 *     1 notification per hour to avoid spam
 *   - Replaced stuck detection (indirect activity signals → 300s threshold → probe) with
 *     a fixed 5-min periodic probe gated on active_tools === 0 (busy = hook counter > 0)
 *   - Later AM v3 Guardian separation removed health-state restart gating entirely:
 *     Guardian handles process liveness, HealthEngine handles functional liveness
 *
 * v21 changes (multi-runtime support — #311):
 *   - RuntimeAdapter abstraction: getActiveAdapter() reads runtime from config.json
 *   - Replaced startClaude/killTmuxSession/isClaudeRunning/sendToTmux/isClaudeLoggedIn
 *     with adapter.launch/stop/isRunning/sendMessage/checkAuth
 *   - HealthEngine deps now merged from adapter.getHeartbeatDeps() (probe) + fixed deps
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
import net from 'net';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { MessageRouter } from './message-router.js';
import { MonitorOrchestrator } from './monitor-orchestrator.js';
import { canTreatPaneAsRecovered } from './tool-pipeline.js';
import { readInitialStatus, writeStatus } from './status-writer.js';
import {
  createGuardian as createRuntimeGuardian,
  createHealthEngine as createRuntimeHealthEngine,
  createProcSampler as createRuntimeProcSampler,
  createToolPipeline as createRuntimeToolPipeline,
  createUsageMonitor as createRuntimeUsageMonitor,
  scheduleStaleRuntimeCleanup as scheduleRuntimeStaleCleanup,
  startContextMonitor as startRuntimeContextMonitor,
} from './adapters/runtime-components.js';
import { createActivityMonitorTaskScheduler } from './tasks/activity-monitor-tasks.js';
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
const AM_SOCKET_FILE = path.join(MONITOR_DIR, 'am.sock');
const MESSAGE_ROUTER_CACHE_FILE = path.join(MONITOR_DIR, 'message-router-probe-cache.json');
const STATUSLINE_FILE = path.join(MONITOR_DIR, 'statusline.json');
const LOG_FILE = path.join(MONITOR_DIR, 'activity.log');
const HEALTH_CHECK_STATE_FILE = path.join(MONITOR_DIR, 'health-check-state.json');
const DAILY_UPGRADE_STATE_FILE = path.join(MONITOR_DIR, 'daily-upgrade-state.json');
const DAILY_MEMORY_COMMIT_STATE_FILE = path.join(MONITOR_DIR, 'daily-memory-commit-state.json');
const UPGRADE_CHECK_STATE_FILE = path.join(MONITOR_DIR, 'upgrade-check-state.json');
const USAGE_STATE_FILE = path.join(MONITOR_DIR, 'usage.json');
const USAGE_CODEX_STATE_FILE = path.join(MONITOR_DIR, 'usage-codex.json');
const USAGE_ALERT_STATE_FILE = path.join(MONITOR_DIR, 'usage-alert-state.json');

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
const RATE_LIMIT_DEFAULT_COOLDOWN = 3600;  // 1 hour default when reset time can't be parsed
const USER_MESSAGE_RECOVERY_COOLDOWN = 60; // 1 min between user-message-triggered recoveries

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

const USAGE_MONITOR_ENABLED = readConfigBool('usage_monitor_enabled', true);
const USAGE_CHECK_INTERVAL = readConfigInt('usage_check_interval', 3600);     // seconds between checks (default 1 hour)
const USAGE_IDLE_GATE = readConfigInt('usage_idle_gate', 30);                 // idle seconds required (default 30)
const USAGE_ALERT_ENABLED = readConfigBool('usage_alert_enabled', false);
const USAGE_ALERT_INTERVAL = readConfigInt('usage_alert_interval', 3600);
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
let lastState = '';
let idleSince = 0;
let runtimeLaunchAtMs = 0;
let watchdogState = null;

let adapter;         // initialized in init() via getActiveAdapter()
let engine;          // initialized in init()
let toolPipeline;    // initialized in init()
let orchestrator;    // initialized in init()
let messageRouterServer; // initialized in init()
let contextMonitor;  // initialized in init() if adapter provides one (Codex only)

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

function loadInitialHealth() {
  return readInitialStatus({ statusFile: STATUS_FILE });
}

function atomicWriteJson(filePath, value) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function writeStatusFile(statusObj) {
  writeStatus({ statusFile: STATUS_FILE, statusObj, healthEngine: engine });
}

function buildNotRunningStatus({
  state,
  currentTime,
  currentTimeHuman,
  guardianResult,
  runtimeLaunchAtMsValue,
}) {
  return {
    state,
    since: currentTime,
    last_check: currentTime,
    last_check_human: currentTimeHuman,
    idle_seconds: 0,
    not_running_seconds: guardianResult.notRunningSeconds,
    message: guardianResult.message,
    runtime_launch_at: runtimeLaunchAtMsValue,
  };
}

function getActiveToolDetails(apiActivity) {
  const activeTool = apiActivity?.watchdog_candidate_tool || apiActivity?.oldest_active_tool || null;
  const startedAt = activeTool?.started_at || 0;

  return {
    active_tool_name: activeTool?.name || null,
    active_tool_running_seconds: startedAt
      ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
      : 0,
    active_tool_summary: activeTool?.summary || null,
    active_tool_rule_id: apiActivity?.watchdog_candidate_tool?.rule_id || null,
  };
}

function buildRunningStatus({
  state,
  thinking,
  activity,
  apiUpdatedSec,
  activeTools,
  currentTime,
  currentTimeHuman,
  idleSeconds,
  inactiveSeconds,
  source,
  runtimeLaunchAtMsValue,
  apiActivity,
  watchdogStatus,
  foregroundIdentity,
}) {
  return {
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
    runtime_launch_at: runtimeLaunchAtMsValue,
    ...getActiveToolDetails(apiActivity),
    active_tool_session_id: apiActivity?.sessionId || null,
    watchdog_episode_key: watchdogState?.episode_key || null,
    watchdog_phase: watchdogStatus.watchdog_phase,
    watchdog_last_action_at: watchdogState?.last_action_at || null,
    watchdog_block_reason: watchdogStatus.watchdog_block_reason,
    foreground_session_source: foregroundIdentity?.source || null,
    foreground_session_observed_at: foregroundIdentity?.observedAt || 0,
  };
}

function startMessageRouterServer(activeEngine) {
  const router = new MessageRouter({
    healthEngine: activeEngine,
    cacheFile: MESSAGE_ROUTER_CACHE_FILE,
    log
  });

  try {
    fs.rmSync(AM_SOCKET_FILE, { force: true });
  } catch { /* best-effort */ }

  messageRouterServer = net.createServer((socket) => {
    let data = '';
    socket.on('data', async (chunk) => {
      data += chunk;
      const newlineIndex = data.indexOf('\n');
      if (newlineIndex === -1) return;

      const raw = data.slice(0, newlineIndex);
      data = data.slice(newlineIndex + 1);
      try {
        const request = JSON.parse(raw);
        if (request.type === 'notify_delivered') {
          activeEngine.onUserMessageDelivered().catch((err) => {
            log(`HealthEngine onUserMessageDelivered error: ${err.message}`);
          });
          socket.end(`${JSON.stringify({ version: 1, type: 'ack', requestId: request.requestId })}\n`);
          return;
        }
        if (request.type !== 'route') {
          throw new Error(`unsupported request type: ${request.type}`);
        }
        const decision = await router.route(request);
        socket.end(`${JSON.stringify(decision)}\n`);
      } catch (err) {
        socket.end(`${JSON.stringify({
          version: 1,
          recovered: false,
          health: 'unavailable',
          reason: 'message_router_error',
          userMessage: '我现在暂时不可用，正在尝试恢复。请稍后再发一次。',
          error: err.message
        })}\n`);
      }
    });
  });

  messageRouterServer.on('error', (err) => {
    log(`MessageRouter IPC server error: ${err.message}`);
  });

  messageRouterServer.listen(AM_SOCKET_FILE, () => {
    log(`MessageRouter IPC server listening at ${AM_SOCKET_FILE}`);
  });
}

function stopMessageRouterServer() {
  try {
    messageRouterServer?.close();
  } catch { /* best-effort */ }
  try {
    fs.rmSync(AM_SOCKET_FILE, { force: true });
  } catch { /* best-effort */ }
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

function clearWatchdogState() {
  if (!watchdogState) return;
  watchdogState = null;
  writeWatchdogState();
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

function createUsageMonitor(activeAdapter) {
  return createRuntimeUsageMonitor(activeAdapter, {
    zylosDir: ZYLOS_DIR,
    statuslineFile: STATUSLINE_FILE,
    usageStateFile: USAGE_STATE_FILE,
    usageCodexStateFile: USAGE_CODEX_STATE_FILE,
    usageAlertStateFile: USAGE_ALERT_STATE_FILE,
    monitorEnabled: USAGE_MONITOR_ENABLED,
    alertEnabled: USAGE_ALERT_ENABLED,
    checkIntervalSec: USAGE_CHECK_INTERVAL,
    idleGateSec: USAGE_IDLE_GATE,
    warnThreshold: USAGE_WARN_THRESHOLD,
    highThreshold: USAGE_HIGH_THRESHOLD,
    criticalThreshold: USAGE_CRITICAL_THRESHOLD,
    notifyCooldownSec: USAGE_NOTIFY_COOLDOWN,
    activeHoursStart: USAGE_ACTIVE_HOURS_START,
    activeHoursEnd: USAGE_ACTIVE_HOURS_END,
    getLocalHour,
    runC4Control,
    log,
  });
}

function createTaskScheduler(activeUsageMonitor) {
  return createActivityMonitorTaskScheduler({
    usageMonitor: activeUsageMonitor,
    dailyUpgradeHour: DAILY_UPGRADE_HOUR,
    dailyMemoryCommitHour: DAILY_MEMORY_COMMIT_HOUR,
    dailyUpgradeCheckHour: DAILY_UPGRADE_CHECK_HOUR,
    healthCheckInterval: HEALTH_CHECK_INTERVAL,
    usageCheckInterval: USAGE_CHECK_INTERVAL,
    usageAlertInterval: USAGE_ALERT_INTERVAL,
    readDailyUpgradeEnabled: () => readConfigBool('daily_upgrade_enabled', false),
    loadDailyUpgradeState,
    writeDailyUpgradeState,
    enqueueDailyUpgradeControl,
    loadMemoryCommitState,
    writeMemoryCommitState,
    executeDailyMemoryCommit,
    loadUpgradeCheckState,
    writeUpgradeCheckState,
    executeUpgradeCheck,
    loadHealthCheckState,
    enqueueHealthCheck,
    getLocalHour,
    getLocalDate,
    nowEpoch: () => Math.floor(Date.now() / 1000),
    log,
  });
}

function startContextMonitor(activeAdapter) {
  return startRuntimeContextMonitor(activeAdapter, {
    getUnsummarizedCount,
    checkpointThreshold: CHECKPOINT_THRESHOLD,
    getLastMemorySyncTriggerAt: () => lastMemorySyncTriggerAt,
    setLastMemorySyncTriggerAt: (nextValue) => {
      lastMemorySyncTriggerAt = nextValue;
    },
    memorySyncCooldownSeconds: MEMORY_SYNC_COOLDOWN_SECONDS,
    c4ControlPath: C4_CONTROL_PATH,
    enqueueContextRotationHandoff,
    log,
  });
}

function scheduleStaleRuntimeCleanup(activeAdapter) {
  scheduleRuntimeStaleCleanup(activeAdapter, { log });
}

function createToolPipeline(activeAdapter, config) {
  return createRuntimeToolPipeline(activeAdapter, config, {
    files: {
      toolEvents: TOOL_EVENTS_FILE,
      toolEventStreamState: TOOL_EVENT_STREAM_STATE_FILE,
      sessionToolState: SESSION_TOOL_STATE_FILE,
      apiActivity: API_ACTIVITY_FILE,
      foregroundSession: FOREGROUND_SESSION_FILE,
      statusline: STATUSLINE_FILE,
    },
    getRuntimeLaunchAtMs: () => runtimeLaunchAtMs,
    isPidAlive,
    log,
  });
}

function createHealthEngine(activeAdapter, initialStatus) {
  return createRuntimeHealthEngine(activeAdapter, initialStatus, {
    log,
    rateLimitDefaultCooldown: RATE_LIMIT_DEFAULT_COOLDOWN,
    userMessageRecoveryCooldown: USER_MESSAGE_RECOVERY_COOLDOWN,
  });
}

function createGuardian(activeAdapter, activeToolPipeline, initialRuntimeLaunchAtMs) {
  return createRuntimeGuardian(activeAdapter, activeToolPipeline, initialRuntimeLaunchAtMs, {
    apiActivityFile: API_ACTIVITY_FILE,
    hookStateFile: HOOK_STATE_FILE,
    log,
  });
}

async function monitorLoop() {
  const currentTime = Math.floor(Date.now() / 1000);
  const currentTimeHuman = new Date().toISOString().replace('T', ' ').substring(0, 19);

  const tickState = await orchestrator.handleMonitorTick({
    currentTime,
    currentTimeHuman,
    nowMs: Date.now(),
    state: {
      runtimeLaunchAtMs,
      lastState,
      idleSince,
      watchdogState,
    },
    idleThreshold: IDLE_THRESHOLD,
    checkDailyTruncate,
    buildNotRunningStatus,
    buildRunningStatus,
    writeStatusFile,
    clearWatchdogState,
    writeWatchdogState: (nextWatchdogState) => {
      watchdogState = nextWatchdogState;
      writeWatchdogState();
    },
    getConversationFileModTime,
    getTmuxActivity,
    getTmuxClaudePid,
    readTmuxInputState,
    canTreatPaneAsRecovered,
    runC4Control,
  });
  runtimeLaunchAtMs = tickState.runtimeLaunchAtMs;
  lastState = tickState.lastState;
  idleSince = tickState.idleSince;
  watchdogState = tickState.watchdogState;
}

function init() {
  orchestrator = new MonitorOrchestrator({
    env: process.env,
    monitorDir: MONITOR_DIR,
    getActiveAdapter,
    readConfigObject,
    createToolPipeline,
    readWatchdogState: () => readJsonFileSafe(TOOL_WATCHDOG_STATE_FILE),
    createProcSampler: (activeAdapter) => createRuntimeProcSampler(activeAdapter, { log }),
    loadInitialHealth,
    createHealthEngine,
    createGuardian,
    startMessageRouterServer,
    readDailyUpgradeEnabled: () => readConfigBool('daily_upgrade_enabled', false),
    createUsageMonitor,
    createTaskScheduler,
    initializeUsageMonitor: (activeUsageMonitor, activeAdapter) => {
      activeUsageMonitor.lastUsageCheckAt = activeUsageMonitor.initializeLastCheckAt(Math.floor(Date.now() / 1000));
      log(`Usage monitor (${activeAdapter.runtimeId}): enabled=${USAGE_MONITOR_ENABLED}`);
      log(`Usage alert (${activeAdapter.runtimeId}): enabled=${USAGE_ALERT_ENABLED}`);
    },
    startContextMonitor,
    scheduleStaleRuntimeCleanup,
    log,
  });

  ({
    adapter,
    toolPipeline,
    watchdogState,
    runtimeLaunchAtMs,
    engine,
    contextMonitor,
  } = orchestrator.start());
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

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    engine?.destroy();
    stopMessageRouterServer();
    process.exit(0);
  });
}

// Use self-scheduling loop instead of setInterval to prevent concurrent
// invocations: async monitorLoop + setInterval can overlap if isRunning()
// takes >INTERVAL ms (e.g., under high system load), causing state variable races.
(async function scheduleLoop() {
  await monitorLoop().catch(err => log(`Monitor loop error: ${err.message}`));
  setTimeout(scheduleLoop, INTERVAL);
})();
