#!/usr/bin/env node
/**
 * C4 Communication Bridge - Message Dispatcher
 * Polls for pending messages and delivers them serially to Claude via tmux
 * Supports priority-based queue with idle-state checking for system messages
 *
 * Run with PM2: pm2 start c4-dispatcher.js --name c4-dispatcher
 */

const { execFileSync } = require('child_process');
const { readFileSync, existsSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');
const { getNextPending, markDelivered, getPendingCount, close } = require('./c4-db');

const TMUX_SESSION = process.env.TMUX_SESSION || 'claude-main';
const POLL_INTERVAL = 500;  // Check every 500ms for new messages
const DELIVERY_DELAY = 200; // 200ms delay between paste and Enter
const STATUS_FILE = join(homedir(), '.claude-status');

let isShuttingDown = false;

function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${timestamp}] ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if tmux session exists
 */
function tmuxHasSession() {
  try {
    execFileSync('tmux', ['has-session', '-t', TMUX_SESSION], {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Claude is idle (for priority-1 messages)
 * @returns {boolean} - true if idle, false otherwise
 */
function isClaudeIdle() {
  try {
    if (!existsSync(STATUS_FILE)) {
      // No status file - assume idle to prevent queue deadlock
      // (activity-monitor may not be running)
      return true;
    }
    const content = readFileSync(STATUS_FILE, 'utf8');
    const status = JSON.parse(content);

    // Check idle_seconds field (preferred)
    if (typeof status.idle_seconds === 'number') {
      return status.idle_seconds >= 5;
    }

    // Fallback: check state field
    if (status.state === 'idle') {
      return true;
    }

    return false;
  } catch (err) {
    log(`Error checking idle state: ${err.message}`);
    // Return true on error to prevent queue deadlock
    return true;
  }
}

/**
 * Send message to Claude via tmux paste-buffer
 */
async function sendToTmux(message) {
  const bufferName = `c4-msg-${process.pid}-${Date.now()}`;

  try {
    // Set buffer with the message (no escaping needed with execFileSync)
    execFileSync('tmux', ['set-buffer', '-b', bufferName, message], {
      stdio: 'pipe'
    });

    // Paste buffer to session
    execFileSync('tmux', ['paste-buffer', '-b', bufferName, '-t', TMUX_SESSION], {
      stdio: 'pipe'
    });

    // Delay to let tmux process the paste
    await sleep(DELIVERY_DELAY);

    // Send Enter key
    execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, 'Enter'], {
      stdio: 'pipe'
    });

    // Delete buffer
    try {
      execFileSync('tmux', ['delete-buffer', '-b', bufferName], { stdio: 'pipe' });
    } catch {
      // Ignore buffer deletion errors
    }

    return true;
  } catch (err) {
    log(`Error sending to tmux: ${err.message}`);
    return false;
  }
}

/**
 * Process one pending message
 */
async function processNextMessage() {
  // Check if tmux session exists
  if (!tmuxHasSession()) {
    return false;
  }

  // Get next pending message (priority-sorted)
  const msg = getNextPending();
  if (!msg) {
    return false;
  }

  // Priority 1 (system/idle-required): Check if Claude is idle
  if (msg.priority === 1) {
    if (!isClaudeIdle()) {
      // Not idle yet, skip delivery (will retry on next poll)
      return false;
    }
  }

  log(`Delivering message id=${msg.id} priority=${msg.priority} from ${msg.source}`);

  // Send to Claude
  const success = await sendToTmux(msg.content);

  if (success) {
    // Mark as delivered
    markDelivered(msg.id);
    log(`Message id=${msg.id} delivered`);
    return true;
  } else {
    log(`Failed to deliver message id=${msg.id}, will retry`);
    return false;
  }
}

/**
 * Main dispatcher loop
 */
async function dispatcherLoop() {
  while (!isShuttingDown) {
    try {
      const delivered = await processNextMessage();

      if (!delivered) {
        // No message to process or delivery failed, wait before next poll
        await sleep(POLL_INTERVAL);
      } else {
        // Message delivered, check immediately for next one
        // (small delay to avoid overwhelming Claude)
        await sleep(100);
      }
    } catch (err) {
      log(`Dispatcher error: ${err.message}`);
      await sleep(POLL_INTERVAL);
    }
  }
}

/**
 * Graceful shutdown
 */
function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log('Shutting down...');
  close();
  process.exit(0);
}

// Signal handlers
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Main
log('=== C4 Dispatcher Started ===');
log(`Tmux session: ${TMUX_SESSION}`);
log(`Poll interval: ${POLL_INTERVAL}ms`);

// Check initial queue status
const pending = getPendingCount();
if (pending > 0) {
  log(`Found ${pending} pending message(s) in queue`);
}

// Start dispatcher loop
dispatcherLoop();
