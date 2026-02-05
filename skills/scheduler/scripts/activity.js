/**
 * Activity monitoring for Scheduler V2
 * Checks Claude's busy/idle state via ~/.claude-status file
 */

import { execSync, execFileSync } from 'child_process';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const TMUX_SESSION = 'claude-main';
const STATUS_FILE = join(homedir(), '.claude-status');
export const IDLE_THRESHOLDS = {
  1: 15,  // Critical - 15 seconds
  2: 30,  // High - 30 seconds
  3: 45,  // Normal - 45 seconds
  4: 60   // Low - 60 seconds
};

/**
 * Read Claude status from ~/.claude-status file
 * @returns {object|null} Status object or null if unavailable
 */
function readStatusFile() {
  try {
    if (!existsSync(STATUS_FILE)) return null;
    const content = readFileSync(STATUS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    return null;
  }
}

/**
 * Get seconds since last activity from status file
 * @returns {number|null} Seconds idle, or null if unavailable
 */
export function getIdleSeconds() {
  const status = readStatusFile();
  if (!status) return null;

  // Use idle_seconds from file if available
  if (typeof status.idle_seconds === 'number') {
    return status.idle_seconds;
  }

  // Fallback: calculate from last_activity timestamp
  if (status.last_activity) {
    const now = Math.floor(Date.now() / 1000);
    return now - status.last_activity;
  }

  return null;
}

/**
 * Check if Claude is currently idle (based on priority threshold)
 * @param {number} priority - Task priority (1-4)
 * @returns {boolean} True if idle long enough for this priority
 */
export function isIdle(priority = 3) {
  const idleSeconds = getIdleSeconds();
  if (idleSeconds === null) return false;

  const threshold = IDLE_THRESHOLDS[priority] || IDLE_THRESHOLDS[3];
  return idleSeconds >= threshold;
}

/**
 * Check if tmux session exists and is accessible
 * @returns {boolean} True if session exists
 */
export function sessionExists() {
  try {
    execSync(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null`, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a message to Claude via C4 Communication Bridge
 * @param {string} message - Message to send
 * @param {string} source - Source identifier (default: 'scheduler')
 * @param {number} priority - Message priority 1-3 (default: 3)
 * @returns {boolean} True if successful
 */
export function sendViaC4(message, source = 'scheduler', priority = 3) {
  try {
    const c4ReceivePath = join(homedir(), 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');

    // Use execFileSync to avoid shell injection - passes arguments directly
    execFileSync(
      'node',
      [c4ReceivePath, '--source', source, '--priority', String(priority), '--content', message],
      { stdio: 'pipe', timeout: 10000 }
    );
    return true;
  } catch (error) {
    console.error('Failed to send via C4:', error.message);
    return false;
  }
}

/**
 * Send a prompt to the Claude tmux session using paste-buffer method
 * Uses unique buffer names to prevent race conditions
 * @param {string} text - Text to send
 * @returns {boolean} True if successful
 */
export function sendToTmux(text) {
  try {
    const msgId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempFile = `/tmp/scheduler-msg-${msgId}.txt`;
    const bufferName = `sched-${msgId}`;

    // Write to temp file
    writeFileSync(tempFile, text);

    // Load into tmux buffer
    execSync(`tmux load-buffer -b ${bufferName} ${tempFile}`, { timeout: 5000 });

    // Paste buffer into session
    execSync(`tmux paste-buffer -b ${bufferName} -t ${TMUX_SESSION}`, { timeout: 5000 });

    // Small delay then send Enter
    execSync('sleep 0.1', { timeout: 5000 });
    execSync(`tmux send-keys -t ${TMUX_SESSION} Enter`, { timeout: 5000 });

    // Clean up
    execSync(`tmux delete-buffer -b ${bufferName}`, { timeout: 5000 });
    unlinkSync(tempFile);

    return true;
  } catch (error) {
    console.error('Failed to send to tmux:', error.message);
    return false;
  }
}

/**
 * Check if Claude CLI is at the input prompt (ready for commands)
 * Uses state from ~/.claude-status file
 * @returns {boolean} True if idle and ready for commands
 */
export function isAtPrompt() {
  const status = readStatusFile();

  // If we can't read status, assume not ready
  if (!status) {
    return false;
  }

  // Check state directly - "idle" means Claude is at prompt
  if (status.state === 'idle') {
    return true;
  }

  // Fallback: check idle_seconds >= 5
  const idleSeconds = getIdleSeconds();
  return idleSeconds !== null && idleSeconds >= 5;
}

/**
 * Get current activity status
 * @returns {object} Status object with state and idle time
 */
export function getStatus() {
  const status = readStatusFile();
  const idleSeconds = getIdleSeconds();
  const tmuxExists = sessionExists();

  if (!status || idleSeconds === null) {
    return { state: 'unknown', idleSeconds: null, sessionExists: tmuxExists };
  }

  const atPrompt = isAtPrompt();

  return {
    state: status.state || (idleSeconds >= 15 ? 'idle' : 'busy'),
    idleSeconds,
    sessionExists: tmuxExists,
    atPrompt
  };
}
