#!/usr/bin/env node
/**
 * Check Context Usage Script (C4-integrated)
 * Sends /context command to Claude via C4
 * Usage: node check-context.js
 *
 * IMPORTANT: Run with nohup to allow Claude to return to idle:
 *   nohup node ~/.claude/skills/check-context/check-context.js > /dev/null 2>&1 &
 */

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

function sleep(seconds) {
  execSync(`sleep ${seconds}`);
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
  // Wait for Claude to become idle
  sleep(3);

  // Send /context command via C4
  // The command itself returns context usage information, no follow-up needed
  sendViaC4('/context');
}

main();
