#!/usr/bin/env node
/**
 * C4 Communication Bridge - Receive Interface
 * Receives messages from external channels and queues them for Claude
 *
 * Queue mode: Messages are written to DB with status='pending'
 * The c4-dispatcher process handles serial delivery to Claude
 *
 * Usage: node c4-receive.js --source <source> --endpoint <endpoint_id> --content "<message>"
 * Example: node c4-receive.js --source telegram --endpoint 8101553026 --content "[TG DM] user said: hello"
 */

const path = require('path');
const { insertConversation } = require('./c4-db');

function printUsage() {
  console.log('Usage: node c4-receive.js --source <source> --endpoint <endpoint_id> --content "<message>"');
  console.log('Example: node c4-receive.js --source telegram --endpoint 8101553026 --content "[TG DM] user said: hello"');
  process.exit(1);
}

function parseArgs(args) {
  const result = { source: null, endpoint: null, content: null };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--source':
        result.source = args[++i];
        break;
      case '--endpoint':
        result.endpoint = args[++i];
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
  const { source, endpoint, content } = parseArgs(args);

  // Validate required arguments
  if (!source) {
    console.error('Error: --source is required');
    printUsage();
  }

  if (!content) {
    console.error('Error: --content is required');
    printUsage();
  }

  // Assemble message with reply via
  const scriptDir = __dirname;
  let replyVia;
  if (endpoint) {
    replyVia = `reply via: node ${path.join(scriptDir, 'c4-send.js')} ${source} ${endpoint}`;
  } else {
    replyVia = `reply via: node ${path.join(scriptDir, 'c4-send.js')} ${source}`;
  }

  const fullMessage = `${content} ---- ${replyVia}`;

  // Queue message to database (status='pending')
  // The c4-dispatcher will handle delivery to Claude
  try {
    const record = insertConversation('in', source, endpoint, fullMessage, 'pending');
    console.log(`[C4] Message queued (id=${record.id})`);
  } catch (err) {
    console.error(`[C4] Failed to queue message: ${err.message}`);
    process.exit(1);
  }
}

main();
