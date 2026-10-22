import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { zylosRoot } from './session-group-paths.js';
import { safeHealthReason } from '../../skills/activity-monitor/scripts/health-evidence.js';

// A short-lived thread keeps the public API synchronous while the whole read
// holds one asynchronous tmux connection. It is read-only and never reconnects.
function invoke(method, args) {
  const shared = new SharedArrayBuffer(8 + 16 * 1024 * 1024);
  const control = new Int32Array(shared, 0, 2);
  const worker = new Worker(new URL('./session-state-reader-worker.js', import.meta.url), { workerData: { method, args, shared } });
  worker.on('error', () => {}); // Worker bootstrap failure is bounded by the wait.
  const outcome = Atomics.wait(control, 0, 0, 15000);
  if (outcome === 'timed-out') {
    void worker.terminate();
    throw Object.assign(new Error('Session observation timed out'), { code: 'READER_TIMEOUT' });
  }
  const result = JSON.parse(new TextDecoder().decode(new Uint8Array(shared, 8, Atomics.load(control, 1))));
  if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code, cause: result.error.cause });
  return result.value;
}
export const readLiveIdentity = sessionGroup => invoke('readLiveIdentity', [sessionGroup]);
export const readSessionState = (sessionGroup, options) => invoke('readSessionState', [sessionGroup, options]);
export const resolveTargetRuntime = sessionGroup => invoke('resolveTargetRuntime', [sessionGroup]);
export const readCodexUsageSample = options => invoke('readCodexUsageSample', [options]);
export const readAccountUsage = runtime => invoke('readAccountUsage', [runtime]);

export function readRuntimeHealth(runtime) {
  if (!['claude','codex'].includes(runtime)) throw new TypeError('Unknown runtime');
  let record;
  try { record = JSON.parse(fs.readFileSync(path.join(zylosRoot(), 'activity-monitor', 'runtime-health', `${runtime}.json`), 'utf8')); }
  catch (error) { return error.code === 'ENOENT' ? { missing: true } : { unreadable: true }; }
  const states = ['ok','rate_limited','auth_failed','unavailable','recovering','down'];
  if (record?.v !== 1 || record.runtime !== runtime || !states.includes(record.health) || typeof record.reason !== 'string' ||
      !Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0 || !record.hook || typeof record.hook !== 'object' || Array.isArray(record.hook)) return { unreadable: true };
  const seconds = ['unavailableSince','cooldownUntil','recoveringStartedAt','lastUserMessageRecoveryAt','restartFailureCount','lastRecoveryAt','lastDownCheckAt'];
  if (seconds.some(key => !Number.isSafeInteger(record[key]) || record[key] < 0) || typeof record.rateLimitResetTime !== 'string' ||
      (record.rateLimitActive !== undefined && typeof record.rateLimitActive !== 'boolean')) return { unreadable: true };
  // Preserve historical evidence verbatim; only the current reason is normalized.
  return { ...record, reason: record.health === 'ok' ? '' : safeHealthReason(record.health, record.reason),
    publicHealth: ['recovering','down'].includes(record.health) ? 'unavailable' : record.health };
}
