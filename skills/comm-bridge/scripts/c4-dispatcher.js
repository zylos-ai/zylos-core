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
  ackControl,
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
  ACTIVE_RUNTIME,
  TMUX_SESSION,
  AGENT_STATUS_FILE,
  PROC_STATE_FILE,
  API_ACTIVITY_FILE,
  STALE_STATUS_THRESHOLD,
  TMUX_MISSING_WARN_THRESHOLD
} from './c4-config.js';
import {
  findPromptY as sharedFindPromptY,
  isUsageOverlayCapture as sharedIsUsageOverlayCapture
} from './tmux-input-state.js';

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

export function readJsonFileWithRetry(filePath, attempts = 3) {
  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function getAgentState() {
  try {
    if (!existsSync(AGENT_STATUS_FILE)) {
      return { state: 'offline', health: 'ok', healthy: false, reason: 'missing' };
    }

    const stats = statSync(AGENT_STATUS_FILE);
    const ageMs = Date.now() - stats.mtimeMs;
    if (ageMs > STALE_STATUS_THRESHOLD) {
      return { state: 'offline', health: 'ok', healthy: false, reason: 'stale' };
    }

    const status = readJsonFileWithRetry(AGENT_STATUS_FILE);
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
    log(`Warning: Error reading agent status (${err.message})`);
    // health is fail-open by design; state still degrades to offline on read failure.
    return { state: 'offline', health: 'ok', healthy: false, reason: 'error' };
  }
}

/**
 * Read proc-state.json written by the activity monitor's ProcSampler.
 * Returns { alive, frozen, ... } or null if unavailable/stale (>30s).
 */
function readProcState() {
  try {
    if (!existsSync(PROC_STATE_FILE)) return null;
    const data = readJsonFileWithRetry(PROC_STATE_FILE);
    const age = nowSeconds() - (data.lastSampleAt || 0);
    if (age > 30) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Check if agent is confirmed active: api-activity.json must show active_tools > 0
 * AND be fresh (updated within 60s). Prevents stale hook state from gating auto-ack.
 */
function isAgentConfirmedActive() {
  try {
    if (!existsSync(API_ACTIVITY_FILE)) return false;
    const data = readJsonFileWithRetry(API_ACTIVITY_FILE);
    const updatedAt = data?.updated_at ? Math.floor(data.updated_at / 1000) : 0;
    const age = nowSeconds() - updatedAt;
    return (data?.active_tools ?? 0) > 0 && age < 60;
  } catch {
    return false;
  }
}

function isAgentStatusFresh() {
  try {
    if (!existsSync(AGENT_STATUS_FILE)) {
      return false;
    }
    const stats = statSync(AGENT_STATUS_FILE);
    return (Date.now() - stats.mtimeMs) <= STALE_STATUS_THRESHOLD;
  } catch {
    return false;
  }
}

export function getHeartbeatPhase(content) {
  const match = String(content || '').match(/\[phase=([a-z-]+)\]/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

export function shouldAutoAckHeartbeat({ item, agentState, procState, confirmedActive }) {
  const isHeartbeat = Boolean(item && (item.content || '').includes('Heartbeat check'));
  if (!isHeartbeat) return false;

  if (agentState?.healthy !== true) return false;

  const agentAlive = agentState?.state !== 'offline' && agentState?.state !== 'stopped';
  if (!agentAlive) return false;
  if (!procState || procState.alive !== true) return false;

  // Busy path: preserve the existing "confirmed active" behavior for live generation.
  if (confirmedActive) {
    return true;
  }

  // Idle path: only auto-ack the periodic primary probe. Recovery/stuck/down
  // probes must still be delivered end-to-end so the heartbeat engine can
  // observe real failures while the session is idle.
  return (
    getHeartbeatPhase(item.content) === 'primary' &&
    agentState?.health === 'ok' &&
    agentState?.state === 'idle' &&
    agentState?.idleSeconds >= REQUIRE_IDLE_MIN_SECONDS &&
    procState.frozen !== true
  );
}

export function sanitizeMessage(message) {
  return message.replace(/[\x00-\x08\x0B-\x1F]/g, '');
}

export function getDeliveryDelay(byteLength) {
  const extra = Math.floor(byteLength / 1024) * DELIVERY_DELAY_PER_KB;
  return Math.min(DELIVERY_DELAY_BASE + extra, DELIVERY_DELAY_MAX);
}

export function getClaudeInputBoxText(capture) {
  const lines = capture.split('\n');

  const separatorIndexes = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\u2500{10,}/.test(lines[i])) {
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
 * Find the Y coordinate (0-indexed line number) of the last prompt line
 * (starting with › or ❯) in a tmux capture string.
 * Returns -1 if no prompt line is found.
 */
export function findPromptY(capture) {
  return sharedFindPromptY(capture);
}

/**
 * Claude-only fallback parser.
 */
export function checkClaudeFallbackInputBox(capture) {
  const text = getClaudeInputBoxText(capture);
  if (text === null) {
    return 'indeterminate';
  }

  // Only inspect the first 10 chars to the right of the prompt symbol
  // to avoid buddy-art variants on the far right side.
  const firstLine = text.split('\n')[0] || '';
  const promptRight = firstLine.replace(/^\s*[›❯]/, '');
  const window = Array.from(promptRight).slice(0, 10).join('');
  const stripped = window.replace(/[\p{C}\p{Z}]+/gu, '');

  return stripped.length === 0 ? 'empty' : 'has_content';
}

/**
 * Cursor-based detector: primary signal for all runtimes.
 */
export function checkInputBoxByCursor() {
  const cursorX = getCursorX();
  if (cursorX < 0) return 'indeterminate';
  if (cursorX > CURSOR_EMPTY_THRESHOLD) return 'has_content';

  // cursor_x ≤ threshold — could be truly empty or multi-line wrapped input.
  // Capture the pane and compare prompt line Y with cursor Y.
  const cursorY = getCursorY();
  if (cursorY < 0) return 'indeterminate';

  let capture;
  try {
    capture = execFileSync('tmux', ['capture-pane', '-p', '-t', TMUX_SESSION], {
      encoding: 'utf8', stdio: 'pipe', timeout: 5000
    });
  } catch {
    return 'indeterminate';
  }

  const promptY = findPromptY(capture);
  if (promptY < 0) return 'indeterminate';

  // If cursor is on the prompt line itself, input is empty.
  // If cursor is below the prompt line, there's wrapped multi-line content.
  return cursorY === promptY ? 'empty' : 'has_content';
}

/**
 * Unified detector:
 * - Codex: cursor-only.
 * - Claude: cursor-first; if it reports has_content, fallback to text parser.
 */
export function checkInputBox() {
  const cursorState = checkInputBoxByCursor();
  if (cursorState !== 'has_content') {
    return cursorState;
  }

  if (ACTIVE_RUNTIME !== 'claude') {
    return cursorState;
  }

  let capture;
  try {
    capture = execFileSync('tmux', ['capture-pane', '-p', '-t', TMUX_SESSION], {
      encoding: 'utf8', stdio: 'pipe', timeout: 5000
    });
  } catch {
    return cursorState;
  }

  const fallbackState = checkClaudeFallbackInputBox(capture);
  return fallbackState === 'indeterminate' ? cursorState : fallbackState;
}

export function isUsageOverlayCapture(capture) {
  return sharedIsUsageOverlayCapture(capture);
}

// Empty prompt threshold: cursor at column 0, 1, or 2 means the input box
// is empty (cursor sits right after the prompt char, e.g. "❯ " = column 2).
const CURSOR_EMPTY_THRESHOLD = 2;

export function getCursorX() {
  try {
    const out = execFileSync('tmux', ['display-message', '-p', '-t', TMUX_SESSION, '#{cursor_x}'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000
    });
    return parseInt(out.trim(), 10);
  } catch {
    return -1;
  }
}

export function getCursorY() {
  try {
    const out = execFileSync('tmux', ['display-message', '-p', '-t', TMUX_SESSION, '#{cursor_y}'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000
    });
    return parseInt(out.trim(), 10);
  } catch {
    return -1;
  }
}

async function submitAndVerify() {
  execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, 'Enter'], { stdio: 'pipe', timeout: 5000 });

  for (let attempt = 0; attempt < ENTER_VERIFY_MAX_RETRIES; attempt++) {
    await sleep(ENTER_VERIFY_WAIT_MS);
    const state = checkInputBox();

    if (state === 'empty') {
      return { verified: true, state: 'empty' };
    }

    if (state === 'indeterminate') {
      log(`Enter verify attempt ${attempt + 1}: indeterminate state, checking for overlay`);
      try {
        const capture = execFileSync('tmux', ['capture-pane', '-p', '-t', TMUX_SESSION], {
          encoding: 'utf8', stdio: 'pipe', timeout: 5000
        });
        if (isUsageOverlayCapture(capture)) {
          log(`Enter verify attempt ${attempt + 1}: /usage overlay detected, sending Escape`);
          execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, 'Escape'], { stdio: 'pipe', timeout: 5000 });
        }
      } catch { /* capture failed, continue retry loop */ }
      continue;
    }

    // state === 'has_content' — message wasn't submitted, retry Enter
    log(`Enter verify attempt ${attempt + 1}: input has content, retrying Enter`);
    execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, 'Enter'], { stdio: 'pipe', timeout: 5000 });
  }

  return { verified: false, state: 'has_content' };
}

async function sendToTmux(message, options = {}) {
  const strictVerify = options.strictVerify === true;
  const bufferName = `c4-msg-${process.pid}-${Date.now()}`;
  const sanitized = sanitizeMessage(message);
  const delayMs = getDeliveryDelay(Buffer.byteLength(sanitized, 'utf8'));

  try {
    execFileSync('tmux', ['set-buffer', '-b', bufferName, '--', sanitized], { stdio: 'pipe', timeout: 5000 });
    execFileSync('tmux', ['paste-buffer', '-b', bufferName, '-t', TMUX_SESSION], { stdio: 'pipe', timeout: 5000 });
  } catch (err) {
    log(`Error pasting to tmux: ${err.message}`);
    logDeliveryFailure('tmux_paste', 0, 'PASTE_ERROR', { error: err.message });
    return 'paste_error';
  } finally {
    try {
      execFileSync('tmux', ['delete-buffer', '-b', bufferName], { stdio: 'pipe', timeout: 5000 });
    } catch {
      // Ignore buffer deletion errors.
    }
  }

  await sleep(delayMs);

  let verifyResult = { verified: false, state: 'indeterminate' };
  try {
    verifyResult = await submitAndVerify();
  } catch (err) {
    log(`Warning: Enter verification error: ${err.message}`);
  }

  // Conversation delivery must be strict: if we cannot verify submission,
  // retry instead of marking delivered to avoid false positives.
  if (!verifyResult.verified && strictVerify) {
    log(`Verification failed in strict mode (state=${verifyResult.state}) — marking as verify_failed`);
    return 'verify_failed';
  }

  // For non-conversation controls, preserve prior permissive behavior when the
  // process is confirmed alive (only hard-fail if process is dead/offline).
  if (!verifyResult.verified) {
    const procState = readProcState();
    const agentState = getAgentState();
    if ((procState && procState.alive === false) ||
        agentState.state === 'offline' || agentState.state === 'stopped') {
      log('Verification failed and agent is dead/offline — marking as verify_failed');
      return 'verify_failed';
    }
  }

  return 'submitted';
}

export function isBypassState(item) {
  return item.type === 'control' && item.bypass_state === 1;
}

export function isKeystrokeControl(item) {
  return item.type === 'control' && (item.content || '').startsWith('[KEYSTROKE]');
}

export function parseKeystrokeKey(content) {
  return (content || '').slice('[KEYSTROKE]'.length).trim();
}

function releaseItem(item, reason = null) {
  if (item.type === 'control') {
    requeueControl(item.id, reason);
    return;
  }
  requeueConversation(item.id);
}

function hasAckSuffix(content = '') {
  return content.includes('---- ack via:');
}

async function handleConversationDeliveryFailure(msg) {
  const channelHealthy = isAgentStatusFresh();

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
  log(`block_queue_until_idle item id=${msgId}: hold ${REQUIRE_IDLE_POST_SEND_HOLD_MS}ms before next dispatch`);
  await sleep(REQUIRE_IDLE_POST_SEND_HOLD_MS);

  let state = getAgentState().state;
  if (state === 'offline' || state === 'stopped') {
    log(`block_queue_until_idle item id=${msgId}: agent state=${state}, continuing`);
    return;
  }

  if (state === 'idle') {
    log(`block_queue_until_idle item id=${msgId}: agent remained idle after hold, continuing`);
    return;
  }

  const deadline = Date.now() + REQUIRE_IDLE_EXECUTION_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(REQUIRE_IDLE_EXECUTION_POLL_MS);
    state = getAgentState().state;
    if (state === 'idle' || state === 'offline' || state === 'stopped') {
      log(`block_queue_until_idle item id=${msgId}: settled with agent state=${state}`);
      return;
    }
  }

  log(`block_queue_until_idle item id=${msgId}: timeout after ${REQUIRE_IDLE_EXECUTION_MAX_WAIT_MS}ms, continuing`);
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

  const agentState = getAgentState();
  if (agentState.state === 'offline' || agentState.state === 'stopped') {
    tmuxMissingChecks += 1;
    if (tmuxMissingChecks === TMUX_MISSING_WARN_THRESHOLD) {
      log(`WARNING: Agent status stale/missing for ${TMUX_MISSING_WARN_THRESHOLD} consecutive checks`);
    }
  } else {
    tmuxMissingChecks = 0;
  }

  const item = claimNextItem();
  if (!item) {
    return { delivered: false, state: agentState.state };
  }

  const bypass = isBypassState(item);

  if ((agentState.state === 'offline' || agentState.state === 'stopped') && !bypass) {
    releaseItem(item);
    return { delivered: false, state: agentState.state };
  }

  if (agentState.health !== 'ok' && !bypass) {
    releaseItem(item);
    return { delivered: false, state: agentState.state };
  }

  if (item.require_idle === 1 && (agentState.state !== 'idle' || agentState.idleSeconds < REQUIRE_IDLE_MIN_SECONDS)) {
    releaseItem(item);
    return { delivered: false, state: agentState.state };
  }

  // D1: heartbeat must not interrupt active generation.
  // Auto-ack supports two paths:
  //   1. It's a heartbeat (not other bypass controls like context rotation)
  //   2. Agent state is not offline/stopped (proc-state can be stale for ~30s after crash)
  //   3. /proc confirms process is alive (and idle path also requires not frozen)
  //   4. Either:
  //      - busy path: fresh hooks confirm active generation, or
  //      - idle path: health=ok and idle_seconds >= sustained-idle minimum
  // This preserves the existing busy auto-ack behavior while allowing a narrow
  // idle auto-ack path on healthy, stable sessions.
  if (bypass) {
    const procState = readProcState();
    const confirmed = isAgentConfirmedActive();
    if (shouldAutoAckHeartbeat({ item, agentState, procState, confirmedActive: confirmed })) {
      const phase = getHeartbeatPhase(item.content);
      const reason = confirmed
        ? `phase=${phase} /proc alive + active_tools>0 fresh (delta=${procState.lastDelta})`
        : `phase=${phase} /proc alive + health=ok + idle_seconds=${agentState.idleSeconds}`;
      log(`Auto-acking heartbeat id=${item.id}: ${reason}`);
      ackControl(item.id);
      return { delivered: true, state: agentState.state };
    }
  }

  // Keystroke delivery: content prefixed with [KEYSTROKE] sends raw key to tmux
  // without buffer paste or "Meanwhile" prefix. Used for auto-approve permission prompts.
  const rawContent = item.content || '';
  if (isKeystrokeControl(item)) {
    const key = parseKeystrokeKey(rawContent);
    log(`Delivering keystroke key=${key} (control id=${item.id} priority=${item.priority})`);
    try {
      execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, key], { stdio: 'pipe', timeout: 5000 });
      ackControl(item.id);
      log(`Keystroke delivered: key=${key} (control id=${item.id})`);
      return { delivered: true, state: agentState.state };
    } catch (err) {
      log(`Keystroke delivery error: ${err.message}`);
      await handleControlDeliveryFailure(item, `KEYSTROKE_ERROR: ${err.message}`);
      return { delivered: false, state: agentState.state };
    }
  }

  log(`Delivering ${item.type} id=${item.id}${item.type === 'control' ? ` priority=${item.priority}` : ` from ${item.channel}`}`);
  // Prefix control messages with "Meanwhile, " so the agent treats them as
  // concurrent background tasks that should not interrupt the user's active work.
  // Skip for slash commands (e.g. /exit, /clear) which must be delivered verbatim.
  const isSlashCommand = rawContent.startsWith('/');
  const deliveryContent = (item.type === 'control' && !isSlashCommand) ? `Meanwhile, ${rawContent}` : rawContent;
  const result = await sendToTmux(deliveryContent, {
    strictVerify: item.type === 'conversation'
  });

  if (result === 'submitted') {
    if (item.type === 'conversation') {
      markDelivered(item.id);
      log(`Conversation id=${item.id} delivered`);
    } else {
      if (hasAckSuffix(item.content || '')) {
        log(`Control id=${item.id} submitted, waiting ack`);
      } else {
        ackControl(item.id);
        log(`Control id=${item.id} submitted (no-ack mode), marked done`);
      }
    }

    if (item.require_idle === 1) {
      await waitForRequireIdleSettlement(item.id);
    }
    return { delivered: true, state: agentState.state };
  }

  const reason = result === 'verify_failed' ? 'VERIFY_FAILED' : 'TMUX_PASTE_FAILED';
  log(`Failed to deliver ${item.type} id=${item.id} to tmux (${reason})`);
  logDeliveryFailure(item.type, item.id, reason);
  if (item.type === 'control') {
    await handleControlDeliveryFailure(item, reason);
  } else {
    await handleConversationDeliveryFailure(item);
  }
  return { delivered: false, state: agentState.state };
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

// PM2 sets argv[1] to its own ProcessContainerFork.js, so classic ESM
// isMainModule checks are unreliable here. Keep the default auto-start
// behavior, but allow tests to disable the live loop before import.
if (process.env.C4_DISPATCHER_DISABLE_MAIN !== '1') {
  main();
}
