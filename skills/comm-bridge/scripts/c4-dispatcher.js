#!/usr/bin/env node
/**
 * C4 Communication Bridge - Dispatcher
 * Control queue has higher priority than conversations.
 */

import { execFileSync } from 'child_process';
import { readFileSync, existsSync, statSync } from 'fs';
import { logDeliveryFailure, saveTmuxCapture } from './c4-diagnostic.js';
import {
  getNextPending,
  claimConversation,
  requeueConversation,
  markDelivered,
  getPendingCount,
  getPendingControlCount,
  close,
  incrementRetryCount,
  markFailed,
  getNextPendingControl,
  claimControl,
  requeueControl,
  retryOrFailControl,
  expireTimedOutControls,
  cleanupControlQueue
} from './c4-db.js';
import {
  POLL_INTERVAL_BASE,
  POLL_INTERVAL_MAX,
  DELIVERY_DELAY_BASE,
  DELIVERY_DELAY_PER_KB,
  DELIVERY_DELAY_MAX,
  MAX_RETRIES,
  RETRY_BASE_MS,
  CONTROL_MAX_RETRIES,
  CONTROL_RETENTION_DAYS,
  CONTROL_CLEANUP_INTERVAL_MS,
  ENTER_VERIFY_MAX_RETRIES,
  ENTER_VERIFY_WAIT_MS,
  REQUIRE_IDLE_MIN_SECONDS,
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
let lastControlCleanupMs = 0;

function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${timestamp}] ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function getClaudeState() {
  try {
    if (!existsSync(CLAUDE_STATUS_FILE)) {
      return { state: 'offline', health: 'ok', healthy: false, reason: 'missing' };
    }

    const stats = statSync(CLAUDE_STATUS_FILE);
    const ageMs = Date.now() - stats.mtimeMs;
    if (ageMs > STALE_STATUS_THRESHOLD) {
      return { state: 'offline', health: 'ok', healthy: false, reason: 'stale' };
    }

    const status = JSON.parse(readFileSync(CLAUDE_STATUS_FILE, 'utf8'));
    let state = status.state;

    if (!state && typeof status.idle_seconds === 'number') {
      state = status.idle_seconds >= 5 ? 'idle' : 'busy';
    }
    if (!state) {
      state = 'busy';
    }

    const health = typeof status.health === 'string' ? status.health : 'ok';
    const idleSeconds = typeof status.idle_seconds === 'number' ? status.idle_seconds : 0;
    return { state, health, healthy: true, idleSeconds };
  } catch (err) {
    log(`Warning: Error reading Claude status (${err.message})`);
    // health is fail-open by design; state still degrades to offline on read failure.
    return { state: 'offline', health: 'ok', healthy: false, reason: 'error' };
  }
}

function isStatusFresh() {
  try {
    if (!existsSync(CLAUDE_STATUS_FILE)) {
      return false;
    }
    const stats = statSync(CLAUDE_STATUS_FILE);
    return (Date.now() - stats.mtimeMs) <= STALE_STATUS_THRESHOLD;
  } catch {
    return false;
  }
}

export function sanitizeMessage(message) {
  return message.replace(/[\x00-\x08\x0B-\x1F]/g, '');
}

export function getDeliveryDelay(byteLength) {
  const extra = Math.floor(byteLength / 1024) * DELIVERY_DELAY_PER_KB;
  return Math.min(DELIVERY_DELAY_BASE + extra, DELIVERY_DELAY_MAX);
}

export function getInputBoxText(capture) {
  const lines = capture.split('\n');
  const separatorIndexes = [];

  for (let i = 0; i < lines.length; i++) {
    if (/^\u2500+$/.test(lines[i]) && lines[i].length > 10) {
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

export function checkInputBox(capture) {
  const text = getInputBoxText(capture);
  if (text === null) {
    return 'indeterminate';
  }

  const stripped = text
    .replace(/\u276F/g, '')
    .replace(/[\p{C}\p{Z}]+/gu, '');

  if (stripped.length === 0) {
    return 'empty';
  }

  return 'has_content';
}

async function dismissGhostTextAndCapture() {
  execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, 'Space'], { stdio: 'pipe' });
  await sleep(100);

  const capture = execFileSync('tmux', ['capture-pane', '-p', '-t', TMUX_SESSION], {
    encoding: 'utf8',
    stdio: 'pipe'
  });

  execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, 'BSpace'], { stdio: 'pipe' });
  await sleep(100);
  return capture;
}

async function submitAndVerify() {
  execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, 'Enter'], { stdio: 'pipe' });

  for (let attempt = 0; attempt < ENTER_VERIFY_MAX_RETRIES; attempt++) {
    await sleep(ENTER_VERIFY_WAIT_MS);
    const capture = await dismissGhostTextAndCapture();
    const state = checkInputBox(capture);

    if (state === 'empty') {
      return;
    }

    if (state === 'indeterminate') {
      log(`Enter verify attempt ${attempt + 1}: separator detection failed, retrying capture`);
      saveTmuxCapture(capture, `separator-fail-attempt-${attempt + 1}`);
      continue;
    }

    log(`Enter verify attempt ${attempt + 1}: input box has content, retrying Enter`);
    execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, 'Enter'], { stdio: 'pipe' });
  }
}

async function sendToTmux(message) {
  const bufferName = `c4-msg-${process.pid}-${Date.now()}`;
  const sanitized = sanitizeMessage(message);
  const delayMs = getDeliveryDelay(Buffer.byteLength(sanitized, 'utf8'));

  try {
    execFileSync('tmux', ['set-buffer', '-b', bufferName, '--', sanitized], { stdio: 'pipe' });
    execFileSync('tmux', ['paste-buffer', '-b', bufferName, '-t', TMUX_SESSION], { stdio: 'pipe' });
  } catch (err) {
    log(`Error pasting to tmux: ${err.message}`);
    logDeliveryFailure('tmux_paste', 0, 'PASTE_ERROR', { error: err.message });
    return 'paste_error';
  } finally {
    try {
      execFileSync('tmux', ['delete-buffer', '-b', bufferName], { stdio: 'pipe' });
    } catch {
      // Ignore buffer deletion errors.
    }
  }

  await sleep(delayMs);

  try {
    await submitAndVerify();
  } catch (err) {
    log(`Warning: Enter verification error (paste already succeeded): ${err.message}`);
  }

  return 'submitted';
}

export function isBypassState(item) {
  return item.type === 'control' && item.bypass_state === 1;
}

function releaseItem(item, reason = null) {
  if (item.type === 'control') {
    requeueControl(item.id, reason);
    return;
  }
  requeueConversation(item.id);
}

async function handleConversationDeliveryFailure(msg) {
  const channelHealthy = isStatusFresh();

  if (channelHealthy) {
    const currentCount = msg.retry_count || 0;
    const nextCount = currentCount + 1;
    incrementRetryCount(msg.id);

    if (nextCount >= MAX_RETRIES) {
      markFailed(msg.id);
      log(`FAILED: conversation id=${msg.id} channel=${msg.channel} marked as failed after ${nextCount} retries`);
      logDeliveryFailure('conversation', msg.id, 'MAX_RETRIES', { channel: msg.channel, retries: nextCount });
      return;
    }

    requeueConversation(msg.id);
    const backoff = RETRY_BASE_MS * 2 ** (nextCount - 1);
    log(`Retry ${nextCount} for conversation id=${msg.id} after ${backoff}ms`);
    await sleep(backoff);
    return;
  }

  requeueConversation(msg.id);
  log(`Channel unhealthy; backing off for ${RETRY_BASE_MS}ms`);
  await sleep(RETRY_BASE_MS);
}

async function handleControlDeliveryFailure(control, reason) {
  const transition = retryOrFailControl(control.id, reason, CONTROL_MAX_RETRIES);
  if (!transition) return;

  if (transition.status === 'failed') {
    log(`FAILED: control id=${control.id} marked as failed after ${transition.retry_count} retries (${reason})`);
    logDeliveryFailure('control', control.id, reason, { retries: transition.retry_count });
    return;
  }

  log(`Retry ${transition.retry_count} for control id=${control.id}`);
}

async function waitForRequireIdleSettlement(msgId) {
  log(`require_idle item id=${msgId}: hold ${REQUIRE_IDLE_POST_SEND_HOLD_MS}ms before next dispatch`);
  await sleep(REQUIRE_IDLE_POST_SEND_HOLD_MS);

  let state = getClaudeState().state;
  if (state === 'offline' || state === 'stopped') {
    log(`require_idle item id=${msgId}: Claude state=${state}, continuing`);
    return;
  }

  if (state === 'idle') {
    log(`require_idle item id=${msgId}: Claude remained idle after hold, continuing`);
    return;
  }

  const deadline = Date.now() + REQUIRE_IDLE_EXECUTION_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(REQUIRE_IDLE_EXECUTION_POLL_MS);
    state = getClaudeState().state;
    if (state === 'idle' || state === 'offline' || state === 'stopped') {
      log(`require_idle item id=${msgId}: settled with Claude state=${state}`);
      return;
    }
  }

  log(`require_idle item id=${msgId}: timeout after ${REQUIRE_IDLE_EXECUTION_MAX_WAIT_MS}ms, continuing`);
}

function claimNextItem() {
  const current = nowSeconds();
  const control = getNextPendingControl(current);
  if (control) {
    if (claimControl(control.id)) {
      return { ...control, type: 'control' };
    }

    // Keep strict control priority: if a control row was observed but claim lost,
    // do not fall through to conversation in the same loop iteration.
    return null;
  }

  const msg = getNextPending();
  if (msg && claimConversation(msg.id)) {
    return { ...msg, type: 'conversation' };
  }

  return null;
}

function maybeCleanupControlQueue() {
  const nowMs = Date.now();
  if (lastControlCleanupMs !== 0 && (nowMs - lastControlCleanupMs) < CONTROL_CLEANUP_INTERVAL_MS) {
    return;
  }

  const cutoff = nowSeconds() - (CONTROL_RETENTION_DAYS * 24 * 60 * 60);
  const deleted = cleanupControlQueue(cutoff);
  if (deleted > 0) {
    log(`Control cleanup deleted ${deleted} final record(s)`);
  }
  lastControlCleanupMs = nowMs;
}

async function processNextMessage() {
  maybeCleanupControlQueue();
  const timedOut = expireTimedOutControls();
  if (timedOut > 0) {
    log(`Control timeout sweep marked ${timedOut} record(s) as timeout`);
  }

  const claudeState = getClaudeState();
  if (claudeState.state === 'offline' || claudeState.state === 'stopped') {
    tmuxMissingChecks += 1;
    if (tmuxMissingChecks === TMUX_MISSING_WARN_THRESHOLD) {
      log(`WARNING: Claude tmux session missing for ${TMUX_MISSING_WARN_THRESHOLD} consecutive checks`);
    }
  } else {
    tmuxMissingChecks = 0;
  }

  const item = claimNextItem();
  if (!item) {
    return { delivered: false, state: claudeState.state };
  }

  const bypass = isBypassState(item);

  if ((claudeState.state === 'offline' || claudeState.state === 'stopped') && !bypass) {
    releaseItem(item);
    return { delivered: false, state: claudeState.state };
  }

  if (claudeState.health !== 'ok' && !bypass) {
    releaseItem(item);
    return { delivered: false, state: claudeState.state };
  }

  if (item.require_idle === 1 && (claudeState.state !== 'idle' || claudeState.idleSeconds < REQUIRE_IDLE_MIN_SECONDS)) {
    releaseItem(item);
    return { delivered: false, state: claudeState.state };
  }

  log(`Delivering ${item.type} id=${item.id}${item.type === 'control' ? ` priority=${item.priority}` : ` from ${item.channel}`}`);
  const deliveryContent = item.content || '';
  const result = await sendToTmux(deliveryContent);

  if (result === 'submitted') {
    if (item.type === 'conversation') {
      markDelivered(item.id);
      log(`Conversation id=${item.id} delivered`);
    } else {
      log(`Control id=${item.id} submitted, waiting ack`);
    }

    if (item.require_idle === 1) {
      await waitForRequireIdleSettlement(item.id);
    }
    return { delivered: true, state: claudeState.state };
  }

  log(`Failed to paste ${item.type} id=${item.id} to tmux`);
  logDeliveryFailure(item.type, item.id, 'TMUX_PASTE_FAILED');
  if (item.type === 'control') {
    await handleControlDeliveryFailure(item, 'TMUX_PASTE_FAILED');
  } else {
    await handleConversationDeliveryFailure(item);
  }
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

  const pendingControl = getPendingControlCount();
  const pendingConversation = getPendingCount();
  if (pendingControl > 0) {
    log(`Found ${pendingControl} pending control item(s)`);
  }
  if (pendingConversation > 0) {
    log(`Found ${pendingConversation} pending conversation message(s)`);
  }

  await dispatcherLoop();
  close();
  process.exit(0);
}

// Always call main() — PM2 sets argv[1] to its own ProcessContainerFork.js,
// breaking realpathSync-based isMainModule checks for ESM scripts.
main();
