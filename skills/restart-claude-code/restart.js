#!/usr/bin/env node
/**
 * Claude Code Simple Restart Script (C4-integrated)
 * Sends /exit to Claude via C4, then activity-monitor daemon will restart it automatically
 * Usage: node restart.js
 */

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const LOG_FILE = path.join(ZYLOS_DIR, 'upgrade-log.txt');
const STATUS_FILE = path.join(os.homedir(), '.claude-status');
const CHECK_INTERVAL = 1;
const MIN_IDLE_SECONDS = 3;

function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `[${timestamp}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function sleep(seconds) {
  execSync(`sleep ${seconds}`);
}

function isClaudeIdle() {
  try {
    if (!fs.existsSync(STATUS_FILE)) {
      return true;
    }
    const content = fs.readFileSync(STATUS_FILE, 'utf8');
    const status = JSON.parse(content);
    return status.idle_seconds >= MIN_IDLE_SECONDS;
  } catch {
    return true;
  }
}

function waitForIdle() {
  const MAX_WAIT_SECONDS = 600;
  let waited = 0;
  while (waited < MAX_WAIT_SECONDS) {
    if (isClaudeIdle()) {
      return true;
    }
    sleep(CHECK_INTERVAL);
    waited += CHECK_INTERVAL;
  }
  log(`Warning: Claude still busy after ${MAX_WAIT_SECONDS}s, proceeding anyway`);
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
    return true;
  } catch (err) {
    log(`Failed to send via C4: ${err.message}`);
    return false;
  }
}

async function main() {
  log('=== Claude Code Restart Started ===');

  // Step 1: Ask Claude to sync memory before restart
  log('Requesting memory sync before restart...');
  sendViaC4('[System] Restart requested. Please sync memory (update context.md) before I proceed with restart.');

  // Step 2: Wait for Claude to be idle (after syncing memory)
  log('Waiting for Claude to be idle...');
  waitForIdle();

  // Step 3: Send /exit command via C4
  log('Sending /exit command via C4...');
  sendViaC4('/exit');

  log('=== Restart command sent (Activity Monitor will restart Claude) ===');
}

main();
