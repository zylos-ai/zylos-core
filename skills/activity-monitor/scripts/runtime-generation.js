import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const runtimeRoot = () => process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
export function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function durableJson(file, value) {
  const directory = path.dirname(file);
  const created = fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (created) syncDirectory(path.dirname(directory));
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    syncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch { /* Only this writer's temporary file. */ }
    throw error;
  }
}
export function readProcessStart(pid, { platform = process.platform, readFileSync = fs.readFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return /^\d+$/.test(ticks) && /^[0-9a-f-]{36}$/.test(boot) ? `${boot}:${ticks}` : null;
  } catch { return null; }
}

export function isManagedClaudeProcess(pid, { session = 'claude-main', expectedStart,
  processStart = readProcessStart, read = fs.readFileSync, run = execFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  const start = processStart(pid);
  if (!start || (expectedStart !== undefined && expectedStart !== start)) return false;
  try {
    const pane = Number(run('tmux', ['display-message', '-p', '-t', session, '#{pane_pid}'], {
      encoding: 'utf8', timeout: 2000, stdio: 'pipe',
    }).trim());
    let ancestor = pid;
    for (let depth = 0; depth < 8 && ancestor > 1; depth++) {
      if (ancestor === pane) return processStart(pid) === start;
      const stat = read(`/proc/${ancestor}/stat`, 'utf8');
      ancestor = Number(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[1]);
    }
  } catch { /* Missing process evidence cannot authorize a health event. */ }
  return false;
}
