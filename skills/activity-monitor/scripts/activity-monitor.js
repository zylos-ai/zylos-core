#!/usr/bin/env node
/**
 * Activity Monitor v5 - Guardian Mode with Maintenance Awareness
 * Monitors Claude's activity state AND ensures Claude Code is always running
 * Waits for restart/upgrade scripts to complete before starting Claude
 * Run with PM2: pm2 start activity-monitor.js --name activity-monitor
 */

import { execSync, execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Configuration
const SESSION = 'claude-main';
const STATUS_FILE = path.join(os.homedir(), '.claude-status');
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const SKILL_DIR = path.join(ZYLOS_DIR, 'activity-monitor');
const LOG_FILE = path.join(SKILL_DIR, 'activity.log');

// Claude binary - relies on PATH from PM2 ecosystem.config.js
// Override via CLAUDE_BIN environment variable if needed
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const BYPASS_PERMISSIONS = process.env.CLAUDE_BYPASS_PERMISSIONS !== 'false';

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
let idleSince = 0;  // Timestamp when entered idle state

function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `[${timestamp}] ${message}\n`;
  // Ensure skill directory exists
  if (!fs.existsSync(SKILL_DIR)) {
    fs.mkdirSync(SKILL_DIR, { recursive: true });
  }
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

function isClaudeReady() {
  // Check if Claude has displayed the input prompt by capturing tmux pane content
  try {
    const paneContent = execSync(
      `tmux capture-pane -t "${SESSION}" -p 2>/dev/null`,
      { encoding: 'utf8' }
    );
    // Claude Code shows ">" as input prompt when ready
    // Also check for common ready indicators
    return paneContent.includes('>') || paneContent.includes('Claude');
  } catch {
    return false;
  }
}

function waitForClaudeReady(maxWaitSeconds = 60) {
  return new Promise((resolve) => {
    let waited = 0;
    const checkInterval = setInterval(() => {
      waited++;

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
        return;
      }
    }, 1000);
  });
}

function sendViaC4(message, source = 'system') {
  const c4ReceivePath = path.join(os.homedir(), 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');

  try {
    // Use execFileSync to avoid shell injection - passes arguments directly
    execFileSync(
      'node',
      [c4ReceivePath, '--priority', '1', '--no-reply', '--content', message],
      { stdio: 'pipe' }
    );
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

  const bypassFlag = BYPASS_PERMISSIONS ? ' --dangerously-skip-permissions' : '';

  if (tmuxHasSession()) {
    // Session exists, send command to start claude
    sendToTmux(`cd ${ZYLOS_DIR}; ${CLAUDE_BIN}${bypassFlag}`);
    log('Guardian: Started Claude in existing tmux session');
  } else {
    // Create new session
    try {
      execSync(`tmux new-session -d -s "${SESSION}" "cd ${ZYLOS_DIR} && ${CLAUDE_BIN}${bypassFlag}"`);
      log('Guardian: Created new tmux session and started Claude');
    } catch (err) {
      log(`Guardian: Failed to create tmux session: ${err.message}`);
    }
  }

  // Wait for Claude to be ready (show input prompt), then send recovery message
  waitForClaudeReady(60).then((ready) => {
    if (ready) {
      log('Guardian: Claude is ready, waiting 2s before sending recovery prompt...');
      setTimeout(() => {
        sendViaC4(`Session recovered by activity monitor. Do the following:

1. Read your memory files (identity.md, state.md, references.md in ${ZYLOS_DIR}/memory/)
2. Check the conversation transcript at ${CONV_DIR}/*.jsonl (most recent file by date) for messages AFTER the last memory sync timestamp
3. If there was conversation between last memory sync and crash, briefly summarize what was discussed (both Howard's messages and your replies)`);
        log('Guardian: Recovery prompt sent via C4');
      }, 2000);
    } else {
      log('Guardian: Warning - Claude may not have started properly');
    }
  });
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

  // Calculate time since last activity
  const inactiveSeconds = currentTime - activity;

  // Determine state
  const state = inactiveSeconds < IDLE_THRESHOLD ? 'busy' : 'idle';

  // Track when we entered idle state
  if (state === 'idle' && lastState !== 'idle') {
    // Just transitioned to idle
    idleSince = currentTime;
  } else if (state === 'busy') {
    // Reset idle tracking when busy
    idleSince = 0;
  }

  // idle_seconds = time since entering idle state (0 if busy)
  const idleSeconds = state === 'idle' ? currentTime - idleSince : 0;

  // Write JSON status file
  writeStatusFile({
    state,
    last_activity: activity,
    last_check: currentTime,
    last_check_human: currentTimeHuman,
    idle_seconds: idleSeconds,
    inactive_seconds: inactiveSeconds,  // Keep original metric for reference
    source
  });

  // Only log on state change
  if (state !== lastState) {
    if (state === 'busy') {
      log(`State: BUSY (last activity ${inactiveSeconds}s ago)`);
    } else {
      log(`State: IDLE (entering idle state)`);
    }
  }

  lastState = state;
}

// Main
log(`=== Activity Monitor Started (v5 - Guardian Mode): ${new Date().toISOString()} ===`);

setInterval(monitorLoop, INTERVAL);

// Run immediately
monitorLoop();
