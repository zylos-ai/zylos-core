#!/usr/bin/env node
/**
 * C4 Communication Bridge - Message Dispatcher
 * Polls for pending messages and delivers them serially to Claude via tmux
 * Supports priority-based queue with idle-state checking for require_idle messages
 *
 * Run with PM2: pm2 start c4-dispatcher.js --name c4-dispatcher
 */

import { execFileSync } from 'child_process';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import {
  getNextPending,
  markDelivered,
  getPendingCount,
  close,
  incrementRetryCount,
  markFailed,
  updateAttachment
} from './c4-db.js';
import {
  POLL_INTERVAL_BASE,
  POLL_INTERVAL_MAX,
  DELIVERY_DELAY_BASE,
  DELIVERY_DELAY_PER_KB,
  DELIVERY_DELAY_MAX,
  MAX_RETRIES,
  RETRY_BASE_MS,
  ENTER_VERIFY_MAX_RETRIES,
  ENTER_VERIFY_WAIT_MS,
  FILE_SIZE_THRESHOLD,
  TMUX_SESSION,
  CLAUDE_STATUS_FILE,
  ATTACHMENTS_DIR,
  STALE_STATUS_THRESHOLD,
  TMUX_MISSING_WARN_THRESHOLD
} from './c4-config.js';
import { validateChannel } from './c4-validate.js';

let isShuttingDown = false;
let pollInterval = POLL_INTERVAL_BASE;
let tmuxMissingChecks = 0;

function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${timestamp}] ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getClaudeState() {
  try {
    if (!existsSync(CLAUDE_STATUS_FILE)) {
      return { state: 'offline', healthy: false, reason: 'missing' };
    }

    const stats = statSync(CLAUDE_STATUS_FILE);
    const ageMs = Date.now() - stats.mtimeMs;
    if (ageMs > STALE_STATUS_THRESHOLD) {
      return { state: 'offline', healthy: false, reason: 'stale' };
    }

    const content = readFileSync(CLAUDE_STATUS_FILE, 'utf8');
    const status = JSON.parse(content);

    let state = status.state;
    if (!state && typeof status.idle_seconds === 'number') {
      state = status.idle_seconds >= 5 ? 'idle' : 'busy';
    }
    if (!state) {
      state = 'busy';
    }

    return { state, healthy: true };
  } catch (err) {
    log(`Warning: Error reading Claude status (${err.stack})`);
    return { state: 'offline', healthy: false, reason: 'error' };
  }
}

function isStatusFresh() {
  try {
    if (!existsSync(CLAUDE_STATUS_FILE)) {
      return false;
    }
    const stats = statSync(CLAUDE_STATUS_FILE);
    const ageMs = Date.now() - stats.mtimeMs;
    return ageMs <= STALE_STATUS_THRESHOLD;
  } catch {
    return false;
  }
}

function sanitizeMessage(message) {
  return message.replace(/[\x00-\x08\x0B-\x1F]/g, '');
}

function getDeliveryDelay(byteLength) {
  const extra = Math.floor(byteLength / 1024) * DELIVERY_DELAY_PER_KB;
  return Math.min(DELIVERY_DELAY_BASE + extra, DELIVERY_DELAY_MAX);
}

function getInputBoxText(capture) {
  const lines = capture.split('\n');
  const separatorIndexes = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\u2500+$/.test(line) && line.length > 10) {
      separatorIndexes.push(i);
    }
  }

  if (separatorIndexes.length < 2) {
    return null;
  }

  const start = separatorIndexes[separatorIndexes.length - 2] + 1;
  const end = separatorIndexes[separatorIndexes.length - 1];
  return lines.slice(start, end).join('\n');
}

function isInputBoxEmpty(capture) {
  const text = getInputBoxText(capture);
  if (text === null) {
    log('Warning: Unable to locate input box separators in capture-pane output');
    return false;
  }

  const stripped = text
    .replace(/\u276F/g, '')
    .replace(/[\s\u00a0]+/g, '');

  return stripped.length === 0;
}

async function sendToTmux(message) {
  const bufferName = `c4-msg-${process.pid}-${Date.now()}`;
  const sanitized = sanitizeMessage(message);
  const delayMs = getDeliveryDelay(Buffer.byteLength(sanitized, 'utf8'));

  try {
    execFileSync('tmux', ['set-buffer', '-b', bufferName, '--', sanitized], {
      stdio: 'pipe'
    });

    execFileSync('tmux', ['paste-buffer', '-b', bufferName, '-t', TMUX_SESSION], {
      stdio: 'pipe'
    });

    await sleep(delayMs);

    execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, 'Enter'], {
      stdio: 'pipe'
    });

    for (let attempt = 0; attempt < ENTER_VERIFY_MAX_RETRIES; attempt++) {
      await sleep(ENTER_VERIFY_WAIT_MS);

      const capture = execFileSync('tmux', ['capture-pane', '-p', '-t', TMUX_SESSION], {
        encoding: 'utf8',
        stdio: 'pipe'
      });

      if (isInputBoxEmpty(capture)) {
        return true;
      }

      execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, 'Enter'], {
        stdio: 'pipe'
      });
    }

    await sleep(ENTER_VERIFY_WAIT_MS);
    const finalCapture = execFileSync('tmux', ['capture-pane', '-p', '-t', TMUX_SESSION], {
      encoding: 'utf8',
      stdio: 'pipe'
    });

    return isInputBoxEmpty(finalCapture);
  } catch (err) {
    log(`Error sending to tmux: ${err.stack}`);
    return false;
  } finally {
    try {
      execFileSync('tmux', ['delete-buffer', '-b', bufferName], { stdio: 'pipe' });
    } catch {
      // Ignore buffer deletion errors
    }
  }
}

function ensureAttachment(msg) {
  const byteLength = Buffer.byteLength(msg.content || '', 'utf8');
  if (byteLength <= FILE_SIZE_THRESHOLD) {
    return { content: msg.content, attachmentPath: msg.attachment_path };
  }

  if (msg.attachment_path) {
    return { content: msg.content, attachmentPath: msg.attachment_path };
  }

  mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  const messageDir = path.join(ATTACHMENTS_DIR, String(msg.id));
  mkdirSync(messageDir, { recursive: true });
  const filePath = path.join(messageDir, 'message.txt');

  writeFileSync(filePath, msg.content || '', 'utf8');

  const summary = `[C4 Attachment] Message stored at: ${filePath}. Please read the file contents.`;
  updateAttachment(msg.id, messageDir, summary);

  return { content: summary, attachmentPath: messageDir };
}

async function handleDeliveryFailure(msg) {
  const channelHealthy = isStatusFresh();

  if (channelHealthy) {
    const currentCount = msg.retry_count || 0;
    const nextCount = currentCount + 1;

    incrementRetryCount(msg.id);

    if (nextCount >= MAX_RETRIES) {
      markFailed(msg.id);
      log(`FAILED: Message id=${msg.id} channel=${msg.channel} marked as failed after ${nextCount} retries`);
      return;
    }
    const backoff = RETRY_BASE_MS * 2 ** (nextCount - 1);
    log(`Retry ${nextCount} for message id=${msg.id} after ${backoff}ms`);
    await sleep(backoff);
    return;
  }

  log(`Channel unhealthy; backing off for ${RETRY_BASE_MS}ms`);
  await sleep(RETRY_BASE_MS);
}

async function processNextMessage() {
  const claudeState = getClaudeState();

  if (claudeState.state === 'offline' || claudeState.state === 'stopped') {
    tmuxMissingChecks += 1;
    if (tmuxMissingChecks === TMUX_MISSING_WARN_THRESHOLD) {
      log(`WARNING: Claude tmux session missing for ${TMUX_MISSING_WARN_THRESHOLD} consecutive checks`);
    }
    return { delivered: false, state: claudeState.state };
  }

  tmuxMissingChecks = 0;

  // Get next pending message
  let msg = getNextPending();
  if (!msg) {
    return { delivered: false, state: claudeState.state };
  }

  validateChannel(msg.channel, false);

  // If message requires idle but Claude not idle, wait
  if (msg.require_idle === 1 && claudeState.state !== 'idle') {
    return { delivered: false, state: claudeState.state };
  }

  log(`Delivering message id=${msg.id} priority=${msg.priority} from ${msg.channel}`);

  const { content: deliveryContent } = ensureAttachment(msg);

  const success = await sendToTmux(deliveryContent);

  if (success) {
    markDelivered(msg.id);
    log(`Message id=${msg.id} delivered`);
    return { delivered: true, state: claudeState.state };
  }

  log(`Failed to deliver message id=${msg.id}, will retry`);
  await handleDeliveryFailure(msg);
  return { delivered: false, state: claudeState.state };
}

async function dispatcherLoop() {
  while (!isShuttingDown) {
    try {
      const { delivered, state } = await processNextMessage();

      if (delivered) {
        pollInterval = POLL_INTERVAL_BASE;
        await sleep(POLL_INTERVAL_BASE);
        continue;
      }

      if (state === 'idle') {
        pollInterval = Math.min(POLL_INTERVAL_MAX, pollInterval + POLL_INTERVAL_BASE);
      } else {
        pollInterval = POLL_INTERVAL_BASE;
      }

      await sleep(pollInterval);
    } catch (err) {
      log(`Dispatcher error: ${err.stack}`);
      await sleep(pollInterval);
    }
  }
}

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('Shutting down...');
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main() {
  log('=== C4 Dispatcher Started ===');
  log(`Tmux session: ${TMUX_SESSION}`);
  log(`Poll interval: ${POLL_INTERVAL_BASE}ms (adaptive up to ${POLL_INTERVAL_MAX}ms)`);

  const pending = getPendingCount();
  if (pending > 0) {
    log(`Found ${pending} pending message(s) in queue`);
  }

  await dispatcherLoop();
  close();
  process.exit(0);
}

main();
