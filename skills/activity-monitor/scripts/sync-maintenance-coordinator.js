import { loadCoreModule } from './core-modules.js';
import { captureSyncTarget, observeSyncCompletion, latestSyncFailure } from './sync-reclaim.js';
const { createMaintenanceRequests } = await loadCoreModule('sync-maintenance.js');

const terminal = new Set(['done', 'timeout', 'failed', 'cancelled', 'superseded']);
const active = row => ['running', 'finishing'].includes(row.phase);

/** Supervisor owns repair decisions; the Router alone reserves/launches a normal
 * configured slot. Durable requests bridge the processes without fake messages. */
export class SyncMaintenanceCoordinator {
  constructor({ env = process.env, now = Date.now, store, diagnostic = () => {} } = {}) {
    this.env = env; this.now = now; this.store = store ?? createMaintenanceRequests({ env, now });
    this.diagnostic = diagnostic;
  }
  owns(scene) {
    return this.store.read().some(row => active(row) && row.sessionGroup === scene.sessionGroup && row.runId === scene.runId);
  }
  async advance(alerts, context, lifecycle) {
    const { db } = lifecycle.d, failures = [], resolved = [];
    if (context.configuration.mode !== 'multi' || context.transition || context.restartRequestsError) return { alerts, failures, resolved };
    const sceneFor = group => context.scenes.find(scene => scene.sessionGroup === group);
    const blocked = group => context.fences.some(fence => fence.sessionGroup === group || fence.sessionGroup === '*');
    const pending = group => db.getNextPending?.({ sessionGroups: [group] });
    const rows = this.store.read();
    for (const row of rows) {
      if (!active(row)) continue;
      const group = row.sessionGroup, scene = sceneFor(group);
      if (pending(group)) { await this.store.cancelMaintenance(group, row.runId); continue; }
      if (blocked(group) && row.phase !== 'finishing') continue;
      if (scene?.observationError) continue;
      if (scene?.present && scene.runId !== row.runId) { await this.store.cancelMaintenance(group, row.runId); continue; }
      if (row.phase === 'finishing') {
        if (!scene?.present) {
          await this.store.update(group, row.runId, { phase: row.outcome === 'success' ? 'complete' : 'failed', finishedAt: this.now() });
        } else if (scene.ready && !blocked(group)) await this.release(row, scene, context, lifecycle);
        continue;
      }
      if (!scene?.present || !scene.ready) {
        // Launch/READY failures count as the claimed attempt, including across
        // supervisor/Router restart; no replacement launch can bypass its window.
        if (this.now() - row.startedAt < 900000) continue;
        const updated = await this.store.update(group, row.runId, { phase: scene?.present ? 'finishing' : 'failed', outcome: 'error', failure: 'activation_timeout', finishedAt: this.now() });
        if (updated) failures.push({ type: 'repair_failed', repairAttempt: 'maintenance', kind: 'group', scope: group, reason: 'activation_timeout', checkpointId: row.target.checkpointId, checkpointEnd: row.target.end });
        continue;
      }
      let controlId = row.controlId;
      if (!controlId) {
        const current = await lifecycle.d.readCurrentSession?.(group);
        if (current?.runId === row.runId) controlId = current.startupControlIds?.[0];
        if (Number.isSafeInteger(controlId)) {
          const linked = await this.store.update(group, row.runId, { controlId });
          if (linked) await lifecycle.recordSyncTrigger(scene, 'group', [row.reason === 'backlog' ? 'max_lag' : 'state_repair'],
            { count: row.target.backlog ?? 0, firstAt: row.target.firstAt ?? null }, { id: controlId }, row.target.checkpointId);
        }
      }
      const result = await observeSyncCompletion({ db, scene, target: row.target, readSyncMarker: lifecycle.d.readSyncMarker,
        env: this.env, requireNewCheckpoint: row.reason === 'backlog' });
      const control = controlId ? await db.getControlById(controlId) : null;
      if (!result.ok && !terminal.has(control?.status) && this.now() - row.startedAt < 900000) continue;
      const reason = result.ok ? null : latestSyncFailure({ env: this.env, scene, target: row.target, startedAt: row.startedAt })
        ?? (control?.status === 'timeout' ? 'control_timeout' : result.reason);
      const updated = await this.store.update(group, row.runId, { phase: 'finishing', outcome: result.ok ? 'success' : 'error', failure: reason, finishedAt: this.now() });
      if (!updated) continue; // A real-message transition won the concurrent write.
      if (!result.ok) failures.push({ type: 'repair_failed', repairAttempt: 'maintenance', kind: 'group', scope: group, reason, checkpointId: row.target.checkpointId, checkpointEnd: row.target.end });
      await this.release(updated, scene, context, lifecycle);
      await this.diagnostic({ event: 'sync_maintenance_finished', scope: group, runId: row.runId, status: updated.outcome, reason });
    }
    const eligible = new Set();
    const remaining = [];
    for (const alert of alerts) {
      const scene = sceneFor(alert.scope);
      if (alert.kind !== 'group' || !['backlog', 'state_uncommitted'].includes(alert.type) || scene?.present || scene?.observationError) {
        remaining.push(alert); continue;
      }
      eligible.add(alert.scope);
      if (blocked(alert.scope) || (alert.scope !== 'origin' && await db.getActiveDeletion?.(alert.scope)) || pending(alert.scope)) continue;
      const range = await db.getUnsummarizedRange(alert.scope);
      const target = { ...await captureSyncTarget({ db, scene: { sessionGroup: alert.scope }, kind: 'group', range, now: this.now() }),
        backlog: range.count, firstAt: range.firstAt };
      await this.store.queue({ sessionGroup: alert.scope, reason: alert.type, target,
        windowMs: (context.configuration.syncMaxIntervalSeconds ?? 21600) * 1000 });
      // Raw symptoms are suppressed while repair is queued/running or already
      // attempted in this window; its definitive failure is the notification.
    }
    for (const row of this.store.read()) {
      if (row.phase === 'queued' && (!eligible.has(row.sessionGroup) || pending(row.sessionGroup) || blocked(row.sessionGroup))) {
        await this.store.cancelMaintenance(row.sessionGroup);
      }
      if (row.phase === 'failed' || row.phase === 'finishing' && row.outcome === 'error' || row.phase === 'complete') {
        const scene = sceneFor(row.sessionGroup) ?? { sessionGroup: row.sessionGroup, runId: row.runId, runDir: lifecycle.d.groupRunDir(row.sessionGroup) };
        const fixed = await observeSyncCompletion({ db, scene, target: row.target, readSyncMarker: lifecycle.d.readSyncMarker, env: this.env, requireNewCheckpoint: false });
        if (fixed.ok) resolved.push({ type: 'repair_failed', repairAttempt: 'maintenance', kind: 'group', scope: row.sessionGroup });
        else if (row.phase !== 'complete') failures.push({ type: 'repair_failed', repairAttempt: 'maintenance', kind: 'group', scope: row.sessionGroup, reason: row.failure ?? 'no_checkpoint', checkpointId: row.target.checkpointId, checkpointEnd: row.target.end });
      }
    }
    const ownedControls = new Set(this.store.read().map(row => row.controlId).filter(Number.isSafeInteger));
    return { alerts: remaining.filter(alert => alert.type !== 'control_timeout' || !ownedControls.has(alert.controlId)), failures, resolved };
  }
  async release(row, scene, context, lifecycle) {
    if (!lifecycle.releasePreparation.has(scene.sessionGroup)) await lifecycle.requestRelease(scene, context);
    const intent = lifecycle.releasePreparation.get(scene.sessionGroup);
    if (intent?.runId !== row.runId) return;
    // This dedicated session has already used its one Sync attempt. The normal
    // CHECK/fence/idle/child gates remain; neither outcome adds another Sync.
    intent.skipSync = true;
    intent.maintenanceId = row.id;
    if (row.outcome !== 'success') intent.syncExhausted = true;
    await this.store.update(scene.sessionGroup, row.runId, { releaseRequested: true });
  }
}
