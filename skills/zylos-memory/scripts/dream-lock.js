import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { withMemoryLock, memoryError } from './sync-lock.js';

export const DREAM_HEARTBEAT_MS = 30_000;
export const DREAM_LEASE_MS = 120_000;
export const dreamRunDirectory = root => path.join(root, 'activity-monitor', 'memory-dreaming');

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

export function dreamLock(root, { now = Date.now, alive = processAlive, pid = process.pid } = {}) {
  const directory = dreamRunDirectory(root);
  const file = path.join(directory, 'lease.json');

  function read() {
    try {
      const lease = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(lease?.pid) || lease.pid < 1 || !Number.isFinite(lease.heartbeat) ||
          !/^[0-9a-f]{32}$/.test(lease.token ?? '')) throw memoryError('LOCK_UNAVAILABLE', 'Invalid dream lease');
      return lease;
    }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  function fresh(lease) {
    return lease && now() - lease.heartbeat <= DREAM_LEASE_MS && alive(lease.pid);
  }

  function publish(lease) {
    const temporary = `${file}.${lease.token}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(lease), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  function guard(token, action) {
    return withMemoryLock(directory, () => {
      const lease = read();
      if (lease?.token !== token || !fresh(lease)) throw memoryError('TOKEN_MISMATCH', 'Dream ownership has expired');
      return action(lease);
    });
  }

  return {
    acquire: () => withMemoryLock(directory, () => {
      if (fresh(read())) return null;
      const token = randomBytes(16).toString('hex');
      publish({ token, pid, heartbeat: now() });
      return token;
    }),
    guard,
    heartbeat: token => guard(token, lease => publish({ ...lease, heartbeat: now() })),
    release: token => withMemoryLock(directory, () => {
      if (read()?.token === token) fs.unlinkSync(file);
    }),
  };
}
