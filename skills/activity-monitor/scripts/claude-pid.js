import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Shells a runtime may put between itself and a hook command (`sh -c`). A hook
// command starting with `exec` replaces the shell, but the walk does not rely on it.
export const SHELLS = new Set(['sh', 'dash', 'bash', 'zsh', 'ksh', 'mksh', 'ash', 'fish', 'busybox']);
const MAX_SHELL_HOPS = 4;

function normalizePositiveInt(value) {
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function readParentPidFromProc(shellPid, { fsImpl = fs } = {}) {
  if (!Number.isInteger(shellPid) || shellPid <= 0) return 0;
  try {
    const status = fsImpl.readFileSync(`/proc/${shellPid}/status`, 'utf8');
    const match = status.match(/^PPid:\s*(\d+)/m);
    return match ? normalizePositiveInt(match[1]) : 0;
  } catch {
    return 0;
  }
}

export function readParentPidViaPs(shellPid, { execFileSyncImpl = execFileSync } = {}) {
  if (!Number.isInteger(shellPid) || shellPid <= 0) return 0;
  try {
    const out = execFileSyncImpl('ps', ['-o', 'ppid=', '-p', String(shellPid)], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 3000
    });
    return normalizePositiveInt(out);
  } catch {
    return 0;
  }
}

/**
 * Parse /proc/<pid>/stat. The name sits in parentheses and may itself contain
 * spaces or parentheses, so fields are counted from the last ')'. `start` is
 * field 22 (starttime, clock ticks since boot), unchanged across exec.
 */
export function parseProcStat(pid, text) {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const fields = text.slice(close + 2).trim().split(/\s+/);
  const ppid = Number.parseInt(fields[1], 10);
  const start = fields[19];
  if (!Number.isInteger(ppid) || ppid < 0 || !/^\d+$/.test(start ?? '')) return null;
  return { pid, ppid, start, comm: text.slice(open + 1, close) };
}

/** Parse `ps -o ppid=,lstart=,comm=`; lstart is five fixed tokens in the C locale. */
export function parsePsRow(pid, text) {
  const match = String(text).trim().match(/^(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/);
  if (!match) return null;
  return { pid, ppid: Number(match[1]), start: match[2].replace(/\s+/g, ' '), comm: path.basename(match[3].trim()) };
}

/**
 * Read one process: `{pid, ppid, start, comm}`, or null when it cannot be read.
 * Linux reads /proc; other platforms (and Linux without /proc) ask ps.
 */
export function readProcessInfo(pid, {
  platform = process.platform,
  fsImpl = fs,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (platform === 'linux') {
    try { return parseProcStat(pid, fsImpl.readFileSync(`/proc/${pid}/stat`, 'utf8')); }
    catch { /* fall through to ps */ }
  }
  try {
    return parsePsRow(pid, execFileSyncImpl('ps', ['-o', 'ppid=,lstart=,comm=', '-p', String(pid)], {
      encoding: 'utf8', stdio: 'pipe', timeout: 3000, env: { ...process.env, LC_ALL: 'C' },
    }));
  } catch {
    return null;
  }
}

/** Start time of one process, or null when it cannot be read. */
export function readProcessStart(pid, options) {
  return readProcessInfo(pid, options)?.start ?? null;
}

/** First ancestor-or-self of `pid` that is not a shell, or null when unreadable. */
export function firstNonShellAncestor(pid, readInfo = readProcessInfo) {
  for (let hop = 0; hop <= MAX_SHELL_HOPS; hop += 1) {
    const info = readInfo(pid);
    if (!info) return null;
    if (!SHELLS.has(info.comm.replace(/^-/, ''))) return info;
    pid = info.ppid;
  }
  return null;
}

/**
 * The process that fired the running hook: the first ancestor of this hook
 * process that is not a shell. Returns `{pid, ppid, start, comm}` or null when
 * any step cannot be read.
 */
export function readHookTrigger({ startPid = process.ppid, ...options } = {}) {
  return firstNonShellAncestor(startPid, pid => readProcessInfo(pid, options));
}

/** Pid of the runtime that fired the running hook (shared by health evidence). */
export function getClaudePid({
  platform = process.platform,
  shellPid = process.ppid,
  fsImpl = fs,
  execFileSyncImpl = execFileSync
} = {}) {
  if (!Number.isInteger(shellPid) || shellPid <= 0) return 0;

  const trigger = readHookTrigger({ startPid: shellPid, platform, fsImpl, execFileSyncImpl });
  if (trigger) return trigger.pid;

  if (platform === 'linux') {
    const procParent = readParentPidFromProc(shellPid, { fsImpl });
    if (procParent > 0) return procParent;
  }

  const psParent = readParentPidViaPs(shellPid, { execFileSyncImpl });
  if (psParent > 0) return psParent;

  return shellPid;
}
