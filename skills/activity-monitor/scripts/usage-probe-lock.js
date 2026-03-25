import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeReadLock(lockFile) {
  try {
    return JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch {
    return null;
  }
}

function isLockStale(lock, now, ttlSeconds, sessionExistsFn) {
  if (!lock || !lock.startedAt) return true;
  if ((now - lock.startedAt) > ttlSeconds) return true;

  const pidAlive = isPidAlive(lock.pid);
  if (!pidAlive) return true;

  if (lock.sessionName && typeof sessionExistsFn === 'function') {
    return !sessionExistsFn(lock.sessionName);
  }

  return false;
}

export function acquireUsageProbeLock({
  lockFile,
  ttlSeconds,
  sessionName,
  sessionExistsFn,
}) {
  const now = Math.floor(Date.now() / 1000);
  const token = randomUUID();
  const lockPayload = {
    pid: process.pid,
    startedAt: now,
    token,
    sessionName,
  };

  const tryCreate = () => {
    const fd = fs.openSync(lockFile, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(lockPayload));
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, token };
  };

  try {
    return tryCreate();
  } catch (err) {
    if (err?.code !== 'EEXIST') {
      return { ok: false, reason: 'sidecar_error' };
    }
  }

  const existing = safeReadLock(lockFile);
  if (!isLockStale(existing, now, ttlSeconds, sessionExistsFn)) {
    return { ok: false, reason: 'lock_busy' };
  }

  try {
    fs.unlinkSync(lockFile);
  } catch {
    return { ok: false, reason: 'lock_busy' };
  }

  try {
    return tryCreate();
  } catch {
    return { ok: false, reason: 'lock_busy' };
  }
}

export function releaseUsageProbeLock({ lockFile, token }) {
  const existing = safeReadLock(lockFile);
  if (!existing || existing.token !== token) return false;

  try {
    fs.unlinkSync(lockFile);
    return true;
  } catch {
    return false;
  }
}
