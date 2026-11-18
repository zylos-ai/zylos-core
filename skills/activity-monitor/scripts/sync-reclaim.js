import { loadCoreModule } from './core-modules.js';
const { supervisorDiagnosticPath } = await loadCoreModule('session-group-paths.js');
const { EventLogReader } = await loadCoreModule('event-log.js');

// Capture before dispatch: replies and later shrinking backlog cannot move this
// target. A retry repairs the original target rather than demanding another cp.
export async function captureSyncTarget({ db, scene, kind = 'group', range, now = Date.now() }) {
  const scope = scene.sessionGroup;
  if (kind === 'origin') {
    const backlog = await db.getOriginSyncBacklog();
    return { kind, scope, startedAt: now, cursors: backlog.groups.map(row => ({
      scope: row.sessionGroup, syncedId: row.cursorFrom, checkpointId: row.checkpointFrom,
    })) };
  }
  const checkpoint = await db.getLatestContentCheckpoint(scope);
  const end = range?.lastConversationId ?? range?.safeEnd ?? await db.getDeliveredFrontier(scope);
  if (!Number.isSafeInteger(end) || end < 0) throw new TypeError('Invalid reclaim Sync target end');
  return { kind, scope, startedAt: now, checkpointId: checkpoint?.id ?? null, end };
}

export async function observeSyncCompletion({ db, scene, target, readSyncMarker, requireNewCheckpoint = true }) {
  const marker = await readSyncMarker({ runDir: scene.runDir, kind: target.kind, currentRunId: scene.runId });
  if (!marker || typeof marker.held !== 'boolean' || typeof marker.stale !== 'boolean') throw new TypeError('Invalid Sync marker result');
  if (marker.held && !marker.stale) return { ok: false, reason: 'control_timeout' };
  if (target.kind === 'origin') {
    // Origin consumes at most one round's quota, so durable cursor progress is
    // success even when other groups remain. It never creates a group state.
    let advanced = false;
    for (const before of target.cursors) {
      const current = await db.getOriginSyncCursor(before.scope);
      if (current && (current.syncedId > before.syncedId || current.checkpointId > before.checkpointId)) advanced = true;
    }
    if (!advanced) return { ok: false, reason: 'no_checkpoint' };
  } else {
    const checkpoint = await db.getLatestContentCheckpoint(target.scope);
    if (!checkpoint || requireNewCheckpoint && checkpoint.id <= (target.checkpointId ?? 0) || checkpoint.end_conversation_id < target.end) {
      return { ok: false, reason: 'no_checkpoint' };
    }
  }
  return { ok: true };
}

// A bounded reverse reader retains only the most recent error for this attempt;
// use result codes for diagnosis, never as proof that memory was committed.
export function latestSyncFailure({ env = process.env, scene, target, startedAt }) {
  const reader = new EventLogReader(supervisorDiagnosticPath(env));
  let code;
  try {
    reader.recoverTail(row => {
      if (row.ts < startedAt) return { done: true };
      if (row.event === 'sync_result' && row.kind === target.kind && row.scope === target.scope &&
          row.runId === scene.runId && row.status === 'error' && typeof row.code === 'string') {
        code = row.code; return { done: true };
      }
      return {};
    });
  } finally { reader.close(); }
  return code;
}
