#!/usr/bin/env node
/**
 * C4 Communication Bridge - Message Dispatcher
 * Polls for pending messages and delivers them serially to Claude via tmux
 * Supports priority-based queue with idle-state checking for require_idle messages
 *
 * Run with PM2: pm2 start c4-dispatcher.js --name c4-dispatcher
 */

import { execFileSync } from 'child_process';
import { readFileSync, existsSync, statSync } from 'fs';
import {
  getNextPending,
  markDelivered,
  getPendingCount,
  close,
  incrementRetryCount,
  markFailed
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
  REQUIRE_IDLE_POST_SEND_HOLD_MS,
  REQUIRE_IDLE_EXECUTION_MAX_WAIT_MS,
  REQUIRE_IDLE_EXECUTION_POLL_MS,
  TMUX_SESSION,
  CLAUDE_STATUS_FILE,
  STALE_STATUS_THRESHOLD,
  TMUX_MISSING_WARN_THRESHOLD
} from './c4-config.js';

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

/**
 * Claude Code UI hint patterns that appear in the input box but do NOT
 * represent user content. When these are detected, the input box should
 * be considered "empty" (message was accepted).
 *
 * Known patterns:
 * - "Press up to edit queued messages" — shown when a message is queued
 *   while Claude is busy processing another message.
 */
const INPUT_BOX_HINT_PATTERNS = [
  /press\s*up\s*to\s*edit\s*queued\s*messages/i,
];

/**
 * Check the state of Claude Code's input box.
 * @returns {'empty'|'has_content'|'indeterminate'}
 *   'empty':         Input box is empty or shows only UI hints (message was accepted)
 *   'has_content':   Input box has user text (message not yet submitted, retry Enter)
 *   'indeterminate': Separators not visible — cannot determine input box state
 */
function checkInputBox(capture) {
  const text = getInputBoxText(capture);
  if (text === null) {
    return 'indeterminate';
  }

  // Strip prompt character (❯) and whitespace
  const stripped = text
    .replace(/\u276F/g, '')
    .replace(/[\s\u00a0]+/g, '');

  if (stripped.length === 0) {
    return 'empty';
  }

  // Check if the remaining text is a known Claude Code UI hint
  for (const pattern of INPUT_BOX_HINT_PATTERNS) {
    if (pattern.test(stripped)) {
      return 'empty';
    }
  }

  return 'has_content';
}

/**
 * Send Enter to tmux and verify the input box is empty (message was submitted).
 * Only sends Enter — does NOT paste any content.
 *
 * @returns {'submitted'|'has_content'|'indeterminate'}
 *   'submitted':     Input box confirmed empty after Enter
 *   'has_content':   Input box still has text after all Enter retries
 *   'indeterminate': Cannot determine — separator detection failed (needs investigation)
 */
async function submitAndVerify() {
  execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, 'Enter'], {
    stdio: 'pipe'
  });

  for (let attempt = 0; attempt < ENTER_VERIFY_MAX_RETRIES; attempt++) {
    await sleep(ENTER_VERIFY_WAIT_MS);

    const capture = execFileSync('tmux', ['capture-pane', '-p', '-t', TMUX_SESSION], {
      encoding: 'utf8',
      stdio: 'pipe'
    });

    const state = checkInputBox(capture);

    if (state === 'empty') {
      return 'submitted';
    }

    if (state === 'indeterminate') {
      log('Warning: input box separator detection failed — needs investigation');
      return 'indeterminate';
    }

    // state === 'has_content': input box still has text, retry Enter
    log(`Enter verify attempt ${attempt + 1}: input box has content, retrying Enter`);
    execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, 'Enter'], {
      stdio: 'pipe'
    });
  }

  // Final check
  await sleep(ENTER_VERIFY_WAIT_MS);
  const finalCapture = execFileSync('tmux', ['capture-pane', '-p', '-t', TMUX_SESSION], {
    encoding: 'utf8',
    stdio: 'pipe'
  });

  return checkInputBox(finalCapture) === 'has_content' ? 'has_content' : 'submitted';
}

/**
 * Paste a message into Claude's input box via tmux, then submit with Enter.
 *
 * Two-phase delivery:
 *   Phase 1 (paste):  set-buffer + paste-buffer → message appears in input box
 *   Phase 2 (submit): Enter + verify via submitAndVerify()
 *
 * Returns:
 *   'submitted':     Message was submitted to Claude (input box empty or indeterminate)
 *   'submit_failed': Paste succeeded but Enter verification failed (content still in input box)
 *   'paste_error':   tmux paste command itself failed
 */
async function sendToTmux(message) {
  const bufferName = `c4-msg-${process.pid}-${Date.now()}`;
  const sanitized = sanitizeMessage(message);
  const delayMs = getDeliveryDelay(Buffer.byteLength(sanitized, 'utf8'));

  try {
    // Phase 1: Paste message into input box (only done ONCE)
    execFileSync('tmux', ['set-buffer', '-b', bufferName, '--', sanitized], {
      stdio: 'pipe'
    });

    execFileSync('tmux', ['paste-buffer', '-b', bufferName, '-t', TMUX_SESSION], {
      stdio: 'pipe'
    });

    await sleep(delayMs);

    // Phase 2: Submit with Enter and verify
    const result = await submitAndVerify();

    if (result === 'has_content') {
      return 'submit_failed';
    }
    // 'submitted' or 'indeterminate' — message was accepted
    return 'submitted';
  } catch (err) {
    log(`Error sending to tmux: ${err.stack}`);
    return 'paste_error';
  } finally {
    try {
      execFileSync('tmux', ['delete-buffer', '-b', bufferName], { stdio: 'pipe' });
    } catch {
      // Ignore buffer deletion errors
    }
  }
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

async function waitForRequireIdleSettlement(msgId) {
  log(`require_idle message id=${msgId}: hold ${REQUIRE_IDLE_POST_SEND_HOLD_MS}ms before next dispatch`);
  await sleep(REQUIRE_IDLE_POST_SEND_HOLD_MS);

  let state = getClaudeState().state;
  if (state === 'offline' || state === 'stopped') {
    log(`require_idle message id=${msgId}: Claude state=${state}, continuing`);
    return;
  }

  // If still idle after hold, avoid waiting unnecessarily.
  if (state === 'idle') {
    log(`require_idle message id=${msgId}: Claude remained idle after hold, continuing`);
    return;
  }

  const deadline = Date.now() + REQUIRE_IDLE_EXECUTION_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(REQUIRE_IDLE_EXECUTION_POLL_MS);
    state = getClaudeState().state;

    if (state === 'idle' || state === 'offline' || state === 'stopped') {
      log(`require_idle message id=${msgId}: settled with Claude state=${state}`);
      return;
    }
  }

  log(
    `require_idle message id=${msgId}: timeout after ${REQUIRE_IDLE_EXECUTION_MAX_WAIT_MS}ms, continuing`
  );
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

  // If message requires idle but Claude not idle, block the entire queue.
  // This is intentional: prevents require_idle messages from being starved
  // by a continuous stream of lower-priority non-idle messages.
  if (msg.require_idle === 1 && claudeState.state !== 'idle') {
    return { delivered: false, state: claudeState.state };
  }

  log(`Delivering message id=${msg.id} priority=${msg.priority} from ${msg.channel}`);

  const deliveryContent = msg.content || '';

  const result = await sendToTmux(deliveryContent);

  if (result === 'submitted') {
    markDelivered(msg.id);
    log(`Message id=${msg.id} delivered`);
    if (msg.require_idle === 1) {
      await waitForRequireIdleSettlement(msg.id);
    }
    return { delivered: true, state: claudeState.state };
  }

  if (result === 'submit_failed') {
    // Message is already in the input box (paste succeeded).
    // Only retry Enter — do NOT re-paste the entire message.
    log(`Message id=${msg.id} pasted but Enter failed, retrying Enter only`);

    for (let retry = 0; retry < MAX_RETRIES; retry++) {
      const backoff = RETRY_BASE_MS * 2 ** retry;
      log(`Enter-only retry ${retry + 1} for message id=${msg.id} after ${backoff}ms`);
      await sleep(backoff);

      try {
        const retryResult = await submitAndVerify();
        if (retryResult !== 'has_content') {
          markDelivered(msg.id);
          log(`Message id=${msg.id} delivered after Enter retry ${retry + 1}`);
          if (msg.require_idle === 1) {
            await waitForRequireIdleSettlement(msg.id);
          }
          return { delivered: true, state: claudeState.state };
        }
      } catch (err) {
        log(`Enter retry error: ${err.message}`);
      }
    }

    // All Enter retries exhausted — content stuck in input box
    markFailed(msg.id);
    log(`FAILED: Message id=${msg.id} stuck in input box after ${MAX_RETRIES} Enter retries`);
    return { delivered: false, state: claudeState.state };
  }

  // result === 'paste_error': tmux command failed, full retry is appropriate
  log(`Failed to paste message id=${msg.id} to tmux, will retry`);
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
