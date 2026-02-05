#!/usr/bin/env node
/**
 * C4 Communication Bridge - Receive Interface
 * Receives messages from external channels and queues them for Claude
 *
 * Queue mode: Messages are written to DB with status='pending'
 * The c4-dispatcher process handles serial delivery to Claude
 *
 * Usage: node c4-receive.js --source <source> [--endpoint <endpoint_id>] [--priority <1-3>] [--no-reply] [--require-idle] --content "<message>"
 * Example: node c4-receive.js --source telegram --endpoint 8101553026 --content "[TG DM] user said: hello"
 * Example: node c4-receive.js --source system --priority 1 --no-reply --content "[System] Check context usage"
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { insertConversation } from './c4-db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printUsage() {
  console.log('Usage: node c4-receive.js --source <source> [--endpoint <endpoint_id>] [--priority <1-3>] [--no-reply] [--require-idle] --content "<message>"');
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
  console.log('  node c4-receive.js --source telegram --endpoint 8101553026 --content "[TG DM] user said: hello"');
  console.log('  node c4-receive.js --source system --priority 1 --no-reply --content "[System] Check context"');
  process.exit(1);
}

function parseArgs(args) {
  const result = { source: null, endpoint: null, content: null, priority: 3, noReply: false, requireIdle: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--source':
        result.source = args[++i];
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
  const { source, endpoint, content, priority, noReply, requireIdle } = parseArgs(args);

  // Validate required arguments
  if (!source) {
    console.error('Error: --source is required');
    printUsage();
  }

  if (!content) {
    console.error('Error: --content is required');
    printUsage();
  }

  // Validate priority
  if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
    console.error('Error: --priority must be an integer 1, 2, or 3');
    printUsage();
  }

  // Assemble message (optionally with reply via)
  let fullMessage = content;

  if (!noReply) {
    const scriptDir = __dirname;
    let replyVia;
    if (endpoint) {
      replyVia = `reply via: node ${path.join(scriptDir, 'c4-send.js')} ${source} ${endpoint}`;
    } else {
      replyVia = `reply via: node ${path.join(scriptDir, 'c4-send.js')} ${source}`;
    }
    fullMessage = `${content} ---- ${replyVia}`;
  }

  // Queue message to database (status='pending')
  // The c4-dispatcher will handle delivery to Claude
  try {
    const record = insertConversation('in', source, endpoint, fullMessage, 'pending', priority, requireIdle);
    console.log(`[C4] Message queued (id=${record.id}, priority=${priority}${requireIdle ? ', require_idle' : ''})`);
  } catch (err) {
    console.error(`[C4] Failed to queue message: ${err.message}`);
    process.exit(1);
  }
}

main();
