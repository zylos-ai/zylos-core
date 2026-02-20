/**
 * C4 Diagnostic Logging Utilities
 * Shared by dispatcher, hooks, and other C4 scripts.
 *
 * Log files are stored in ~/zylos/activity-monitor/ with automatic rotation.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const DIAG_DIR = path.join(ZYLOS_DIR, 'activity-monitor');

const MAX_LOG_SIZE = 100 * 1024; // 100KB — rotate when exceeded
const KEEP_RATIO = 0.5;          // Keep last 50% of lines after rotation

/**
 * Ensure diagnostic directory exists.
 */
function ensureDir() {
  if (!fs.existsSync(DIAG_DIR)) {
    fs.mkdirSync(DIAG_DIR, { recursive: true });
  }
}

/**
 * Rotate a log file if it exceeds MAX_LOG_SIZE.
 * Keeps the last KEEP_RATIO of lines.
 */
function rotateIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stats = fs.statSync(filePath);
    if (stats.size < MAX_LOG_SIZE) return;
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const keepFrom = Math.floor(lines.length * (1 - KEEP_RATIO));
    fs.writeFileSync(filePath, lines.slice(keepFrom).join('\n'));
  } catch {
    // Best effort — don't break caller on rotation failure
  }
}

/**
 * Log hook execution timing.
 * @param {string} hookName - e.g. 'session-start-prompt', 'c4-session-init'
 * @param {number} durationMs - execution time in milliseconds
 */
export function logHookTiming(hookName, durationMs) {
  try {
    ensureDir();
    const filePath = path.join(DIAG_DIR, 'hook-timing.log');
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    fs.appendFileSync(filePath, `[${ts}] hook=${hookName} duration=${durationMs}ms\n`);
    rotateIfNeeded(filePath);
  } catch {
    // Best effort
  }
}

/**
 * Log C4 delivery failure.
 * @param {string} itemType - 'control' or 'conversation'
 * @param {number|string} itemId - message/control ID
 * @param {string} reason - failure reason (e.g. 'TMUX_PASTE_FAILED', 'paste_error')
 * @param {object} [extra] - optional extra context
 */
export function logDeliveryFailure(itemType, itemId, reason, extra = {}) {
  try {
    ensureDir();
    const filePath = path.join(DIAG_DIR, 'delivery-failures.log');
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const extraStr = Object.keys(extra).length > 0
      ? ' ' + Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' ')
      : '';
    fs.appendFileSync(filePath, `[${ts}] type=${itemType} id=${itemId} reason=${reason}${extraStr}\n`);
    rotateIfNeeded(filePath);
  } catch {
    // Best effort
  }
}

/**
 * Save tmux capture on separator detection failure.
 * @param {string} capture - raw tmux pane content
 * @param {string} context - e.g. 'separator-fail-attempt-1'
 */
const MAX_CAPTURE_LENGTH = 8192; // Truncate large captures to prevent disk bloat

export function saveTmuxCapture(capture, context) {
  try {
    ensureDir();
    const filePath = path.join(DIAG_DIR, 'tmux-captures.log');
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const separator = '\u2500'.repeat(60);
    const truncated = capture.length > MAX_CAPTURE_LENGTH
      ? capture.slice(0, MAX_CAPTURE_LENGTH) + `\n[...truncated ${capture.length - MAX_CAPTURE_LENGTH} bytes]`
      : capture;
    fs.appendFileSync(filePath, `\n[${ts}] context=${context}\n${separator}\n${truncated}\n${separator}\n`);
    rotateIfNeeded(filePath);
  } catch {
    // Best effort
  }
}
