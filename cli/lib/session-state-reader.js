import fs from 'node:fs';
import path from 'node:path';
import { createSessionReader } from './session-state-reader-async.js';
import { zylosRoot } from './session-group-paths.js';
import { safeHealthReason } from '../../skills/activity-monitor/scripts/health-evidence.js';

// Public readers retain one asynchronous tmux connection per observation.
export const { readLiveIdentity, readSessionState, resolveTargetRuntime,
  readCodexUsageSample, readAccountUsage } = createSessionReader();

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
  return { ...record, rateLimitActive: record.rateLimitActive ?? (record.health === 'rate_limited'), reason: record.health === 'ok' ? '' : safeHealthReason(record.health, record.reason),
    publicHealth: ['recovering','down'].includes(record.health) ? 'unavailable' : record.health };
}
