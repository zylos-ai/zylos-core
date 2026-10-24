/** Shared M2 paths and strict, reversible tmux group names (IB-26). */
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { encodeGroupCharacters, decodeGroupCharacters } from './session-group-codec.js';
import { parseSessionGroup } from '../../skills/comm-bridge/scripts/c4-db.js';
import { tmuxClientArgs } from './runtime/tmux-client-args.js';

export const GROUP_TMUX_PREFIX = 'zylos-group-';
export const LEGACY_TMUX_NAMES = Object.freeze(['claude-main', 'codex-main']);
export const SETUP_TMUX_NAME = 'zylos-setup';
export const RUN_FILES = Object.freeze({
  CURRENT_SESSION: 'current-session.json', STATUSLINE: 'statusline.json',
  EVENTS: 'events.jsonl', AGENT_STATUS: 'agent-status.json',
});

export function assertSessionGroup(group) {
  if (!parseSessionGroup(group)) {
    const error = new Error('Invalid session group');
    error.code = 'SESSION_GROUP_INVALID';
    throw error;
  }
  return group;
}

export function zylosRoot(env = process.env) {
  return env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos');
}

export function tmuxNameForGroup(group) {
  return GROUP_TMUX_PREFIX + encodeGroupCharacters(assertSessionGroup(group));
}

export function groupFromTmuxName(name) {
  if (typeof name !== 'string' || !name.startsWith(GROUP_TMUX_PREFIX)) return null;
  const encoded = name.slice(GROUP_TMUX_PREFIX.length);
  const group = decodeGroupCharacters(encoded);
  if (group === null || !parseSessionGroup(group)) return null;
  return tmuxNameForGroup(group) === name ? group : null;
}

// Targets also serve explicit legacy names at migration call sites.
export const tmuxSessionTarget = name => `=${name}`;
export const tmuxPaneTarget = name => `=${name}:`;

export function groupMemoryDir(group, env = process.env) {
  return path.join(zylosRoot(env), 'memory', 'session-groups', assertSessionGroup(group));
}
export function groupRunDir(group, env = process.env) {
  return path.join(zylosRoot(env), 'activity-monitor', 'session-groups', assertSessionGroup(group));
}
export function legacyRunDir(env = process.env) {
  return path.join(zylosRoot(env), 'activity-monitor');
}
export function runDirFromEnv(env = process.env) {
  if (Object.hasOwn(env, 'ZYLOS_SESSION_GROUP')) {
    const sessionGroup = assertSessionGroup(env.ZYLOS_SESSION_GROUP);
    return { dir: groupRunDir(sessionGroup, env), sessionGroup, kind: 'group' };
  }
  if (env.ZYLOS_RUN_ID) return { dir: groupRunDir('origin', env), sessionGroup: null, kind: 'single' };
  return { dir: legacyRunDir(env), sessionGroup: null, kind: 'legacy' };
}
export const routerDiagnosticPath = (env = process.env) => path.join(zylosRoot(env), 'comm-bridge', 'router-events.jsonl');
export const supervisorDiagnosticPath = (env = process.env) => path.join(legacyRunDir(env), 'supervisor-events.jsonl');
export const poolMetricsPath = (env = process.env) => path.join(legacyRunDir(env), 'pool-metrics.jsonl');
export const hookErrorLogPath = (env = process.env) => path.join(legacyRunDir(env), 'hook-activity-errors.log');

// Keep the former synchronous error contract while letting the event loop run.
function execTmuxFile(binary, args, { timeout, ...options }) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = execFile(binary, args, { ...options, timeout: 0 }, (error, stdout, stderr) => {
      clearTimeout(timer);
      child.stdin.destroy();
      if (timedOut) {
        error ||= new Error(`Command timed out: ${binary}`);
        error.code = 'ETIMEDOUT';
        error.status = child.exitCode;
        error.signal = child.signalCode;
      }
      if (!error) { resolve(stdout); return; }
      error.stdout = stdout;
      error.stderr = stderr;
      if (typeof error.code === 'number') {
        error.status = error.code;
        delete error.code;
      }
      reject(error);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      // A frozen server may retain the client's pipe descriptors. Release our
      // streams before killing it; execFile settles only after client close.
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      child.kill();
    }, timeout);
  });
}

/** One read only; missing tmux binary, permissions and malformed output are errors. */
export async function listGroupTmuxSessions({ exec = execTmuxFile, socketPath, socketName, binary = 'tmux' } = {}) {
  const args = [...tmuxClientArgs({ socketPath, socketName }), 'list-sessions', '-F', '#{session_name}\t#{session_created}'];
  let output;
  try {
    output = await exec(binary, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr = String(error.stderr || '').trim();
    // tmux reports an absent or exited server with these diagnostics. Do not
    // swallow ENOENT (binary missing), timeout, permission or generic I/O errors.
    if (error.status === 1 && !error.code && (
      /^no server running on [^\n]+$/.test(stderr) ||
      /^error connecting to [^\n]+ \(No such file or directory\)$/.test(stderr)
    )) return [];
    throw error;
  }
  const result = [];
  for (const line of String(output).split('\n')) {
    if (!line) continue;
    const [tmuxName, timestamp, ...extra] = line.split('\t');
    const sessionGroup = groupFromTmuxName(tmuxName);
    if (sessionGroup === null) continue;
    if (extra.length || !/^\d+$/.test(timestamp || '') || !Number.isSafeInteger(Number(timestamp))) {
      const error = new Error('Invalid tmux session creation timestamp');
      error.code = 'TMUX_RESPONSE_INVALID';
      throw error;
    }
    result.push({ sessionGroup, tmuxName, createdAt: Number(timestamp) });
  }
  return result;
}

export { handoffPath, rulesPath, modeSwitchDir, modeSwitchPreviousDir,
  modeSwitchDonePath, modeSwitchUngroupedPath, modeSwitchGroupPath } from './session-memory-paths.js';
