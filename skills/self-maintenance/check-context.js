#!/usr/bin/env node
/**
 * Check Context Usage Script
 * Sends /context command to Claude to get accurate token usage
 * Usage: node check-context.js
 *
 * IMPORTANT: Run with nohup to allow Claude to return to idle:
 *   nohup node ~/.claude/skills/self-maintenance/check-context.js > /dev/null 2>&1 &
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMUX_SESSION = 'claude-main';
const STATUS_FILE = path.join(os.homedir(), '.claude-status');
const MAX_WAIT_SECONDS = 600; // Max time to wait for idle (10 minutes)
const CHECK_INTERVAL = 2; // Seconds between idle checks
const MIN_IDLE_SECONDS = 5; // Require at least 5 seconds of idle time

function sleep(seconds) {
  execSync(`sleep ${seconds}`);
}

function isClaudeIdle() {
  try {
    if (!fs.existsSync(STATUS_FILE)) {
      // No status file, assume idle
      return true;
    }
    const content = fs.readFileSync(STATUS_FILE, 'utf8');
    const status = JSON.parse(content);
    // Require idle state AND at least MIN_IDLE_SECONDS of idle time
    return status.state === 'idle' && status.idle_seconds >= MIN_IDLE_SECONDS;
  } catch {
    // Error reading file, assume idle
    return true;
  }
}

function waitForIdle() {
  let waited = 0;
  while (waited < MAX_WAIT_SECONDS) {
    if (isClaudeIdle()) {
      return true;
    }
    sleep(CHECK_INTERVAL);
    waited += CHECK_INTERVAL;
  }
  // Timeout - proceed anyway
  console.log(`Warning: Claude still busy after ${MAX_WAIT_SECONDS}s, proceeding anyway`);
  return false;
}

function sendToTmux(text) {
  const msgId = `${Date.now()}-${process.pid}`;
  const tempFile = `/tmp/ctx-msg-${msgId}.txt`;
  const bufferName = `ctx-${msgId}`;

  try {
    fs.writeFileSync(tempFile, text);

    try {
      execSync(`tmux load-buffer -b "${bufferName}" "${tempFile}" 2>/dev/null`);
      execSync('sleep 0.1');
      execSync(`tmux paste-buffer -b "${bufferName}" -t "${TMUX_SESSION}" 2>/dev/null`);
      execSync('sleep 0.2');
      execSync(`tmux send-keys -t "${TMUX_SESSION}" Enter 2>/dev/null`);
      execSync(`tmux delete-buffer -b "${bufferName}" 2>/dev/null`);
    } catch {}

    fs.unlinkSync(tempFile);
  } catch {}
}

function sendCommand(command) {
  // Send command without Enter, then send Enter separately
  const msgId = `${Date.now()}-${process.pid}`;
  const tempFile = `/tmp/ctx-cmd-${msgId}.txt`;
  const bufferName = `ctx-cmd-${msgId}`;

  try {
    fs.writeFileSync(tempFile, command);

    try {
      execSync(`tmux load-buffer -b "${bufferName}" "${tempFile}" 2>/dev/null`);
      execSync(`tmux paste-buffer -b "${bufferName}" -t "${TMUX_SESSION}" 2>/dev/null`);
      execSync(`tmux delete-buffer -b "${bufferName}" 2>/dev/null`);
    } catch {}

    fs.unlinkSync(tempFile);
  } catch {}

  // Wait then press Enter
  sleep(0.5);
  try {
    execSync(`tmux send-keys -t "${TMUX_SESSION}" Enter 2>/dev/null`);
  } catch {}
}

function main() {
  // Wait for Claude to become idle (check ~/.claude-status)
  // Requires idle_seconds >= 5 to ensure stable idle state
  waitForIdle();

  // Send /context command
  sendCommand('/context');

  // Wait for output to be displayed
  sleep(5);

  // Send follow-up to prompt Claude to report
  sendToTmux('Report your current context usage based on the /context output above.');
}

main();
