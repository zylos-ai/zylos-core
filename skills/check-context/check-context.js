#!/usr/bin/env node
/**
 * Check Context Usage Script (C4-integrated)
 * Sends /context command to Claude via tmux, then follow-up via C4
 * Usage: node check-context.js
 *
 * IMPORTANT: Run with nohup to allow Claude to return to idle:
 *   nohup node ~/.claude/skills/check-context/check-context.js > /dev/null 2>&1 &
 *
 * Order matters:
 * 1. Send /context command (via tmux - must execute directly)
 * 2. Wait for output to be displayed
 * 3. Send follow-up message (via C4)
 */

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMUX_SESSION = 'claude-main';

function sleep(seconds) {
  execSync(`sleep ${seconds}`);
}

function sendCommand(command) {
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

  sleep(0.5);
  try {
    execSync(`tmux send-keys -t "${TMUX_SESSION}" Enter 2>/dev/null`);
  } catch {}
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

  // Step 1: Send /context command (must use tmux - it's a CLI command, not a message)
  sendCommand('/context');

  // Step 2: Wait for output to be displayed
  sleep(5);

  // Step 3: Send follow-up message via C4 to prompt Claude to report
  sendViaC4('Report your current context usage based on the /context output above.');
}

main();
