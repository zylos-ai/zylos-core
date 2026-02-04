#!/usr/bin/env node
/**
 * Check Context Usage Script (C4-integrated)
 * Sends /context command and follow-up message to Claude via C4
 * Usage: node check-context.js
 *
 * IMPORTANT: Run with nohup to allow Claude to return to idle:
 *   nohup node ~/.claude/skills/check-context/check-context.js > /dev/null 2>&1 &
 *
 * Order matters:
 * 1. Send /context command (via C4)
 * 2. Wait for output to be displayed
 * 3. Send follow-up message (via C4)
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
    execFileSync(
      'node',
      [c4ReceivePath, '--source', 'system', '--priority', '1', '--content', message],
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

  // Step 1: Send /context command via C4
  sendViaC4('/context');

  // Step 2: Wait for output to be displayed
  sleep(5);

  // Step 3: Send follow-up message via C4 to prompt Claude to report
  sendViaC4('Report your current context usage based on the /context output above.');
}

main();
