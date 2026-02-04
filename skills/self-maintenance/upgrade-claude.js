#!/usr/bin/env node
/**
 * Claude Code Self-Upgrade Script (C4-integrated)
 * This script is triggered by Claude, runs detached, and survives the session exit
 * Usage: node upgrade-claude.js [channel]
 *   channel: Optional notification channel (e.g., "lark:oc_xxx" or "telegram")
 *            If provided, upgrade confirmation will be sent there
 *            If not provided, falls back to notify.sh (sends to primary_dm)
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Auto-detect zylos directory
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const LOG_FILE = path.join(ZYLOS_DIR, 'upgrade-log.txt');
const TMUX_SESSION = 'claude-main';
const NOTIFY_CHANNEL = process.argv[2] || null;

function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `[${timestamp}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function sendViaC4(message, source = 'system') {
  const c4ReceivePath = path.join(os.homedir(), '.claude/skills/comm-bridge/c4-receive.js');

  try {
    execSync(
      `node "${c4ReceivePath}" --source ${source} --content "${message.replace(/"/g, '\\"')}"`,
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
  const tempFile = `/tmp/upgrade-msg-${msgId}.txt`;
  const bufferName = `upgrade-${msgId}`;

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
  log('=== Claude Code Upgrade Started ===');

  if (NOTIFY_CHANNEL) {
    log(`Notification channel: ${NOTIFY_CHANNEL}`);
  } else {
    log('No channel provided, will use notify.sh');
  }

  // Wait for Claude to be at prompt before sending /exit
  log('Waiting for Claude to be at prompt...');
  sleep(2);

  const MAX_PROMPT_WAIT = 120;
  let promptWaited = 0;

  while (promptWaited < MAX_PROMPT_WAIT) {
    if (!tmuxHasSession()) {
      log('Tmux session not found');
      break;
    }

    if (isAtPrompt()) {
      log('Claude is at prompt, sending /exit...');
      sendToTmux('/exit');
      log('Sent /exit command');
      break;
    }

    log(`Not at prompt yet, waiting... (${promptWaited} sec)`);
    sleep(5);
    promptWaited += 5;
  }

  if (promptWaited >= MAX_PROMPT_WAIT) {
    log('Warning: Timeout waiting for prompt, trying /exit anyway...');
    sendToTmux('/exit');
  }

  log('Waiting for Claude session to exit...');

  // Wait for the Claude process in tmux to exit
  const MAX_WAIT = 60;
  let waited = 0;

  while (waited < MAX_WAIT) {
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
    waited += 2;
  }

  if (waited >= MAX_WAIT) {
    log('Warning: Timeout waiting for Claude to exit, proceeding anyway...');
  }

  // Small delay to ensure clean exit
  sleep(3);

  log('Starting upgrade...');

  // Run the upgrade
  try {
    process.chdir(os.homedir());
    const output = execSync('curl -fsSL https://claude.ai/install.sh | bash', {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    log(output);
    log('Upgrade completed successfully');
  } catch (err) {
    log(`ERROR: Upgrade failed! ${err.message}`);
    process.exit(1);
  }

  // Check new version
  let newVersion = 'unknown';
  try {
    newVersion = execSync(`${os.homedir()}/.local/bin/claude --version 2>/dev/null`, { encoding: 'utf8' }).trim();
  } catch {}
  log(`New version: ${newVersion}`);

  // Reset context monitor cooldowns
  log('Resetting context monitor cooldowns...');
  try { fs.unlinkSync('/tmp/context-alert-cooldown'); } catch {}
  try { fs.unlinkSync('/tmp/context-compact-scheduled'); } catch {}
  log('Context monitor reset complete');

  // Restart Claude in tmux
  log(`Restarting Claude in tmux session: ${TMUX_SESSION}`);
  sleep(2);

  if (tmuxHasSession()) {
    sendToTmux(`cd ${ZYLOS_DIR}; claude --dangerously-skip-permissions`);
    log('Claude restarted in existing tmux session');
  } else {
    try {
      execSync(`tmux new-session -d -s "${TMUX_SESSION}" "cd ${ZYLOS_DIR} && claude --dangerously-skip-permissions"`);
      log('Created new tmux session and started Claude');
    } catch (err) {
      log(`Failed to create tmux session: ${err.message}`);
    }
  }

  // Wait for Claude to be ready and send catch-up prompt via C4
  log('Waiting for Claude to be ready...');
  sleep(10);

  const SEND_CMD = getSendCommand(NOTIFY_CHANNEL);

  const MAX_CATCHUP_WAIT = 120;
  let catchupWait = 0;

  while (catchupWait < MAX_CATCHUP_WAIT) {
    if (isAtPrompt()) {
      log('Claude is ready, sending catch-up prompt via C4...');
      if (NOTIFY_CHANNEL) {
        sendViaC4(`[System] Upgrade complete. Read your memory files, check ~/zylos/upgrade-log.txt for the new version. Send confirmation via ${SEND_CMD}`);
      } else {
        sendViaC4('[System] Upgrade complete. Read your memory files, check ~/zylos/upgrade-log.txt for the new version. Send confirmation via ~/zylos/bin/notify.sh');
      }
      log('Sent catch-up prompt via C4');
      break;
    }

    log(`Claude not ready yet, waiting... (${catchupWait} sec)`);
    sleep(5);
    catchupWait += 5;
  }

  if (catchupWait >= MAX_CATCHUP_WAIT) {
    log('Warning: Timeout waiting for Claude to be ready');
    // Try to notify via notify.sh as fallback
    const notifyScript = path.join(ZYLOS_DIR, 'bin', 'notify.sh');
    if (fs.existsSync(notifyScript)) {
      log('Attempting to notify via notify.sh...');
      try {
        execSync(`"${notifyScript}" "Upgrade script completed but Claude may not have started properly. Check tmux session."`);
      } catch {}
    }
  }

  log('=== Upgrade Complete ===');
}

main();
