#!/usr/bin/env node
/**
 * C4 Communication Bridge - Receive Interface
 * Receives messages from external channels and queues them for Claude
 *
 * Queue mode: Messages are written to DB with status='pending'
 * The c4-dispatcher process handles serial delivery to Claude
 *
 * Usage: node c4-receive.js --channel <channel> [--endpoint <endpoint_id>] [--priority <1-3>] [--no-reply] [--require-idle] --content "<message>"
 * Example: node c4-receive.js --channel telegram --endpoint 8101553026 --content "[TG DM] user said: hello"
 * Example: node c4-receive.js --channel system --priority 1 --no-reply --content "[System] Check context usage"
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { insertConversation } from './c4-db.js';
import { validateChannel, validateEndpoint } from './c4-validate.js';
import { FILE_SIZE_THRESHOLD, ATTACHMENTS_DIR } from './c4-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printUsage() {
  console.log('Usage: node c4-receive.js --channel <channel> [--endpoint <endpoint_id>] [--priority <1-3>] [--no-reply] [--require-idle] --content "<message>"');
  console.log('');
  console.log('Options:');
  console.log('  --no-reply       Do not append "reply via" suffix (use for system messages)');
  console.log('  --require-idle   Only deliver when Claude is idle');
  console.log('');
  console.log('Priority levels:');
  console.log('  1 = Urgent (system messages)');
  console.log('  2 = High (important user messages)');
  console.log('  3 = Normal (default)');
  console.log('');
  console.log('Examples:');
  console.log('  node c4-receive.js --channel telegram --endpoint 8101553026 --content "[TG DM] user said: hello"');
  console.log('  node c4-receive.js --channel system --priority 1 --no-reply --content "[System] Check context"');
  process.exit(1);
}

function parseArgs(args) {
  const result = { channel: null, endpoint: null, content: null, priority: 3, noReply: false, requireIdle: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--channel':
        result.channel = args[++i];
        break;
      case '--endpoint':
        result.endpoint = args[++i];
        break;
      case '--priority':
        result.priority = parseInt(args[++i], 10);
        break;
      case '--no-reply':
        result.noReply = true;
        break;
      case '--require-idle':
        result.requireIdle = true;
        break;
      case '--content':
        result.content = args[++i];
        break;
      default:
        if (args[i].startsWith('--')) {
          console.error(`Unknown option: ${args[i]}`);
          process.exit(1);
        }
    }
  }

  return result;
}

function main() {
  const args = process.argv.slice(2);
  const { channel: rawChannel, endpoint, content, priority, noReply, requireIdle } = parseArgs(args);

  let channel = rawChannel;

  if (!channel && noReply) {
    channel = 'system';
  }

  if (!channel && !noReply) {
    console.error('Error: --channel is required unless --no-reply is set');
    printUsage();
  }

  if (!content) {
    console.error('Error: --content is required');
    printUsage();
  }

  if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
    console.error('Error: --priority must be an integer 1, 2, or 3');
    printUsage();
  }

  try {
    validateChannel(channel, !noReply);
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

  let fullMessage = content;

  if (!noReply) {
    const scriptDir = __dirname;
    const replyViaBase = `reply via: node ${path.join(scriptDir, 'c4-send.js')} "${channel}"`;
    const replyVia = endpoint ? `${replyViaBase} "${endpoint}"` : replyViaBase;
    fullMessage = `${content} ---- ${replyVia}`;
  }

  // Check if message exceeds size threshold — store as attachment file
  let attachmentPath = null;
  let dbContent = fullMessage;
  const byteLength = Buffer.byteLength(fullMessage, 'utf8');
  if (byteLength > FILE_SIZE_THRESHOLD) {
    const msgId = `${Date.now()}-${process.pid}`;
    const messageDir = path.join(ATTACHMENTS_DIR, msgId);
    fs.mkdirSync(messageDir, { recursive: true });
    const filePath = path.join(messageDir, 'message.txt');
    fs.writeFileSync(filePath, fullMessage, 'utf8');
    attachmentPath = messageDir;
    dbContent = `[C4 Attachment] Message stored at: ${filePath}. Please read the file contents.`;
  }

  try {
    const record = insertConversation('in', channel, endpoint, dbContent, 'pending', priority, requireIdle, attachmentPath);
    console.log(`[C4] Message queued (id=${record.id}, priority=${priority}${requireIdle ? ', require_idle' : ''}${attachmentPath ? ', attachment' : ''})`);
  } catch (err) {
    console.error(`[C4] Failed to queue message: ${err.stack}`);
    process.exit(1);
  }
}

main();
