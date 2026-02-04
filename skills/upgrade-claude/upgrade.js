#!/usr/bin/env node
/**
 * Upgrade Claude Code Script (C4-integrated)
 * Sends /exit, waits for exit, upgrades Claude Code, activity-monitor restarts it
 * Usage: node upgrade.js
 *
 * IMPORTANT: Run with nohup to allow Claude to exit cleanly:
 *   nohup node ~/.claude/skills/upgrade-claude/upgrade.js > /dev/null 2>&1 &
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

function isClaudeRunning() {
  try {
    // Check if claude process is running
    execSync('pgrep -f "claude.*--dangerously-skip-permissions" > /dev/null 2>&1');
    return true;
  } catch {
    return false;
  }
}

function waitForClaudeExit() {
  const MAX_EXIT_WAIT = 60; // Wait up to 60 seconds for Claude to exit
  let waited = 0;

  while (waited < MAX_EXIT_WAIT) {
    if (!isClaudeRunning()) {
      console.log('Claude process has exited');
      return true;
    }
    sleep(2);
    waited += 2;
  }

  console.log(`Warning: Claude still running after ${MAX_EXIT_WAIT}s, proceeding anyway`);
  return false;
}

function upgradeClaudeCode() {
  console.log('Starting Claude Code upgrade...');

  try {
    process.chdir(os.homedir());
    const output = execSync('curl -fsSL https://claude.ai/install.sh | bash', {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    console.log(output);
    console.log('Upgrade completed successfully');
  } catch (err) {
    console.error(`ERROR: Upgrade failed! ${err.message}`);
    process.exit(1);
  }

  // Check new version
  try {
    const newVersion = execSync('~/.local/bin/claude --version 2>/dev/null', {
      encoding: 'utf8'
    }).trim();
    console.log(`New version: ${newVersion}`);
  } catch {
    console.log('New version: unknown');
  }
}

function main() {
  console.log('[upgrade-claude] Starting upgrade process');

  // Step 1: Wait for Claude to be idle
  waitForIdle();

  // Step 2: Send /exit command via C4
  sendViaC4('/exit');

  // Step 3: Wait for Claude to exit
  sleep(3); // Give it a moment to start exiting
  waitForClaudeExit();

  // Step 4: Upgrade Claude Code
  upgradeClaudeCode();

  // Done - activity-monitor will restart Claude automatically
  console.log('[upgrade-claude] Upgrade complete, activity-monitor will restart Claude');
}

main();
