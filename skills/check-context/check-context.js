#!/usr/bin/env node
/**
 * Check Context Usage Script (C4-integrated)
 * Sends /context command to Claude via C4
 * Usage: node check-context.js
 *
 * IMPORTANT: Run with nohup to allow Claude to return to idle:
 *   nohup node ~/.claude/skills/check-context/check-context.js > /dev/null 2>&1 &
 */

import { execSync, execFileSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';

const STATUS_FILE = path.join(os.homedir(), '.claude-status');
const MAX_WAIT_SECONDS = 600; // Max time to wait for idle (10 minutes)
const CHECK_INTERVAL = 1; // Seconds between idle checks
const MIN_IDLE_SECONDS = 3; // Require at least 3 seconds of idle time

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
    // Use execFileSync to avoid shell injection - passes arguments directly
    // Use --no-reply since system messages don't need a reply path
    execFileSync(
      'node',
      [c4ReceivePath, '--source', 'system', '--priority', '1', '--no-reply', '--content', message],
      { stdio: 'inherit' }
    );
  } catch (err) {
    console.error(`Failed to send via C4: ${err.message}`);
    process.exit(1);
  }
}

function main() {
  // Wait for Claude to become idle (check ~/.claude-status)
  // Requires idle_seconds >= MIN_IDLE_SECONDS to ensure stable idle state
  waitForIdle();

  // Send /context command via C4
  // The command itself returns context usage information, no follow-up needed
  sendViaC4('/context');

  // Sleep 3 seconds to ensure the result is returned before allowing other messages
  sleep(3);

  console.log('[check-context] Context check command sent via C4');
}

main();
