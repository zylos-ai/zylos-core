import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

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

export function getClaudePid({
  platform = process.platform,
  shellPid = process.ppid,
  fsImpl = fs,
  execFileSyncImpl = execFileSync
} = {}) {
  if (!Number.isInteger(shellPid) || shellPid <= 0) return 0;

  if (platform === 'linux') {
    const procParent = readParentPidFromProc(shellPid, { fsImpl });
    if (procParent > 0) return procParent;
  }

  const psParent = readParentPidViaPs(shellPid, { execFileSyncImpl });
  if (psParent > 0) return psParent;

  return shellPid;
}
