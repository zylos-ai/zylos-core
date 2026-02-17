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

function sleep(seconds) {
  execSync(`sleep ${seconds}`);
}

function enqueueExit() {
  try {
    const output = execFileSync(
      'node',
      [C4_CONTROL, 'enqueue', '--content', '/exit', '--priority', '1', '--require-idle'],
      { encoding: 'utf8', stdio: 'pipe' }
    );
    const match = output.match(/control\s+(\d+)/);
    const controlId = match ? match[1] : null;
    console.log(`[upgrade-claude] /exit enqueued via control queue (id=${controlId})`);
    return controlId;
  } catch (err) {
    console.error(`Failed to enqueue /exit: ${err.message}`);
    process.exit(1);
  }
}

function cancelExit(controlId) {
  if (!controlId) return;
  try {
    execFileSync('node', [C4_CONTROL, 'ack', '--id', controlId], { stdio: 'pipe' });
    console.log(`[upgrade-claude] Cancelled queued /exit (id=${controlId})`);
  } catch {
    console.error(`[upgrade-claude] WARNING: Failed to cancel queued /exit (id=${controlId})`);
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
      console.log('[upgrade-claude] Claude process has exited');
      return true;
    }
    sleep(2);
    waited += 2;
  }

  console.error(`[upgrade-claude] ABORT: Claude still running after ${MAX_EXIT_WAIT}s, upgrade cancelled`);
  return false;
}

function upgradeClaudeCode() {
  console.log('[upgrade-claude] Starting Claude Code upgrade...');

  try {
    process.chdir(os.homedir());
    const output = execSync('curl -fsSL https://claude.ai/install.sh | bash', {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    console.log(output);
    console.log('[upgrade-claude] Upgrade completed successfully');
  } catch (err) {
    console.error(`[upgrade-claude] ERROR: Upgrade failed! ${err.message}`);
    process.exit(1);
  }

  try {
    const newVersion = execSync('~/.local/bin/claude --version 2>/dev/null', {
      encoding: 'utf8'
    }).trim();
    console.log(`[upgrade-claude] New version: ${newVersion}`);
  } catch {
    console.log('[upgrade-claude] New version: unknown');
  }
}

function main() {
  console.log('[upgrade-claude] Starting upgrade process');

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
  console.log('[upgrade-claude] Upgrade complete, activity-monitor will restart Claude');
}

main();
