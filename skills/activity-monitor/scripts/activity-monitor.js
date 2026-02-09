#!/usr/bin/env node
/**
 * Activity Monitor v6 - Guardian + Heartbeat Liveness
 * Run with PM2: pm2 start activity-monitor.js --name activity-monitor
 */

import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Core runtime config
const SESSION = 'claude-main';
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const COMM_BRIDGE_DIR = path.join(ZYLOS_DIR, 'comm-bridge');
const STATUS_FILE = path.join(COMM_BRIDGE_DIR, 'claude-status.json');
const MONITOR_DIR = path.join(ZYLOS_DIR, 'activity-monitor');
const LOG_FILE = path.join(MONITOR_DIR, 'activity.log');
const HEARTBEAT_PENDING_FILE = path.join(MONITOR_DIR, 'heartbeat-pending.json');
const PENDING_CHANNELS_FILE = path.join(COMM_BRIDGE_DIR, 'pending-channels.jsonl');

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

// State
let lastTruncateDay = '';
let notRunningCount = 0;
let lastState = '';
let startupGrace = 0;
let idleSince = 0;

let healthState = 'ok';
let restartFailureCount = 0;
let lastHeartbeatAt = Math.floor(Date.now() / 1000);

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
const C4_RECEIVE_PATH = resolveCommBridgeScript('c4-receive.js');
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
  } catch {}

  try {
    execSync(`pgrep -P ${panePid} -f "claude" > /dev/null 2>&1`);
    return true;
  } catch {
    return false;
  }
}

function isClaudeReady() {
  try {
    const paneContent = execSync(`tmux capture-pane -t "${SESSION}" -p 2>/dev/null`, { encoding: 'utf8' });
    return paneContent.includes('>') || paneContent.includes('Claude');
  } catch {
    return false;
  }
}

function waitForClaudeReady(maxWaitSeconds = 60) {
  return new Promise((resolve) => {
    let waited = 0;
    const checkInterval = setInterval(() => {
      waited += 1;

      if (isClaudeReady()) {
        clearInterval(checkInterval);
        log(`Guardian: Claude ready after ${waited}s`);
        resolve(true);
        return;
      }

      if (waited >= maxWaitSeconds) {
        clearInterval(checkInterval);
        log(`Guardian: Timeout waiting for Claude to be ready (${maxWaitSeconds}s)`);
        resolve(false);
      }
    }, 1000);
  });
}

function sendViaC4(message) {
  try {
    execFileSync('node', [C4_RECEIVE_PATH, '--priority', '1', '--no-reply', '--content', message], { stdio: 'pipe' });
    return true;
  } catch (err) {
    log(`Failed to send via C4: ${err.message}`);
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
  } catch {}

  try {
    execSync('pgrep -f "[u]pgrade-claude" > /dev/null 2>&1');
    return 'upgrade-claude';
  } catch {}

  try {
    execSync('pgrep -f "[c]laude.ai/install.sh" > /dev/null 2>&1');
    return 'upgrade (curl install.sh)';
  } catch {}

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

function startClaude() {
  if (isMaintenanceRunning()) {
    log('Guardian: Maintenance script detected, waiting for completion...');
    waitForMaintenance();
  }

  log('Guardian: Starting Claude Code...');

  try {
    fs.unlinkSync('/tmp/context-alert-cooldown');
  } catch {}
  try {
    fs.unlinkSync('/tmp/context-compact-scheduled');
  } catch {}

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

  waitForClaudeReady(60).then((ready) => {
    if (!ready) {
      log('Guardian: Warning - Claude may not have started properly');
      return;
    }

    log('Guardian: Claude is ready, waiting 2s before sending recovery prompt...');
    setTimeout(() => {
      sendViaC4(`Session recovered by activity monitor. Do the following:

1. Read your memory files (identity.md, state.md, references.md in ${ZYLOS_DIR}/memory/)
2. Check the conversation transcript at ${CONV_DIR}/*.jsonl (most recent file by date) for messages AFTER the last memory sync timestamp
3. If there was conversation between last memory sync and crash, briefly summarize what was discussed (both Howard's messages and your replies)`);
      log('Guardian: Recovery prompt sent via C4');
    }, 2000);
  });
}

function ensureStatusDir() {
  if (!fs.existsSync(COMM_BRIDGE_DIR)) {
    fs.mkdirSync(COMM_BRIDGE_DIR, { recursive: true });
  }
}

function loadInitialHealth() {
  try {
    if (!fs.existsSync(STATUS_FILE)) return 'ok';
    const status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    if (status && typeof status.health === 'string') {
      return status.health;
    }
  } catch {}
  return 'ok';
}

function setHealth(nextHealth, reason = '') {
  if (healthState === nextHealth) return;
  const suffix = reason ? ` (${reason})` : '';
  log(`Health: ${healthState.toUpperCase()} -> ${nextHealth.toUpperCase()}${suffix}`);
  healthState = nextHealth;
}

function writeStatusFile(statusObj) {
  try {
    ensureStatusDir();
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...statusObj, health: healthState }, null, 2));
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
  } catch {}
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
  } catch {}
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
  const content = `Heartbeat check. Run: ${C4_CONTROL_PATH} ack --id __CONTROL_ID__`;
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
  if (phase === 'primary') {
    lastHeartbeatAt = Math.floor(Date.now() / 1000);
  }
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
    execFileSync('node', [C4_SEND_PATH, channel, endpoint, 'System has recovered. Please resend your request.'], { stdio: 'pipe' });
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

function onHeartbeatSuccess(phase) {
  clearHeartbeatPending();
  restartFailureCount = 0;
  if (healthState !== 'ok') {
    setHealth('ok', `heartbeat_ack phase=${phase}`);
    notifyPendingChannels();
  }
  if (phase !== 'primary') {
    lastHeartbeatAt = Math.floor(Date.now() / 1000);
  }
}

function triggerRecovery(reason) {
  if (healthState === 'down') {
    log(`Heartbeat recovery skipped in DOWN state (${reason})`);
    return;
  }

  if (healthState === 'ok') {
    setHealth('recovering', reason);
  }

  restartFailureCount += 1;
  log(`Heartbeat recovery attempt ${restartFailureCount}/${MAX_RESTART_FAILURES} (${reason})`);
  killTmuxSession();

  if (restartFailureCount >= MAX_RESTART_FAILURES) {
    setHealth('down', 'max_restart_failures_reached');
  }
}

function onHeartbeatFailure(pending, status) {
  const phase = pending.phase || 'primary';
  clearHeartbeatPending();

  if (phase === 'primary' && healthState === 'ok') {
    log('Heartbeat primary failed; entering verify phase');
    enqueueHeartbeat('verify');
    return;
  }

  if (phase === 'verify' && healthState === 'ok') {
    triggerRecovery(`verify_${status}`);
    return;
  }

  if (healthState === 'recovering') {
    triggerRecovery(`recovery_${status}`);
    return;
  }

  if (healthState === 'down') {
    log(`Heartbeat failed in DOWN state (${status}); waiting for manual fix`);
    return;
  }

  triggerRecovery(`heartbeat_${status}`);
}

function processHeartbeat(claudeRunning, currentTime) {
  const pending = readHeartbeatPending();
  if (pending) {
    const status = getHeartbeatStatus(pending.control_id);
    if (status === 'pending' || status === 'running' || status === 'error') {
      return;
    }

    if (status === 'done') {
      onHeartbeatSuccess(pending.phase || 'unknown');
      return;
    }

    if (status === 'failed' || status === 'timeout' || status === 'not_found') {
      onHeartbeatFailure(pending, status);
      return;
    }

    log(`Heartbeat unexpected status: ${status}`);
    return;
  }

  if (!claudeRunning) {
    return;
  }

  if (healthState === 'recovering') {
    enqueueHeartbeat('recovery');
    return;
  }

  if (healthState === 'down') {
    enqueueHeartbeat('down-check');
    return;
  }

  if ((currentTime - lastHeartbeatAt) >= HEARTBEAT_INTERVAL) {
    enqueueHeartbeat('primary');
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

    processHeartbeat(false, currentTime);
    lastState = state;
    return;
  }

  if (!isClaudeRunning()) {
    if (startupGrace > 0) {
      startupGrace -= 1;
      processHeartbeat(false, currentTime);
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

    processHeartbeat(false, currentTime);
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

  processHeartbeat(true, currentTime);
  lastState = state;
}

function init() {
  if (!fs.existsSync(MONITOR_DIR)) {
    fs.mkdirSync(MONITOR_DIR, { recursive: true });
  }
  if (!fs.existsSync(COMM_BRIDGE_DIR)) {
    fs.mkdirSync(COMM_BRIDGE_DIR, { recursive: true });
  }

  healthState = loadInitialHealth();
  if (healthState !== 'ok') {
    log(`Startup with health=${healthState}; will verify immediately when Claude is running`);
  }
}

init();
log(`=== Activity Monitor Started (v6 - Guardian + Heartbeat): ${new Date().toISOString()} ===`);

setInterval(monitorLoop, INTERVAL);
monitorLoop();
