#!/usr/bin/env node
/**
 * C4 Communication Bridge - Send Interface
 * Sends messages from Claude to external channels
 *
 * Usage: node c4-send.js <source> [endpoint_id] "<message>"
 * Example: node c4-send.js telegram 8101553026 "Hello Howard!"
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawn } from 'child_process';
import { insertConversation } from './c4-db.js';

const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

function printUsage() {
  console.log('Usage: node c4-send.js <source> [endpoint_id] "<message>"');
  console.log('Example: node c4-send.js telegram 8101553026 "Hello!"');
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    printUsage();
  }

  const source = args[0];
  let endpoint = null;
  let message = null;

  // Check if we have endpoint_id or just message
  if (args.length === 2) {
    // Only source and message
    message = args[1];
  } else {
    // source, endpoint, message
    endpoint = args[1];
    message = args[2];
  }

  if (!message) {
    console.error('Error: Message is required');
    process.exit(1);
  }

  // Record to database (direction=out)
  try {
    insertConversation('out', source, endpoint, message);
  } catch (err) {
    // Silently ignore DB errors
  }

  // Find and call channel send script (must be .js - channel standard)
  const channelScript = path.join(SKILLS_DIR, source, 'send.js');

  if (!fs.existsSync(channelScript)) {
    console.error(`Error: Channel script not found: ${channelScript}`);
    console.error('Channels must provide send.js (Node.js standard)');
    process.exit(1);
  }

  // Call channel script
  const scriptArgs = endpoint ? [endpoint, message] : [message];

  const child = spawn('node', [channelScript, ...scriptArgs], {
    stdio: 'inherit'
  });

  child.on('close', (code) => {
    if (code === 0) {
      console.log(`[C4] Message sent via ${source}`);
    } else {
      console.log(`[C4] Failed to send message via ${source} (exit code: ${code})`);
    }
    process.exit(code);
  });

  child.on('error', (err) => {
    console.error(`[C4] Error executing channel script: ${err.message}`);
    process.exit(1);
  });
}

main();
