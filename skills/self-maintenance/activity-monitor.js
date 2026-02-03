#!/usr/bin/env node
/**
 * Activity Monitor v5 - Guardian Mode with Maintenance Awareness
 * Monitors Claude's activity state AND ensures Claude Code is always running
 * Waits for restart/upgrade scripts to complete before starting Claude
 * Run with PM2: pm2 start activity-monitor.js --name activity-monitor
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Configuration
const SESSION = 'claude-main';
const STATUS_FILE = path.join(os.homedir(), '.claude-status');
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const LOG_FILE = path.join(ZYLOS_DIR, 'activity-log.txt');

// Auto-detect claude binary path
function findClaudeBin() {
  // Allow override via environment variable
  if (process.env.CLAUDE_BIN) {
    return process.env.CLAUDE_BIN;
  }

  // Known paths to check (in order of preference)
  const knownPaths = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),      // Linux common
    path.join(os.homedir(), '.claude', 'bin', 'claude'),     // Alternative
    '/usr/local/bin/claude',                                  // System-wide
    '/opt/homebrew/bin/claude',                               // macOS Homebrew ARM
    '/usr/bin/claude',                                        // System binary
  ];

  for (const p of knownPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Fallback to bare command (hope it's in PATH)
  return 'claude';
}

const CLAUDE_BIN = findClaudeBin();

// Conversation directory - auto-detect based on working directory
const ZYLOS_PATH = ZYLOS_DIR.replace(/\//g, '-');
const CONV_DIR = path.join(os.homedir(), '.claude', 'projects', ZYLOS_PATH);

const INTERVAL = 1000;        // Check every 1 second (ms)
const IDLE_THRESHOLD = 3;     // seconds without activity = idle
const LOG_MAX_LINES = 500;    // Auto-truncate log to this many lines
const RESTART_DELAY = 5;      // seconds of continuous "not running" before restarting

// State
let lastTruncateDay = '';
let notRunningCount = 0;
let lastState = '';
let startupGrace = 0;

function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

function truncateLog() {
  if (!fs.existsSync(LOG_FILE)) return;

  const content = fs.readFileSync(LOG_FILE, 'utf8');
  const lines = content.split('\n');

  if (lines.length > LOG_MAX_LINES) {
    const truncated = lines.slice(-LOG_MAX_LINES).join('\n');
    fs.writeFileSync(LOG_FILE, truncated);
    log('Log truncated to ' + LOG_MAX_LINES + ' lines');
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
  } catch (err) {
    return null;
  }
}

function tmuxHasSession() {
  try {
    execSync(`tmux has-session -t "${SESSION}" 2>/dev/null`, { encoding: 'utf8' });
    return true;
  } catch {
    return false;
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

  // Check if the pane process itself is claude
  try {
    const procName = execSync(`ps -p ${panePid} -o comm= 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (procName === 'claude') return true;
  } catch {}

  // Fallback: check if claude is a child process
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

    try {
      execSync(`tmux load-buffer -b "${bufferName}" "${tempFile}" 2>/dev/null`);
      execSync('sleep 0.1');
      execSync(`tmux paste-buffer -b "${bufferName}" -t "${SESSION}" 2>/dev/null`);
      execSync('sleep 0.2');
      execSync(`tmux send-keys -t "${SESSION}" Enter 2>/dev/null`);
      execSync(`tmux delete-buffer -b "${bufferName}" 2>/dev/null`);
    } catch {}

    fs.unlinkSync(tempFile);
  } catch (err) {
    // Silently ignore
  }
}

function getRunningMaintenance() {
  // Check for restart-claude (match .sh or .js)
  // Use bracket trick [r] to prevent pgrep from matching itself
  try {
    execSync('pgrep -f "[r]estart-claude" > /dev/null 2>&1');
    return 'restart-claude';
  } catch {}

  // Check for upgrade-claude
  try {
    execSync('pgrep -f "[u]pgrade-claude" > /dev/null 2>&1');
    return 'upgrade-claude';
  } catch {}

  // Also check for curl install.sh (upgrade in progress)
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
  const maxWait = 300;  // 5 minutes max
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
    waited++;
  }

  if (waited > 0 && waited < maxWait) {
    log(`Guardian: ${scriptName} completed after ${waited}s`);
  }
}

function startClaude() {
  // First check if maintenance scripts are running
  if (isMaintenanceRunning()) {
    log('Guardian: Maintenance script detected, waiting for completion...');
    waitForMaintenance();
  }

  log('Guardian: Starting Claude Code...');

  // Reset context monitor cooldowns
  try {
    fs.unlinkSync('/tmp/context-alert-cooldown');
  } catch {}
  try {
    fs.unlinkSync('/tmp/context-compact-scheduled');
  } catch {}

  if (tmuxHasSession()) {
    // Session exists, send command to start claude
    sendToTmux(`cd ${ZYLOS_DIR}; ${CLAUDE_BIN} --dangerously-skip-permissions`);
    log('Guardian: Started Claude in existing tmux session');
  } else {
    // Create new session
    try {
      execSync(`tmux new-session -d -s "${SESSION}" "cd ${ZYLOS_DIR} && ${CLAUDE_BIN} --dangerously-skip-permissions"`);
      log('Guardian: Created new tmux session and started Claude');
    } catch (err) {
      log(`Guardian: Failed to create tmux session: ${err.message}`);
    }
  }

  // Wait a bit then send catch-up prompt
  setTimeout(() => {
    if (isClaudeRunning()) {
      log('Guardian: Claude started successfully, sending catch-up prompt');
      setTimeout(() => {
        sendToTmux(`Session recovered by activity monitor. Do the following:

1. Read your memory files (especially ~/zylos/memory/context.md)
2. Check the conversation transcript at ~/.claude/projects/-home-howard-zylos/*.jsonl (most recent file by date) for messages AFTER the last memory sync timestamp
3. If there was conversation between last memory sync and crash, briefly summarize what was discussed (both Howard's messages and your replies)
4. Send recovery status via ~/zylos/bin/notify.sh`);
      }, 5000);
    } else {
      log('Guardian: Warning - Claude may not have started properly');
    }
  }, 15000);
}

function writeStatusFile(statusObj) {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(statusObj, null, 2));
  } catch (err) {
    // Silently ignore
  }
}

function getConversationFileModTime() {
  try {
    const files = fs.readdirSync(CONV_DIR)
      .filter(f => f.endsWith('.jsonl') && !f.includes('agent-'))
      .map(f => ({
        name: f,
        mtime: fs.statSync(path.join(CONV_DIR, f)).mtimeMs
      }))
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

function monitorLoop() {
  const currentTime = Math.floor(Date.now() / 1000);
  const currentTimeHuman = new Date().toISOString().replace('T', ' ').substring(0, 19);

  // Daily log truncation
  checkDailyTruncate();

  // Check if tmux session exists
  if (!tmuxHasSession()) {
    const state = 'offline';
    notRunningCount++;

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

    // Guardian: Start Claude after RESTART_DELAY seconds
    if (notRunningCount >= RESTART_DELAY) {
      log(`Guardian: Session not found for ${notRunningCount}s, starting Claude...`);
      startClaude();
      startupGrace = 30;
      notRunningCount = 0;
    }

    lastState = state;
    return;
  }

  // Session exists, check if claude is running
  if (!isClaudeRunning()) {
    // Grace period after startup
    if (startupGrace > 0) {
      startupGrace--;
      return;
    }

    const state = 'stopped';
    notRunningCount++;

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

    // Guardian: Start Claude after RESTART_DELAY seconds
    if (notRunningCount >= RESTART_DELAY) {
      log(`Guardian: Claude not running for ${notRunningCount}s, starting Claude...`);
      startClaude();
      startupGrace = 30;
      notRunningCount = 0;
    }

    lastState = state;
    return;
  }

  // Reset counters when claude is confirmed running
  startupGrace = 0;
  notRunningCount = 0;

  // Get conversation file modification time (more reliable than tmux activity)
  let activity = getConversationFileModTime();
  let source = 'conv_file';

  if (!activity) {
    // Fallback to tmux activity
    activity = getTmuxActivity();
    source = 'tmux_activity';
  }

  if (!activity) {
    activity = currentTime;
    source = 'default';
  }

  // Calculate idle time
  const idleSeconds = currentTime - activity;

  // Determine state
  const state = idleSeconds < IDLE_THRESHOLD ? 'busy' : 'idle';

  // Write JSON status file
  writeStatusFile({
    state,
    last_activity: activity,
    last_check: currentTime,
    last_check_human: currentTimeHuman,
    idle_seconds: idleSeconds,
    source
  });

  // Only log on state change
  if (state !== lastState) {
    if (state === 'busy') {
      log(`State: BUSY (last activity ${idleSeconds}s ago)`);
    } else {
      log(`State: IDLE (inactive for ${idleSeconds}s)`);
    }
  }

  lastState = state;
}

// Main
log(`=== Activity Monitor Started (v5 - Guardian Mode): ${new Date().toISOString()} ===`);

setInterval(monitorLoop, INTERVAL);

// Run immediately
monitorLoop();
