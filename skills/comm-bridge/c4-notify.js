#!/usr/bin/env node
/**
 * C4 Communication Bridge - Notification Interface
 * Sends message to primary_dm on all configured channels
 *
 * Usage: node c4-notify.js "<message>"
 * Example: node c4-notify.js "System alert: low disk space"
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');

function printUsage() {
  console.log('Usage: node c4-notify.js "<message>"');
  process.exit(1);
}

function readJsonFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    // Silently ignore
  }
  return null;
}

function sendViaChannel(channel, endpoint, message) {
  return new Promise((resolve) => {
    // Channels must provide send.js (Node.js standard)
    const script = path.join(SKILLS_DIR, channel, 'send.js');

    if (!fs.existsSync(script)) {
      resolve({ success: false, error: 'send.js not found' });
      return;
    }

    const args = endpoint ? [endpoint, message] : [message];

    const child = spawn('node', [script, ...args], {
      stdio: 'pipe'
    });

    child.on('close', (code) => {
      resolve({ success: code === 0 });
    });

    child.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    printUsage();
  }

  const message = args[0];

  if (!message) {
    console.error('Error: Message is required');
    printUsage();
  }

  let sentCount = 0;

  // 1. Send to Telegram primary_dm
  const tgConfig = readJsonFile(path.join(ZYLOS_DIR, 'telegram', 'config.json'));
  if (tgConfig && tgConfig.primary_dm) {
    const result = await sendViaChannel('telegram', null, message);
    if (result.success) {
      console.log('[notify] Sent to Telegram');
      sentCount++;
    } else {
      console.log('[notify] Failed to send to Telegram');
    }
  }

  // 2. Send to Lark primary_dm
  const larkConfig = readJsonFile(path.join(ZYLOS_DIR, 'lark', 'config.json'));
  if (larkConfig && larkConfig.primary_dm) {
    const result = await sendViaChannel('lark', larkConfig.primary_dm, message);
    if (result.success) {
      console.log(`[notify] Sent to Lark (${larkConfig.primary_dm})`);
      sentCount++;
    } else {
      console.log('[notify] Failed to send to Lark');
    }
  }

  // Check if any messages were sent
  if (sentCount === 0) {
    console.log('[notify] Warning: No channels available for notification');
    process.exit(1);
  }

  console.log(`[notify] Done. Sent to ${sentCount} channel(s)`);
}

main();
