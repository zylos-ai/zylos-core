#!/usr/bin/env node
/**
 * C4 Communication Bridge - Receive Interface
 * Receives messages from external channels and forwards to Claude
 *
 * Usage: node c4-receive.js --source <source> --endpoint <endpoint_id> --content "<message>"
 * Example: node c4-receive.js --source telegram --endpoint 8101553026 --content "[TG DM] user said: hello"
 */

const path = require('path');
const { execSync } = require('child_process');
const { insertConversation } = require('./c4-db');

const TMUX_SESSION = process.env.TMUX_SESSION || 'claude';

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

function sendToTmux(message) {
  const bufferName = `c4-msg-${process.pid}-${Date.now()}`;

  try {
    // Set buffer with the message
    execSync(`tmux set-buffer -b "${bufferName}" "${message.replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`, {
      stdio: 'pipe'
    });

    // Paste buffer to session
    execSync(`tmux paste-buffer -b "${bufferName}" -t "${TMUX_SESSION}"`, {
      stdio: 'pipe'
    });

    // Send Enter key
    execSync(`tmux send-keys -t "${TMUX_SESSION}" Enter`, {
      stdio: 'pipe'
    });

    // Delete buffer
    execSync(`tmux delete-buffer -b "${bufferName}"`, {
      stdio: 'pipe'
    });

    return true;
  } catch (err) {
    console.error(`[C4] Error sending to tmux: ${err.message}`);
    return false;
  }
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

  // Record to database (direction=in)
  try {
    insertConversation('in', source, endpoint, content);
  } catch (err) {
    // Silently ignore DB errors
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

  // Send to Claude via tmux paste-buffer
  if (sendToTmux(fullMessage)) {
    console.log('[C4] Message received and forwarded to Claude');
  } else {
    process.exit(1);
  }
}

main();
