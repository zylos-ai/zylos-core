import os from 'node:os';

function positiveInteger(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^[0-9]+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Shared startup-only pool sizing for the router and supervisor. */
export function resolveSessionPoolSize({ env = process.env, config = {}, cpuCount = os.cpus().length,
  totalMemoryBytes = os.totalmem() } = {}) {
  const fallback = Math.max(1, Math.min(cpuCount * 2, Math.floor(totalMemoryBytes / 1024 ** 3 - 2)));
  return positiveInteger(env.ZYLOS_SESSION_POOL_SIZE) ?? positiveInteger(config.session_pool_size) ?? fallback;
}
