import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readParentPidViaPs } from './claude-pid.js';
import { TMUX_COMMAND as C, TMUX_FORMAT as F } from '../../comm-bridge/scripts/tmux-protocol.js';

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
export function isManagedClaudeProcess(pid, { session = 'claude-main', platform = process.platform,
  read = fs.readFileSync, run = execFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    const pane = Number(run('tmux', [C.displayMessage, '-p', '-t', session, F.panePid], {
      encoding: 'utf8', timeout: 2000, stdio: 'pipe',
    }).trim());
    if(!Number.isSafeInteger(pane)||pane<=1)return false;
    let ancestor = pid;
    const seen=new Set();
    for (let depth = 0; depth < 8 && ancestor > 1; depth++) {
      if (ancestor === pane) return true;
      if(seen.has(ancestor))return false;
      seen.add(ancestor);
      let parent=0;
      if(platform==='linux') {
        try {
          const stat=read(`/proc/${ancestor}/stat`,'utf8');
          parent=Number(stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[1]);
        } catch { /* ps is also available when procfs cannot be read. */ }
      }
      ancestor=Number.isSafeInteger(parent)&&parent>0?parent:readParentPidViaPs(ancestor,{execFileSyncImpl:run});
    }
  } catch { /* Missing process evidence cannot authorize a health event. */ }
  return false;
}
