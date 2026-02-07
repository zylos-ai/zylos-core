#!/usr/bin/env node
/**
 * C4 Communication Bridge - Send Interface
 * Sends messages from Claude to external channels
 *
 * Usage: node c4-send.js <channel> [endpoint_id] "<message>"
 * Example: node c4-send.js telegram 8101553026 "Hello Howard!"
 */

import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { insertConversation, close } from './c4-db.js';
import { SKILLS_DIR } from './c4-config.js';
import { validateChannel, validateEndpoint } from './c4-validate.js';

function printUsage() {
  console.log('Usage: node c4-send.js <channel> [endpoint_id] "<message>"');
  console.log('Example: node c4-send.js telegram 8101553026 "Hello!"');
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    printUsage();
  }

  const channel = args[0];
  let endpoint = null;
  let message = null;

  if (args.length === 2) {
    message = args[1];
  } else {
    endpoint = args[1];
    message = args[2];
  }

  if (!message) {
    console.error('Error: Message is required');
    process.exit(1);
  }

  try {
    validateChannel(channel, true);
  } catch (err) {
    console.error(`[C4] Invalid channel: ${err.stack}`);
    process.exit(1);
  }

  if (endpoint) {
    try {
      validateEndpoint(endpoint);
    } catch (err) {
      console.error(`[C4] Invalid endpoint: ${err.stack}`);
      process.exit(1);
    }
  }

  try {
    insertConversation('out', channel, endpoint, message);
  } catch (err) {
    console.error(`[C4] Warning: DB audit write failed: ${err.stack}`);
  } finally {
    close();
  }

  const channelScript = path.join(SKILLS_DIR, channel, 'scripts', 'send.js');

  if (!fs.existsSync(channelScript)) {
    console.error(`Error: Channel script not found: ${channelScript}`);
    console.error('Channels must provide scripts/send.js (Node.js standard)');
    process.exit(1);
  }

  const scriptArgs = endpoint ? [endpoint, message] : [message];

  const child = spawn('node', [channelScript, ...scriptArgs], {
    stdio: 'inherit'
  });

  child.on('close', (code) => {
    if (code === 0) {
      console.log(`[C4] Message sent via ${channel}`);
    } else {
      console.log(`[C4] Failed to send message via ${channel} (exit code: ${code})`);
    }
    process.exit(code);
  });

  child.on('error', (err) => {
    console.error(`[C4] Error executing channel script: ${err.stack}`);
    process.exit(1);
  });
}

main();
