#!/usr/bin/env node
/**
 * Check Context Usage Script (C4-integrated)
 * Sends context check request to Claude via C4 Communication Bridge
 * Usage: node check-context.js
 *
 * IMPORTANT: Run with nohup to allow Claude to return to idle:
 *   nohup node ~/.claude/skills/self-maintenance/check-context.js > /dev/null 2>&1 &
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

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
    // idle_seconds = time since entering idle state (0 when busy)
    // So we only need to check if idle_seconds >= MIN_IDLE_SECONDS
    return status.idle_seconds >= MIN_IDLE_SECONDS;
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

function sendViaC4(message) {
  const c4ReceivePath = path.join(os.homedir(), '.claude/skills/comm-bridge/c4-receive.js');

  try {
    execSync(
      `node "${c4ReceivePath}" --source system --priority 1 --content "${message.replace(/"/g, '\\"')}"`,
      { stdio: 'inherit' }
    );
  } catch (err) {
    console.error(`Failed to send via C4: ${err.message}`);
    process.exit(1);
  }
}

function main() {
  // Wait for Claude to become idle (check ~/.claude-status)
  // Requires idle_seconds >= 5 to ensure stable idle state
  waitForIdle();

  // Send context check request via C4
  const message = '[System] Please run /context command and report your current context usage based on the output.';
  sendViaC4(message);

  console.log('[check-context] Context check request sent via C4');
}

main();
