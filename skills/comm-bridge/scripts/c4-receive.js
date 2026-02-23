#!/usr/bin/env node
/**
 * C4 Communication Bridge - Receive Interface
 * Receives messages from external channels and queues them for Claude
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { insertConversation, close } from './c4-db.js';
import { validateChannel, validateEndpoint } from './c4-validate.js';
import {
  FILE_SIZE_THRESHOLD,
  ATTACHMENTS_DIR,
  CONTENT_PREVIEW_CHARS,
  CLAUDE_STATUS_FILE,
  PENDING_CHANNELS_FILE,
  DATA_DIR
} from './c4-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printUsage() {
  console.log('Usage: node c4-receive.js --channel <channel> [--endpoint <endpoint_id>] [--priority <1-3>] [--no-reply] [--require-idle] [--json] --content "<message>"');
  console.log('');
  console.log('Options:');
  console.log('  --no-reply       Do not append "reply via" suffix (use for system messages)');
  console.log('  --require-idle   Only deliver when Claude is idle');
  console.log('  --json           Output structured JSON');
  console.log('');
  console.log('Priority levels:');
  console.log('  1 = Urgent (system messages)');
  console.log('  2 = High (important user messages)');
  console.log('  3 = Normal (default)');
}

function parseArgs(args) {
  const result = {
    channel: null,
    endpoint: null,
    content: null,
    priority: 3,
    noReply: false,
    requireIdle: false,
    json: false
  };

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
      case '--json':
        result.json = true;
        break;
      case '--content':
        result.content = args[++i];
        break;
      default:
        if (args[i].startsWith('--')) {
          return { error: `Unknown option: ${args[i]}` };
        }
        return { error: `Unexpected argument: ${args[i]}` };
    }
  }

  return result;
}

function readHealthStatus() {
  try {
    if (!fs.existsSync(CLAUDE_STATUS_FILE)) {
      return 'ok';
    }
    const status = JSON.parse(fs.readFileSync(CLAUDE_STATUS_FILE, 'utf8'));
    if (status && typeof status.health === 'string') {
      return status.health;
    }
    return 'ok';
  } catch {
    // Fail-open by design: status read failures do not block intake.
    return 'ok';
  }
}

function loadPendingChannelKeys() {
  if (!fs.existsSync(PENDING_CHANNELS_FILE)) {
    return new Set();
  }

  const keys = new Set();
  const content = fs.readFileSync(PENDING_CHANNELS_FILE, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.channel && record.endpoint) {
        keys.add(`${record.channel}::${record.endpoint}`);
      }
    } catch {
      // Ignore broken lines and keep appending new records.
    }
  }
  return keys;
}

function recordPendingChannel(channel, endpoint) {
  if (!channel || !endpoint) return;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    // Strip |msg:xxx from endpoint so same chat deduplicates correctly.
    // Recovery notices should go to the chat, not reply to a specific message.
    const normalizedEndpoint = endpoint.replace(/\|msg:[^|]+/, '');
    const key = `${channel}::${normalizedEndpoint}`;
    const keys = loadPendingChannelKeys();
    if (keys.has(key)) return;
    const line = `${JSON.stringify({ channel, endpoint: normalizedEndpoint })}\n`;
    fs.appendFileSync(PENDING_CHANNELS_FILE, line, 'utf8');
  } catch (err) {
    console.error(`[C4] Warning: failed to record pending channel (${err.message})`);
  }
}

function emitSuccess(json, recordId) {
  if (json) {
    console.log(JSON.stringify({ ok: true, action: 'queued', id: recordId }));
    return;
  }
  console.log(`[C4] Message queued (id=${recordId})`);
}

function emitError(json, code, message, exitCode = 1) {
  if (json) {
    console.log(JSON.stringify({
      ok: false,
      error: { code, message }
    }));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(exitCode);
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    const asJson = process.argv.slice(2).includes('--json');
    emitError(asJson, 'INVALID_ARGS', parsed.error);
  }

  const { channel: rawChannel, endpoint, content, priority, noReply, requireIdle, json } = parsed;
  let channel = rawChannel;

  if (!channel && noReply) {
    channel = 'system';
  }

  if (!channel && !noReply) {
    if (!json) printUsage();
    emitError(json, 'INVALID_ARGS', '--channel is required unless --no-reply is set');
  }

  if (!content) {
    if (!json) printUsage();
    emitError(json, 'INVALID_ARGS', '--content is required');
  }

  if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
    if (!json) printUsage();
    emitError(json, 'INVALID_ARGS', '--priority must be an integer 1, 2, or 3');
  }

  try {
    validateChannel(channel, !noReply);
  } catch (err) {
    emitError(json, 'INVALID_ARGS', `invalid channel: ${err.message}`);
  }

  if (endpoint) {
    try {
      validateEndpoint(endpoint);
    } catch (err) {
      emitError(json, 'INVALID_ARGS', `invalid endpoint: ${err.message}`);
    }
  }

  const health = readHealthStatus();
  if (health !== 'ok') {
    recordPendingChannel(channel, endpoint);
    if (health === 'down') {
      emitError(json, 'HEALTH_DOWN', "I'm currently offline and unable to recover on my own. Please let the admin know so they can take a look!");
    }
    if (health === 'rate_limited') {
      let msg = "I'm currently rate-limited by the API and can't process messages right now.";
      try {
        const status = JSON.parse(fs.readFileSync(CLAUDE_STATUS_FILE, 'utf8'));
        if (status.rate_limit_reset_at) {
          const secsLeft = status.rate_limit_reset_at - Math.floor(Date.now() / 1000);
          if (secsLeft > 0) {
            const minsLeft = Math.ceil(secsLeft / 60);
            msg += ` Expected to be back in about ${minsLeft} minute${minsLeft !== 1 ? 's' : ''}.`;
          }
        }
      } catch { }
      msg += " I'll auto-recover once the limit resets — no need to restart me!";
      emitError(json, 'HEALTH_RATE_LIMITED', msg);
    }
    emitError(json, 'HEALTH_RECOVERING', "I'm temporarily unavailable but should be back shortly. I'll reach out once I'm ready!");
  }

  let replyViaSuffix = '';
  if (!noReply) {
    const scriptDir = __dirname;
    const replyViaBase = `reply via: node ${path.join(scriptDir, 'c4-send.js')} "${channel}"`;
    replyViaSuffix = endpoint ? ` ---- ${replyViaBase} "${endpoint}"` : ` ---- ${replyViaBase}`;
  }

  const fullMessage = content + replyViaSuffix;
  let dbContent = fullMessage;
  const byteLength = Buffer.byteLength(fullMessage, 'utf8');

  if (byteLength > FILE_SIZE_THRESHOLD) {
    const msgId = `${Date.now()}-${process.pid}`;
    const messageDir = path.join(ATTACHMENTS_DIR, msgId);
    fs.mkdirSync(messageDir, { recursive: true });
    const filePath = path.join(messageDir, 'message.txt');
    fs.writeFileSync(filePath, fullMessage, 'utf8');

    const preview = content.substring(0, CONTENT_PREVIEW_CHARS);
    const ellipsis = preview.length < content.length ? '...' : '';
    const sizeKB = (byteLength / 1024).toFixed(1);
    dbContent = `${preview}${ellipsis}\n\n[C4] Full message (${sizeKB}KB) at: ${filePath}${replyViaSuffix}`;
  }

  try {
    const record = insertConversation('in', channel, endpoint, dbContent, 'pending', priority, requireIdle);
    emitSuccess(json, record.id);
  } catch (err) {
    emitError(json, 'INTERNAL_ERROR', `failed to queue message: ${err.message}`);
  } finally {
    close();
  }
}

main();
