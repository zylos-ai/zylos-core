#!/usr/bin/env node
/**
 * Activity Monitor v9 - Guardian + Heartbeat + Health Check + Daily Tasks
 * Run with PM2: pm2 start activity-monitor.js --name activity-monitor
 */

import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { HeartbeatEngine } from './heartbeat-engine.js';
import { DailySchedule } from './daily-schedule.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Core runtime config
const SESSION = 'claude-main';
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const MONITOR_DIR = path.join(ZYLOS_DIR, 'activity-monitor');
const STATUS_FILE = path.join(MONITOR_DIR, 'claude-status.json');
const LOG_FILE = path.join(MONITOR_DIR, 'activity.log');
const HEARTBEAT_PENDING_FILE = path.join(MONITOR_DIR, 'heartbeat-pending.json');
const HEALTH_CHECK_STATE_FILE = path.join(MONITOR_DIR, 'health-check-state.json');
const DAILY_UPGRADE_STATE_FILE = path.join(MONITOR_DIR, 'daily-upgrade-state.json');
const DAILY_MEMORY_COMMIT_STATE_FILE = path.join(MONITOR_DIR, 'daily-memory-commit-state.json');
const CONTEXT_CHECK_STATE_FILE = path.join(MONITOR_DIR, 'context-check-state.json');
const PENDING_CHANNELS_FILE = path.join(MONITOR_DIR, 'pending-channels.jsonl');

// Claude binary - relies on PATH from PM2 ecosystem.config.js
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const BYPASS_PERMISSIONS = process.env.CLAUDE_BYPASS_PERMISSIONS !== 'false';

// Conversation directory - auto-detect based on working directory
const ZYLOS_PATH = ZYLOS_DIR.replace(/\//g, '-');
const CONV_DIR = path.join(os.homedir(), '.claude', 'projects', ZYLOS_PATH);

// Activity monitor cadence
const INTERVAL = 1000;
const IDLE_THRESHOLD = 3;
const LOG_MAX_LINES = 500;
const RESTART_DELAY = 5;

// Heartbeat liveness config
const HEARTBEAT_INTERVAL = 1800;     // 30 min
const ACK_DEADLINE = 300;            // 5 min
const MAX_RESTART_FAILURES = 3;

// Health check config
const HEALTH_CHECK_INTERVAL = 21600; // 6 hours

// Context check config
const CONTEXT_CHECK_INTERVAL = 3600; // 1 hour

// Daily tasks config
const DAILY_UPGRADE_HOUR = 5;        // 5:00 AM local time
const DAILY_MEMORY_COMMIT_HOUR = 3;  // 3:00 AM local time
const DAILY_COMMIT_SCRIPT = path.join(__dirname, '..', '..', 'zylos-memory', 'scripts', 'daily-commit.js');

// State
let lastTruncateDay = '';
let notRunningCount = 0;
let lastState = '';
let startupGrace = 0;
let idleSince = 0;

let engine; // initialized in init()

// Timezone: reuse scheduler's tz.js (.env TZ → process.env.TZ → UTC)
import { loadTimezone } from '../../scheduler/scripts/tz.js';

const timezone = loadTimezone();

function getLocalHour() {
  return parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false })
      .format(new Date()),
    10
  );
}

function getLocalDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `[${timestamp}] ${message}\n`;
  if (!fs.existsSync(MONITOR_DIR)) {
    fs.mkdirSync(MONITOR_DIR, { recursive: true });
  }
  fs.appendFileSync(LOG_FILE, line);
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
    execSync(`tmux has-session -t "${SESSION}" 2>/dev/null`, { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

function killTmuxSession() {
  try {
    execSync(`tmux kill-session -t "${SESSION}" 2>/dev/null`);
    log('Heartbeat recovery: killed tmux session');
  } catch {
    log('Heartbeat recovery: tmux session kill skipped (already missing)');
  }
}

function getTmuxPanePid() {
  try {
    return execSync(`tmux list-panes -t "${SESSION}" -F '#{pane_pid}' 2>/dev/null | head -1`, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function isClaudeRunning() {
  const panePid = getTmuxPanePid();
  if (!panePid) return false;

  try {
    const procName = execSync(`ps -p ${panePid} -o comm= 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (procName === 'claude') return true;
  } catch { }

  try {
    execSync(`pgrep -P ${panePid} -f "claude" > /dev/null 2>&1`);
    return true;
  } catch {
    return false;
  }
}

function sendToTmux(text) {
  const msgId = `${Date.now()}-${process.pid}`;
  const tempFile = `/tmp/monitor-msg-${msgId}.txt`;
  const bufferName = `monitor-${msgId}`;

  try {
    fs.writeFileSync(tempFile, text);
    execSync(`tmux load-buffer -b "${bufferName}" "${tempFile}" 2>/dev/null`);
    execSync('sleep 0.1');
    execSync(`tmux paste-buffer -b "${bufferName}" -t "${SESSION}" 2>/dev/null`);
    execSync('sleep 0.2');
    execSync(`tmux send-keys -t "${SESSION}" Enter 2>/dev/null`);
    execSync(`tmux delete-buffer -b "${bufferName}" 2>/dev/null`);
    fs.unlinkSync(tempFile);
  } catch {
    // Best-effort.
  }
}

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
function hasStartupHook() {
  try {
    const settingsPath = path.join(ZYLOS_DIR, '.claude', 'settings.json');
    const content = fs.readFileSync(settingsPath, 'utf8');
    return content.includes('session-start-prompt.js');
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

function startClaude() {
  if (isMaintenanceRunning()) {
    log('Guardian: Maintenance script detected, waiting for completion...');
    waitForMaintenance();
  }

  log('Guardian: Starting Claude Code...');

  try {
    fs.unlinkSync('/tmp/context-alert-cooldown');
  } catch { }
  try {
    fs.unlinkSync('/tmp/context-compact-scheduled');
  } catch { }

  const bypassFlag = BYPASS_PERMISSIONS ? ' --dangerously-skip-permissions' : '';

  if (tmuxHasSession()) {
    sendToTmux(`cd ${ZYLOS_DIR}; ${CLAUDE_BIN}${bypassFlag}`);
    log('Guardian: Started Claude in existing tmux session');
  } else {
    try {
      execSync(`tmux new-session -d -s "${SESSION}" "cd ${ZYLOS_DIR} && ${CLAUDE_BIN}${bypassFlag}"`);
      log('Guardian: Created new tmux session and started Claude');
    } catch (err) {
      log(`Guardian: Failed to create tmux session: ${err.message}`);
    }
  }

  // Use session start hook if available, otherwise fall back to C4 control
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
    if (!fs.existsSync(STATUS_FILE)) return 'ok';
    const status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    if (status && typeof status.health === 'string') {
      return status.health;
    }
  } catch { }
  return 'ok';
}

function writeStatusFile(statusObj) {
  try {
    ensureStatusDir();
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...statusObj, health: engine.health }, null, 2));
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
    const output = execSync(`tmux list-windows -t "${SESSION}" -F '#{window_activity}' 2>/dev/null`, { encoding: 'utf8' });
    return parseInt(output.trim(), 10);
  } catch {
    return null;
  }
}

function readHeartbeatPending() {
  try {
    if (!fs.existsSync(HEARTBEAT_PENDING_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(HEARTBEAT_PENDING_FILE, 'utf8'));
    if (parsed && Number.isInteger(parsed.control_id)) {
      return parsed;
    }
  } catch (err) {
    log(`Heartbeat: failed to read pending file (${err.message})`);
  }
  return null;
}

function writeHeartbeatPending(record) {
  if (!fs.existsSync(MONITOR_DIR)) {
    fs.mkdirSync(MONITOR_DIR, { recursive: true });
  }
  fs.writeFileSync(HEARTBEAT_PENDING_FILE, JSON.stringify(record, null, 2));
}

function clearHeartbeatPending() {
  try {
    fs.unlinkSync(HEARTBEAT_PENDING_FILE);
  } catch { }
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

function enqueueHeartbeat(phase) {
  const content = 'Heartbeat check.';
  const result = runC4Control([
    'enqueue',
    '--content', content,
    '--priority', '0',
    '--bypass-state',
    '--ack-deadline', String(ACK_DEADLINE)
  ]);

  if (!result.ok) {
    log(`Heartbeat enqueue failed (${phase}): ${result.output}`);
    return false;
  }

  const match = result.output.match(/control\s+(\d+)/i);
  if (!match) {
    log(`Heartbeat enqueue parse failed (${phase}): ${result.output}`);
    return false;
  }

  const controlId = parseInt(match[1], 10);
  writeHeartbeatPending({
    control_id: controlId,
    phase,
    created_at: Math.floor(Date.now() / 1000)
  });
  log(`Heartbeat enqueued id=${controlId} phase=${phase}`);
  return true;
}

function getHeartbeatStatus(controlId) {
  const result = runC4Control(['get', '--id', String(controlId)]);
  if (!result.ok) {
    if (result.output.toLowerCase().includes('not found')) {
      return 'not_found';
    }
    log(`Heartbeat status query failed for ${controlId}: ${result.output}`);
    return 'error';
  }

  const match = result.output.match(/status=([a-z_]+)/i);
  if (!match) {
    log(`Heartbeat status parse failed for ${controlId}: ${result.output}`);
    return 'error';
  }
  return match[1].toLowerCase();
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

  for (const record of dedup.values()) {
    sendRecoveryNotice(record.channel, record.endpoint);
  }

  try {
    fs.writeFileSync(PENDING_CHANNELS_FILE, '');
  } catch (err) {
    log(`Pending channel cleanup failed: ${err.message}`);
  }

  log(`Recovery notification completed for ${dedup.size} channel(s)`);
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

function maybeEnqueueHealthCheck(claudeRunning, currentTime) {
  if (!claudeRunning) return;
  if (engine.health !== 'ok') return;

  const state = loadHealthCheckState();
  const lastCheckAt = state?.last_check_at ?? 0;

  if ((currentTime - lastCheckAt) >= HEALTH_CHECK_INTERVAL) {
    enqueueHealthCheck();
  }
}

// ---------------------------------------------------------------------------
// Context Check (hourly)
// ---------------------------------------------------------------------------

function loadContextCheckState() {
  try {
    if (!fs.existsSync(CONTEXT_CHECK_STATE_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(CONTEXT_CHECK_STATE_FILE, 'utf8'));
    if (parsed && typeof parsed.last_check_at === 'number') {
      return parsed;
    }
  } catch { }
  return null;
}

function writeContextCheckState(timestamp) {
  try {
    if (!fs.existsSync(MONITOR_DIR)) {
      fs.mkdirSync(MONITOR_DIR, { recursive: true });
    }
    fs.writeFileSync(CONTEXT_CHECK_STATE_FILE, JSON.stringify({
      last_check_at: timestamp,
      last_check_human: new Date(timestamp * 1000).toISOString().replace('T', ' ').substring(0, 19)
    }, null, 2));
  } catch (err) {
    log(`Context check: failed to write state (${err.message})`);
  }
}

function enqueueContextCheck() {
  // Step 1: Check context usage (report only, do not restart)
  const checkContent = 'Context usage check. Use the check-context skill to get current context usage.';
  const checkResult = runC4Control([
    'enqueue',
    '--content', checkContent,
    '--priority', '3',
    '--require-idle',
    '--ack-deadline', '600'
  ]);

  if (!checkResult.ok) {
    log(`Context check enqueue failed: ${checkResult.output}`);
    return false;
  }

  const checkMatch = checkResult.output.match(/control\s+(\d+)/i);
  if (!checkMatch) {
    log(`Context check enqueue parse failed: ${checkResult.output}`);
    return false;
  }

  log(`Context check step 1 enqueued id=${checkMatch[1]}`);

  // Step 2: Act on result (delayed 30s, deadline 630s)
  const actContent = 'If context usage exceeds 70%, use the restart-claude skill to restart. If context is under 70%, just acknowledge.';
  const actResult = runC4Control([
    'enqueue',
    '--content', actContent,
    '--priority', '3',
    '--require-idle',
    '--available-in', '30',
    '--ack-deadline', '630'
  ]);

  if (!actResult.ok) {
    log(`Context act enqueue failed: ${actResult.output}`);
    return false;
  }

  const actMatch = actResult.output.match(/control\s+(\d+)/i);
  log(`Context check step 2 enqueued id=${actMatch?.[1] ?? '?'}`);

  const now = Math.floor(Date.now() / 1000);
  writeContextCheckState(now);
  return true;
}

function maybeEnqueueContextCheck(claudeRunning, currentTime) {
  if (!claudeRunning) return;
  if (engine.health !== 'ok') return;

  const state = loadContextCheckState();
  const lastCheckAt = state?.last_check_at ?? 0;

  if ((currentTime - lastCheckAt) >= CONTEXT_CHECK_INTERVAL) {
    enqueueContextCheck();
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

function monitorLoop() {
  const currentTime = Math.floor(Date.now() / 1000);
  const currentTimeHuman = new Date().toISOString().replace('T', ' ').substring(0, 19);

  checkDailyTruncate();

  if (!tmuxHasSession()) {
    const state = 'offline';
    notRunningCount += 1;

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

    if (notRunningCount >= RESTART_DELAY) {
      log(`Guardian: Session not found for ${notRunningCount}s, starting Claude...`);
      startClaude();
      startupGrace = 30;
      notRunningCount = 0;
    }

    engine.processHeartbeat(false, currentTime);
    maybeEnqueueHealthCheck(false, currentTime);
    maybeEnqueueContextCheck(false, currentTime);
    memoryCommitScheduler.maybeTrigger();
    lastState = state;
    return;
  }

  if (!isClaudeRunning()) {
    if (startupGrace > 0) {
      startupGrace -= 1;
      engine.processHeartbeat(false, currentTime);
      return;
    }

    const state = 'stopped';
    notRunningCount += 1;

    writeStatusFile({
      state,
      since: currentTime,
      last_check: currentTime,
      last_check_human: currentTimeHuman,
      idle_seconds: 0,
      not_running_seconds: notRunningCount,
      message: 'claude not running in tmux'
    });

    if (state !== lastState) {
      log('State: STOPPED (claude not running in tmux session)');
    }

    if (notRunningCount >= RESTART_DELAY) {
      log(`Guardian: Claude not running for ${notRunningCount}s, starting Claude...`);
      startClaude();
      startupGrace = 30;
      notRunningCount = 0;
    }

    engine.processHeartbeat(false, currentTime);
    maybeEnqueueHealthCheck(false, currentTime);
    maybeEnqueueContextCheck(false, currentTime);
    memoryCommitScheduler.maybeTrigger();
    lastState = state;
    return;
  }

  startupGrace = 0;
  notRunningCount = 0;

  let activity = getConversationFileModTime();
  let source = 'conv_file';

  if (!activity) {
    activity = getTmuxActivity();
    source = 'tmux_activity';
  }

  if (!activity) {
    activity = currentTime;
    source = 'default';
  }

  const inactiveSeconds = currentTime - activity;
  const state = inactiveSeconds < IDLE_THRESHOLD ? 'busy' : 'idle';

  if (state === 'idle' && lastState !== 'idle') {
    idleSince = currentTime;
  } else if (state === 'busy') {
    idleSince = 0;
  }

  const idleSeconds = state === 'idle' ? currentTime - idleSince : 0;

  writeStatusFile({
    state,
    last_activity: activity,
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

  engine.processHeartbeat(true, currentTime);
  maybeEnqueueHealthCheck(true, currentTime);
  maybeEnqueueContextCheck(true, currentTime);
  if (engine.health === 'ok') {
    upgradeScheduler.maybeTrigger();
  }
  memoryCommitScheduler.maybeTrigger();
  lastState = state;
}

function init() {
  if (!fs.existsSync(MONITOR_DIR)) {
    fs.mkdirSync(MONITOR_DIR, { recursive: true });
  }
  const initialHealth = loadInitialHealth();
  engine = new HeartbeatEngine({
    enqueueHeartbeat,
    getHeartbeatStatus,
    readHeartbeatPending,
    clearHeartbeatPending,
    killTmuxSession,
    notifyPendingChannels,
    log
  }, {
    initialHealth,
    heartbeatInterval: HEARTBEAT_INTERVAL,
    maxRestartFailures: MAX_RESTART_FAILURES
  });

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

  if (initialHealth !== 'ok') {
    log(`Startup with health=${initialHealth}; will verify immediately when Claude is running`);
  }
}

init();
log(`=== Activity Monitor Started (v9 - Guardian + Heartbeat + HealthCheck + DailyTasks): ${new Date().toISOString()} tz=${timezone} ===`);

setInterval(monitorLoop, INTERVAL);
monitorLoop();
