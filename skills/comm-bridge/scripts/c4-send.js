#!/usr/bin/env node
/**
 * C4 Communication Bridge - Send Interface
 * Sends messages from Claude to external channels
 *
 * Usage:
 *   Recommended (stdin — safe for any content):
 *     node c4-send.js <channel> <endpoint_id> <<'EOF'
 *     message with "quotes", $vars, and special chars
 *     EOF
 *
 *   Simple messages (CLI arg — backward compatible):
 *     node c4-send.js <channel> [endpoint_id] "short message"
 *
 * When no message argument is provided, the message is read from stdin.
 * This avoids shell escaping issues with quotes and special characters.
 */

import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { insertConversation, close } from './c4-db.js';
import { SKILLS_DIR } from './c4-config.js';
import { validateChannel, validateEndpoint } from './c4-validate.js';

function printUsage() {
  console.log('Usage: node c4-send.js <channel> <endpoint_id> <<\'EOF\'');
  console.log('       message content');
  console.log('       EOF');
  console.log('       node c4-send.js <channel> [endpoint_id] "message"');
  console.log('Example: node c4-send.js telegram 8101553026 "Hello!"');
  process.exit(1);
}

/**
 * Read all data from stdin.
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    printUsage();
  }

  // Remove --stdin flag if present (backward compat)
  const cleanArgs = args.filter(a => a !== '--stdin');
  const hasStdinFlag = cleanArgs.length !== args.length;
  const stdinAvailable = !process.stdin.isTTY;

  const channel = cleanArgs[0];
  let endpoint = null;
  let message = null;

  if (cleanArgs.length === 2 && (stdinAvailable || hasStdinFlag)) {
    // 2 args (channel + endpoint) with piped stdin or --stdin flag: read from stdin
    endpoint = cleanArgs[1];
    message = (await readStdin()).trimEnd();
  } else if (cleanArgs.length === 1 && (stdinAvailable || hasStdinFlag)) {
    // 1 arg (channel only) with piped stdin: read from stdin
    message = (await readStdin()).trimEnd();
  } else if (cleanArgs.length === 2) {
    // 2 args, no stdin: channel + message (no endpoint)
    message = cleanArgs[1];
  } else {
    // 3+ args: channel + endpoint + message
    endpoint = cleanArgs[1];
    message = cleanArgs[2];
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
