#!/usr/bin/env node
/**
 * Upgrade Claude Code Script (C4-integrated)
 * Enqueues /exit via control queue, waits for exit, upgrades, activity-monitor restarts
 * Usage: node upgrade.js
 *
 * IMPORTANT: Run with nohup and redirect output to log file:
 *   nohup node ~/zylos/.claude/skills/upgrade-claude/scripts/upgrade.js >> ~/zylos/logs/upgrade.log 2>&1 &
 */

import { execSync, execFileSync } from 'child_process';
import path from 'path';
import os from 'os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const C4_CONTROL = path.join(ZYLOS_DIR, '.claude/skills/comm-bridge/scripts/c4-control.js');
const MAX_EXIT_WAIT = 120; // Wait up to 120 seconds for Claude to exit

function ts() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function log(msg) {
  console.log(`[${ts()}] [upgrade-claude] ${msg}`);
}

function logError(msg) {
  console.error(`[${ts()}] [upgrade-claude] ${msg}`);
}

function sleep(seconds) {
  execSync(`sleep ${seconds}`);
}

function enqueueExit() {
  try {
    const output = execFileSync(
      'node',
      [C4_CONTROL, 'enqueue', '--content', '/exit', '--priority', '1', '--require-idle', '--ack-deadline', '300'],
      { encoding: 'utf8', stdio: 'pipe' }
    );
    const match = output.match(/control\s+(\d+)/);
    const controlId = match ? match[1] : null;
    log(`/exit enqueued via control queue (id=${controlId})`);
    return controlId;
  } catch (err) {
    logError(`Failed to enqueue /exit: ${err.message}`);
    process.exit(1);
  }
}

function cancelExit(controlId) {
  if (!controlId) return;
  try {
    execFileSync('node', [C4_CONTROL, 'ack', '--id', controlId], { stdio: 'pipe' });
    log(`Cancelled queued /exit (id=${controlId})`);
  } catch {
    logError(`WARNING: Failed to cancel queued /exit (id=${controlId})`);
  }
}

function isClaudeRunning() {
  try {
    execSync('pgrep -f "claude.*--dangerously-skip-permissions" > /dev/null 2>&1');
    return true;
  } catch {
    return false;
  }
}

function waitForClaudeExit() {
  let waited = 0;

  while (waited < MAX_EXIT_WAIT) {
    if (!isClaudeRunning()) {
      log('Claude process has exited');
      return true;
    }
    sleep(2);
    waited += 2;
  }

  logError(`ABORT: Claude still running after ${MAX_EXIT_WAIT}s, upgrade cancelled`);
  return false;
}

function upgradeClaudeCode() {
  log('Starting Claude Code upgrade...');

  try {
    process.chdir(os.homedir());
    const output = execSync('curl -fsSL https://claude.ai/install.sh | bash', {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    console.log(output);
    log('Upgrade completed successfully');
  } catch (err) {
    logError(`ERROR: Upgrade failed! ${err.message}`);
    process.exit(1);
  }

  try {
    const newVersion = execSync('~/.local/bin/claude --version 2>/dev/null', {
      encoding: 'utf8'
    }).trim();
    log(`New version: ${newVersion}`);
  } catch {
    log('New version: unknown');
  }
}

function main() {
  log('Starting upgrade process');

  // Step 1: Enqueue /exit via control queue (dispatcher handles idle detection)
  const controlId = enqueueExit();

  // Step 2: Wait for Claude to exit
  if (!waitForClaudeExit()) {
    cancelExit(controlId);
    process.exit(1);
  }

  // Step 3: Upgrade Claude Code
  upgradeClaudeCode();

  // Done - activity-monitor will restart Claude automatically
  log('Upgrade complete, activity-monitor will restart Claude');
}

main();
