/**
 * Shared tmux helper functions for runtime adapters.
 *
 * All child-process calls use execFileSync (no shell) with finite timeouts
 * to prevent event-loop hangs when the tmux server is unresponsive.
 */

import { execFileSync } from 'node:child_process';

const CMD_TIMEOUT = 3000;
const LAUNCH_TIMEOUT = 10_000;

/**
 * Check whether a tmux session exists.
 * @param {string} session
 * @returns {boolean}
 */
export function tmuxHasSession(session) {
  try {
    execFileSync('tmux', ['has-session', '-t', session], {
      timeout: CMD_TIMEOUT,
      stdio: 'ignore',
    });
    return true;
  } catch (err) {
    if (isTimeoutError(err)) _debugTimeout('tmux has-session', err);
    return false;
  }
}

/**
 * Get the pane PID for a tmux session.
 * @param {string} session
 * @returns {number} PID or 0
 */
export function tmuxGetPanePid(session) {
  try {
    const out = execFileSync('tmux', ['list-panes', '-t', session, '-F', '#{pane_pid}'], {
      encoding: 'utf8',
      timeout: CMD_TIMEOUT,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const lines = out.split('\n');
    const pid = parseInt(lines[0], 10);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch (err) {
    if (isTimeoutError(err)) _debugTimeout('tmux list-panes', err);
    return 0;
  }
}

/**
 * Kill a tmux session.
 * @param {string} session
 */
export function tmuxKillSession(session) {
  try {
    execFileSync('tmux', ['kill-session', '-t', session], {
      timeout: CMD_TIMEOUT,
      stdio: 'ignore',
    });
  } catch { /* session may not exist */ }
}

/**
 * Send text to a tmux session via the buffer-paste technique.
 * Handles special characters safely.
 *
 * @param {string} session
 * @param {string} tmpFile - Path to a temp file containing the text
 * @param {string} bufferName - Unique tmux buffer name
 */
export function tmuxPasteBuffer(session, tmpFile, bufferName) {
  execFileSync('tmux', ['load-buffer', '-b', bufferName, tmpFile], {
    timeout: CMD_TIMEOUT,
    stdio: 'ignore',
  });
  execFileSync('tmux', ['paste-buffer', '-b', bufferName, '-t', session], {
    timeout: CMD_TIMEOUT,
    stdio: 'ignore',
  });
  execFileSync('tmux', ['send-keys', '-t', session, 'Enter'], {
    timeout: CMD_TIMEOUT,
    stdio: 'ignore',
  });
}

/**
 * Delete a tmux buffer (best-effort).
 * @param {string} bufferName
 */
export function tmuxDeleteBuffer(bufferName) {
  try {
    execFileSync('tmux', ['delete-buffer', '-b', bufferName], {
      timeout: CMD_TIMEOUT,
      stdio: 'ignore',
    });
  } catch { /* best-effort */ }
}

/**
 * Capture tmux pane content.
 * @param {string} session
 * @returns {string|null}
 */
export function tmuxCapturePaneText(session) {
  try {
    return execFileSync('tmux', ['capture-pane', '-p', '-t', session], {
      encoding: 'utf8',
      timeout: CMD_TIMEOUT,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    if (isTimeoutError(err)) _debugTimeout('tmux capture-pane', err);
    return null;
  }
}

/**
 * Send keys to a tmux session.
 * @param {string} session
 * @param {...string} keys
 */
export function tmuxSendKeys(session, ...keys) {
  execFileSync('tmux', ['send-keys', '-t', session, ...keys], {
    timeout: CMD_TIMEOUT,
    stdio: 'ignore',
  });
}

/**
 * Create a new tmux session.
 * @param {string[]} args - Full argument list for `tmux new-session`
 */
export function tmuxNewSession(args) {
  execFileSync('tmux', args, { timeout: LAUNCH_TIMEOUT });
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

/**
 * Get the full command line for a PID.
 * Unlike `comm=`, this includes script paths and arguments — needed on macOS,
 * where shebang CLIs (claude, codex) report the interpreter (e.g. "node") as
 * their process name instead of the script name.
 * @param {number} pid
 * @returns {string|null}
 */
export function getProcessCommand(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: CMD_TIMEOUT,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get direct child PIDs of a process.
 * @param {number} parentPid
 * @returns {number[]}
 */
export function getChildPids(parentPid) {
  try {
    const out = execFileSync('pgrep', ['-P', String(parentPid)], {
      encoding: 'utf8',
      timeout: CMD_TIMEOUT,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/**
 * Check whether an agent binary (e.g. "claude", "codex") is running anywhere
 * in the pane's process tree, walking from the pane process down.
 *
 * A single comm/pgrep check is not portable: the pane process is usually the
 * tmux launcher (comm "node" or "MainThread"), macOS reports the interpreter
 * for shebang CLIs, and a shell wrapper can push the agent one generation
 * deeper. At each level this matches either the process name or the full
 * command line (binary name as a path segment or standalone word).
 *
 * @param {number} panePid
 * @param {string} name - agent binary name, e.g. "claude"
 * @param {number} [maxDepth=3] - generations to descend below the pane process
 * @returns {boolean}
 */
export function isAgentInProcessTree(panePid, name, maxDepth = 3) {
  const re = new RegExp(`(^|[/\\s])${name}(\\s|$)`);
  let frontier = [panePid];
  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
    for (const pid of frontier) {
      if (getProcessName(pid) === name) return true;
      const cmd = getProcessCommand(pid);
      if (cmd && re.test(cmd)) return true;
    }
    frontier = frontier.flatMap((pid) => getChildPids(pid));
  }
  return false;
}

/**
 * Check if a PID has a child matching a pattern.
 * @param {number} parentPid
 * @param {string} pattern
 * @returns {boolean}
 */
export function hasChildProcess(parentPid, pattern) {
  try {
    execFileSync('pgrep', ['-P', String(parentPid), '-f', pattern], {
      timeout: CMD_TIMEOUT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export function isTimeoutError(err) {
  return err?.code === 'ETIMEDOUT';
}

function _debugTimeout(label, err) {
  const signal = err.signal || 'unknown';
  process.stderr.write(`[tmux-helpers] ${label} timed out (code=${err?.code}, signal=${signal})\n`);
}
