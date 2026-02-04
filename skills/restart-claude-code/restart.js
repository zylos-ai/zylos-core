#!/usr/bin/env node
/**
 * Claude Code Simple Restart Script (C4-integrated)
 * Restarts Claude without upgrading - useful for reloading hooks/config
 * Usage: node restart-claude.js [channel]
 *   channel: Optional notification channel (e.g., "lark:oc_xxx" or "telegram")
 *            If provided, restart confirmation will be sent there
 *            If not provided, falls back to notify.sh (sends to primary_dm)
 */

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Auto-detect zylos directory
const SCRIPT_DIR = __dirname;
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const LOG_FILE = path.join(ZYLOS_DIR, 'upgrade-log.txt');
const TMUX_SESSION = 'claude-main';
const NOTIFY_CHANNEL = process.argv[2] || null;

// Auto-detect claude binary path
function findClaudeBin() {
  if (process.env.CLAUDE_BIN) {
    return process.env.CLAUDE_BIN;
  }

  const knownPaths = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.claude', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/bin/claude',
  ];

  for (const p of knownPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return 'claude';  // Fallback
}

const CLAUDE_BIN = findClaudeBin();

function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `[${timestamp}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function sendViaC4(message, source = 'system') {
  const c4ReceivePath = path.join(os.homedir(), '.claude/skills/comm-bridge/c4-receive.js');

  try {
    // Use execFileSync to avoid shell injection - passes arguments directly
    // Use --no-reply since system messages don't need a reply path
    execFileSync(
      'node',
      [c4ReceivePath, '--source', source, '--priority', '1', '--no-reply', '--content', message],
      { stdio: 'inherit' }
    );
    return true;
  } catch (err) {
    log(`Failed to send via C4: ${err.message}`);
    return false;
  }
}

function sendToTmux(text) {
  const msgId = `${Date.now()}-${process.pid}`;
  const tempFile = `/tmp/restart-msg-${msgId}.txt`;
  const bufferName = `restart-${msgId}`;

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

function tmuxHasSession() {
  try {
    execSync(`tmux has-session -t "${TMUX_SESSION}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

function getTmuxActivity() {
  try {
    const output = execSync(`tmux list-windows -t "${TMUX_SESSION}" -F '#{window_activity}' 2>/dev/null | head -1`, { encoding: 'utf8' });
    return parseInt(output.trim(), 10);
  } catch {
    return null;
  }
}

function isAtPrompt() {
  const activityTs = getTmuxActivity();
  if (!activityTs) return false;

  const now = Math.floor(Date.now() / 1000);
  const idleSeconds = now - activityTs;
  return idleSeconds >= 5;
}

function isClaudeRunning() {
  try {
    const panePid = execSync(`tmux list-panes -t "${TMUX_SESSION}" -F '#{pane_pid}' 2>/dev/null | head -1`, { encoding: 'utf8' }).trim();
    if (!panePid) return false;

    try {
      execSync(`pgrep -P ${panePid} -f "claude" > /dev/null 2>&1`);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

function sleep(seconds) {
  execSync(`sleep ${seconds}`);
}

function getSendCommand(channel) {
  if (!channel) {
    return '~/zylos/bin/notify.sh';
  }
  if (channel.startsWith('lark:')) {
    const chatId = channel.substring(5);
    return `~/zylos/lark-agent/send-reply.sh "${chatId}"`;
  }
  if (channel.startsWith('telegram:')) {
    const chatId = channel.substring(9);
    return `~/zylos/telegram-bot/send-reply.sh ${chatId}`;
  }
  if (channel === 'telegram') {
    return '~/zylos/telegram-bot/send-reply.sh';
  }
  return '~/zylos/bin/notify.sh';
}

async function main() {
  log('=== Claude Code Restart Started ===');

  if (NOTIFY_CHANNEL) {
    log(`Notification channel: ${NOTIFY_CHANNEL}`);
  } else {
    log('No channel provided, will use notify.sh');
  }

  // Wait for Claude to be at prompt
  log('Waiting for Claude to be at prompt...');
  sleep(2);

  const MAX_WAIT = 60;
  let waited = 0;

  while (waited < MAX_WAIT) {
    if (!tmuxHasSession()) {
      log('Tmux session not found');
      break;
    }
    if (isAtPrompt()) {
      log('Claude is at prompt, sending /exit...');
      sendToTmux('/exit');
      break;
    }
    sleep(3);
    waited += 3;
  }

  // Wait for the Claude process to actually exit
  log('Waiting for Claude to exit...');

  const MAX_EXIT_WAIT = 60;
  let exitWaited = 0;

  while (exitWaited < MAX_EXIT_WAIT) {
    try {
      const panePid = execSync(`tmux list-panes -t "${TMUX_SESSION}" -F '#{pane_pid}' 2>/dev/null | head -1`, { encoding: 'utf8' }).trim();
      if (!panePid) {
        log('Tmux session not found, proceeding...');
        break;
      }

      if (!isClaudeRunning()) {
        log('Claude process has exited');
        break;
      }
    } catch {
      break;
    }

    sleep(2);
    exitWaited += 2;
  }

  if (exitWaited >= MAX_EXIT_WAIT) {
    log('Warning: Timeout waiting for Claude to exit, proceeding anyway...');
  }

  // Small delay to ensure clean exit
  sleep(3);

  // Reset context monitor cooldowns
  log('Resetting context monitor cooldowns...');
  try { fs.unlinkSync('/tmp/context-alert-cooldown'); } catch {}
  try { fs.unlinkSync('/tmp/context-compact-scheduled'); } catch {}

  // Restart Claude
  log('Restarting Claude...');
  sleep(2);

  if (tmuxHasSession()) {
    sendToTmux(`cd ${ZYLOS_DIR}; ${CLAUDE_BIN} --dangerously-skip-permissions`);
    log('Claude restarted');
  } else {
    try {
      execSync(`tmux new-session -d -s "${TMUX_SESSION}" "cd ${ZYLOS_DIR} && ${CLAUDE_BIN} --dangerously-skip-permissions"`);
      log('Created new tmux session');
    } catch (err) {
      log(`Failed to create tmux session: ${err.message}`);
    }
  }

  // Send catch-up prompt via C4
  log('Waiting for Claude to be ready...');
  sleep(10);

  const SEND_CMD = getSendCommand(NOTIFY_CHANNEL);

  waited = 0;
  while (waited < 60) {
    if (isAtPrompt()) {
      log('Sending catch-up prompt via C4...');
      if (NOTIFY_CHANNEL) {
        sendViaC4(`[System] Restart complete. Read your memory files. Send confirmation via ${SEND_CMD}`);
      } else {
        sendViaC4('[System] Restart complete. Read your memory files. Send confirmation via ~/zylos/bin/notify.sh');
      }
      log('Catch-up prompt sent via C4');
      break;
    }
    sleep(5);
    waited += 5;
  }

  log('=== Restart Complete ===');
}

main();
