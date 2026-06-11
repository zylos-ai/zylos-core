#!/usr/bin/env node
/**
 * C4 Communication Bridge - Receive Interface
 * Receives messages from external channels and queues them for Claude
 */

import path from 'path';
import fs from 'fs';
import net from 'net';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  clearStatusNoticeCooldownReservation,
  insertConversation,
  close,
  reserveStatusNoticeCooldown
} from './c4-db.js';
import { validateChannel, validateEndpoint } from './c4-validate.js';
import {
  FILE_SIZE_THRESHOLD,
  ATTACHMENTS_DIR,
  CONTENT_PREVIEW_CHARS,
  AGENT_STATUS_FILE,
  ACTIVITY_MONITOR_DIR
} from './c4-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AM_SOCKET_PATH = path.join(ACTIVITY_MONITOR_DIR, 'am.sock');
const ROUTER_IPC_TIMEOUT_MS = 30000;
const STATUS_NOTICE_COOLDOWN_SECONDS = Number.parseInt(process.env.C4_STATUS_NOTICE_COOLDOWN_SECONDS || '600', 10);

function printUsage() {
  console.log('Usage: node c4-receive.js --channel <channel> [--endpoint <endpoint_id>] [--priority <1-3>] [--no-reply] [--block-queue-until-idle] [--json] --content "<message>"');
  console.log('');
  console.log('Options:');
  console.log('  --no-reply       Do not append "reply via" suffix (use for system messages)');
  console.log('  --block-queue-until-idle');
  console.log('                   Wait for sustained idle, then block subsequent dispatch until execution settles');
  console.log('                   Legacy alias: --require-idle');
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
      case '--block-queue-until-idle':
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

function readHealthStatusFile() {
  try {
    if (!fs.existsSync(AGENT_STATUS_FILE)) {
      return { health: 'ok' };
    }
    let status = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        status = JSON.parse(fs.readFileSync(AGENT_STATUS_FILE, 'utf8'));
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!status && lastErr) throw lastErr;
    if (status && typeof status.health === 'string') {
      return status;
    }
    return { health: 'ok' };
  } catch {
    // Fail-open by design: status read failures do not block intake.
    return { health: 'ok' };
  }
}

function publicHealth(health) {
  if (health === 'ok' || health === 'rate_limited' || health === 'auth_failed') {
    return health;
  }
  return 'unavailable';
}

function buildFallbackMessage(status) {
  const health = publicHealth(status.health);
  if (health === 'rate_limited') {
    const resetInfo = status.rate_limit_reset ? ` I should be back around ${status.rate_limit_reset}.` : ' I should be back within an hour.';
    return `I've hit my usage limit.${resetInfo} Please send your message again after I'm back!`;
  }
  if (health === 'auth_failed') {
    return "I'm having authentication issues — please check the API credentials.";
  }
  return "I'm temporarily unavailable but should be back shortly. Please try again in a moment!";
}

function fallbackFileRoute() {
  const status = readHealthStatusFile();
  const health = publicHealth(status?.health);
  if (!status || typeof status.health !== 'string' || health === 'ok') {
    return { recovered: true, health: 'ok', fallback: true };
  }
  return {
    recovered: false,
    health,
    reason: status.unavailable_reason || health,
    userMessage: buildFallbackMessage(status),
    fallback: true
  };
}

function ipcRoute(request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(AM_SOCKET_PATH);
    let data = '';
    let settled = false;

    function settle(fn, value) {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(value);
    }

    function tryParseResponse(force = false) {
      const newlineIndex = data.indexOf('\n');
      if (newlineIndex === -1 && !force) return;
      const raw = newlineIndex === -1 ? data : data.slice(0, newlineIndex);
      try {
        settle(resolve, JSON.parse(raw));
      } catch {
        settle(reject, new Error('IPC response parse error'));
      }
    }

    socket.setTimeout(ROUTER_IPC_TIMEOUT_MS);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      data += chunk;
      tryParseResponse();
    });
    socket.on('end', () => {
      tryParseResponse(true);
    });
    socket.on('timeout', () => {
      settle(reject, new Error('IPC timeout'));
    });
    socket.on('error', (err) => settle(reject, err));
  });
}

function isValidRouteDecision(decision, noReply) {
  if (!decision || typeof decision.recovered !== 'boolean') return false;
  if (decision.recovered) return true;
  if (typeof decision.health !== 'string') return false;
  if (noReply) return true;
  return typeof decision.userMessage === 'string' && decision.userMessage.length > 0;
}

async function queryRoute(channel, endpoint, noReply) {
  try {
    const decision = await ipcRoute({
      version: 1,
      type: 'route',
      requestId: `${process.pid}-${Date.now()}`,
      channel,
      endpoint,
      noReply,
      receivedAt: Date.now()
    });
    if (!isValidRouteDecision(decision, noReply)) {
      throw new Error('IPC response invalid route decision');
    }
    return decision;
  } catch {
    return fallbackFileRoute();
  }
}

function emitSuccess(json, recordId, action = 'queued') {
  if (json) {
    console.log(JSON.stringify({ ok: true, action, id: recordId }));
    return;
  }
  if (action === 'queued') {
    console.log(`[C4] Message queued (id=${recordId})`);
  } else {
    console.log(`[C4] Message handled (id=${recordId}, action=${action})`);
  }
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

function sendUnhealthyMessage(channel, endpoint, message) {
  // c4-send requires an endpoint to route to; without one there is nothing to
  // deliver to, so fail cleanly instead of spawning an invalid invocation.
  if (!endpoint) {
    return { status: 1, stdout: '', stderr: 'no endpoint to deliver status notice', error: new Error('missing endpoint') };
  }
  const args = [path.join(__dirname, 'c4-send.js'), channel, endpoint];
  const result = spawnSync('node', args, {
    input: message,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  return result;
}

function normalizeStatusEndpoint(endpoint) {
  if (!endpoint) return '';
  // Group status-notice cooldowns by stable conversation root, not by each
  // incoming message/request id. This keeps thread-specific cooldowns while
  // suppressing repeated notices within the same root conversation.
  return endpoint.replace(/\|(msg|req|parent):[^|]+/g, '');
}

function statusNoticeType(route) {
  return publicHealth(route?.health);
}

function statusNoticeReason(route) {
  return String(route?.reason || statusNoticeType(route) || 'default');
}

function statusNoticeCooldownKey(channel, endpoint, route) {
  return [
    channel || 'unknown',
    normalizeStatusEndpoint(endpoint),
    statusNoticeType(route),
    statusNoticeReason(route)
  ].join('::');
}

function reserveStatusNoticeCooldownForRoute(channel, endpoint, route, now = Math.floor(Date.now() / 1000)) {
  const key = statusNoticeCooldownKey(channel, endpoint, route);
  const ttl = Number.isFinite(STATUS_NOTICE_COOLDOWN_SECONDS) && STATUS_NOTICE_COOLDOWN_SECONDS > 0
    ? STATUS_NOTICE_COOLDOWN_SECONDS
    : 600;
  return reserveStatusNoticeCooldown({
    cooldownKey: key,
    channel,
    endpoint: normalizeStatusEndpoint(endpoint),
    statusType: statusNoticeType(route),
    reason: statusNoticeReason(route),
    ttl,
    now
  });
}

function clearStatusNoticeCooldownReservationForRoute(key, reservedAt) {
  try {
    clearStatusNoticeCooldownReservation(key, reservedAt);
  } catch (err) {
    console.error(`[C4] Warning: failed to clear status cooldown reservation (${err.message})`);
  }
}

function buildFullMessage(content, channel, endpoint, noReply) {
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

  return dbContent;
}

async function main() {
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

  const route = await queryRoute(channel, endpoint, noReply);
  let dbContent = buildFullMessage(content, channel, endpoint, noReply);
  const dbStatus = route.recovered ? 'pending' : 'delivered';
  let cooldown = null;

  if (!route.recovered && !noReply) {
    try {
      cooldown = reserveStatusNoticeCooldownForRoute(channel, endpoint, route);
    } catch (err) {
      emitError(json, 'INTERNAL_ERROR', `failed to reserve status cooldown: ${err.message}`);
    }
    if (cooldown.suppressed) {
      dbContent += `\n\n[C4] Status notification suppressed by cooldown while health=${statusNoticeType(route)} reason=${statusNoticeReason(route)}.`;
      try {
        const record = insertConversation('in', channel, endpoint, dbContent, dbStatus, priority, requireIdle, 'suppressed');
        emitSuccess(json, record.id, 'suppressed');
        return;
      } catch (err) {
        emitError(json, 'INTERNAL_ERROR', `failed to record suppressed unhealthy message: ${err.message}`);
      } finally {
        close();
      }
    }
  }

  try {
    const record = insertConversation('in', channel, endpoint, dbContent, dbStatus, priority, requireIdle);
    if (route.recovered || noReply) {
      emitSuccess(json, record.id, route.recovered ? 'queued' : 'delivered');
      return;
    }

    const sendResult = sendUnhealthyMessage(channel, endpoint, route.userMessage);
    if (sendResult.status === 0) {
      emitSuccess(json, record.id, 'delivered');
      return;
    }
    if (cooldown?.key && Number.isFinite(cooldown.reservedAt)) {
      clearStatusNoticeCooldownReservationForRoute(cooldown.key, cooldown.reservedAt);
    }
    const detail = sendResult.stderr || sendResult.stdout || `exit ${sendResult.status}`;
    emitError(json, 'UNHEALTHY_NOTIFY_FAILED', `failed to send unhealthy status message: ${detail.trim()}`);
  } catch (err) {
    emitError(json, 'INTERNAL_ERROR', `failed to queue message: ${err.message}`);
  } finally {
    close();
  }
}

main();
