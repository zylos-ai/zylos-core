import fs from 'node:fs';
import path from 'node:path';
import { parseSupervisorConfiguration } from '../../activity-monitor/scripts/supervisor-configuration.js';
import { recordResult } from './sync-results.js';

export function initializeOriginRound(root, env = process.env) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(root, '.zylos', 'config.json'), 'utf8')); } catch { /* Optional limits use defaults. */ }
  return { rawQuota: parseSupervisorConfiguration(config, env).originSyncThreshold,
    processedCount: 0, advancedGroups: 0, errorCount: 0 };
}
// Called only inside the same ownership lock that protects the cursor mutation.
export function updateOriginRound(scope, marker, { count = 0, advanced = false, error = false } = {}) {
  const next = { ...initializeOriginRound(scope.root), ...marker,
    processedCount: (marker.processedCount || 0) + count,
    advancedGroups: (marker.advancedGroups || 0) + Number(advanced),
    errorCount: (marker.errorCount || 0) + Number(error) };
  const target = path.join(scope.runDir, 'origin-sync.lock');
  const temporary = `${target}.${marker.token}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, target);
  return next;
}
export async function completeOriginRound(scope, marker, env = process.env, deps = {}) {
  try {
    const database = deps.database || await import('../../comm-bridge/scripts/c4-db.js');
    const backlog = database.getOriginSyncBacklog();
    const round = { ...initializeOriginRound(scope.root, env), ...marker };
    await recordResult({ action: 'round_complete', kind: 'origin', scope: 'origin',
      status: round.errorCount ? 'error' : 'success', code: round.errorCount ? 'PARTIAL_FAILURE' : undefined,
      startedAt: marker.startedAt, processedCount: round.processedCount,
      advancedGroups: round.advancedGroups, errorCount: round.errorCount,
      remainingQuota: Math.max(0, round.rawQuota - round.processedCount), hasRemaining: backlog.groups.length > 0 }, { env });
  } catch {
    await recordResult({ action: 'round_complete', kind: 'origin', scope: 'origin', status: 'error', code: 'RESULT_UNAVAILABLE', startedAt: marker.startedAt }, { env });
  }
}
