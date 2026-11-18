/**
 * Shared tmux helper functions for runtime adapters.
 *
 * All child-process calls use execFileSync (no shell) with finite timeouts
 * to prevent event-loop hangs when the tmux server is unresponsive.
 */

import { execFileSync } from 'node:child_process';
import { tmuxClientArgs, isTmuxDirectoryError } from './tmux-client-args.js';
import { TMUX_COMMAND as C } from './tmux-protocol.js';

const CMD_TIMEOUT = 3000;

/**
 * Capture tmux pane content.
 * @param {string} session
 * @returns {string|null}
 */
export function tmuxCapturePaneText(session) {
  try {
    return execFileSync('tmux', [...tmuxClientArgs({ utf8: false }), C.capturePane, '-p', '-t', session], {
      encoding: 'utf8',
      timeout: CMD_TIMEOUT,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    if (isTmuxDirectoryError(err)) throw err;
    if (isTimeoutError(err)) _debugTimeout('tmux capture-pane', err);
    return null;
  }
}

/**
 * Get the process name for a PID.
 * @param {number} pid
 * @returns {string|null}
 */
export function getProcessName(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      timeout: CMD_TIMEOUT,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

export function isTimeoutError(err) {
  return err?.code === 'ETIMEDOUT';
}

function _debugTimeout(label, err) {
  const signal = err.signal || 'unknown';
  process.stderr.write(`[tmux-helpers] ${label} timed out (code=${err?.code}, signal=${signal})\n`);
}
