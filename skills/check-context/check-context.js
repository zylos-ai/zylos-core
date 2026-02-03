#!/usr/bin/env node
/**
 * Check Context Usage Script
 * Sends /context command to Claude to get accurate token usage
 * Usage: node check-context.js
 *
 * IMPORTANT: Run with nohup to allow Claude to return to idle:
 *   nohup node ~/.claude/skills/check-context/check-context.js > /dev/null 2>&1 &
 */

const { execSync } = require('child_process');
const fs = require('fs');

const TMUX_SESSION = 'claude-main';

function sleep(seconds) {
  execSync(`sleep ${seconds}`);
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

function main() {
  // Wait for Claude to become idle
  sleep(3);

  // Send /context command
  sendCommand('/context');

  // Wait for output to be displayed
  sleep(5);

  // Send follow-up to prompt Claude to report
  sendToTmux('Report your current context usage based on the /context output above.');
}

main();
