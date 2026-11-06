import fs from 'node:fs/promises';
import path from 'node:path';
import { READY_TIMEOUT_MS } from '../../comm-bridge/scripts/c4-config.js';
import { loadCoreModule } from './core-modules.js';
const { assertSessionGroup, sessionGroupRunRoot } = await loadCoreModule('session-group-paths.js');

/** Reconcile persistent running identities; scene snapshots only exclude live groups. */
export class SupervisorRunEndings {
  constructor({ db, readIdentity, env, alert, diagnostic, reportError = () => {}, now = Date.now,
    readFile = fs.readFile, isObservable = () => true }) {
    Object.assign(this, { db, readIdentity, env, alert, diagnostic, reportError, now, readFile, isObservable });
    this.failures = new Map();
    this.globalFailure = null;
    this.shortRuns = new Map();
    this.notices = new Map();
  }

  async currentSession(group) {
    const file = path.join(sessionGroupRunRoot(this.env), assertSessionGroup(group), 'current-session.json');
    let raw;
    try { raw = await this.readFile(file, 'utf8'); }
    catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
    const value = JSON.parse(raw);
    if (typeof value?.runId !== 'string' || !value.runId || !Number.isFinite(value.ts)) {
      throw new Error('Invalid current session identity');
    }
    return value;
  }

  notify(key, event, unthrottled = false) {
    const now = this.now();
    if (!unthrottled && this.notices.has(key) && now - this.notices.get(key) < 1800000) return;
    if (!unthrottled) this.notices.set(key, now);
    try { this.diagnostic?.(event); } catch (error) { this.reportError(error, { phase: 'run-ending-diagnostic' }); }
    if (this.alert) Promise.resolve().then(() => this.alert(event)).catch(error => {
      if (!unthrottled) this.notices.delete(key);
      this.reportError(error, { phase: 'run-ending-alert' });
    });
  }

  reportReadFailure(cause) {
    this.globalFailure ??= { since: this.now() };
    this.reportError(cause, { phase: 'run-ending-reconciliation' });
    if (this.now() - this.globalFailure.since >= 60000) this.notify('failure:*', {
      event: 'run_ending_reconciliation_failed', session_group: '*', reason: cause.code ?? cause.message,
      slot_deleted: false, status: 'retained', message: 'Occupancy rows remain; groups cannot start until reconciliation recovers.',
    });
  }

  failure(group, runId, cause) {
    const old = this.failures.get(group);
    if (!old || old.runId !== runId) this.failures.set(group, { runId, since: this.now(), cause });
    else old.cause = cause;
    this.reportError(cause, { phase: 'run-ending-reconciliation', sessionGroup: group });
  }

  clearFailure(group) { this.failures.delete(group); }
  reset(group) { this.shortRuns.delete(group); }
  scenePresent(context, group) {
    return context.scenes.some(scene => scene.sessionGroup === group && scene.present !== false);
  }

  syncFailures(slots) {
    const running = new Map(slots.filter(row => row.state === 'running').map(row => [row.sessionGroup, row.runId]));
    for (const [group, failure] of this.failures) {
      if (group !== 'origin' && running.get(group) !== failure.runId) this.clearFailure(group);
    }
  }

  async failCandidates(candidates, cause) {
    this.reportError(cause, { phase: 'run-ending-reconciliation' });
    for (const row of candidates) {
      let runId = row.runId;
      if (row.sessionGroup === 'origin') {
        try {
          const current = await this.currentSession('origin');
          if (!current) { this.clearFailure('origin'); continue; }
          runId = current.runId;
        } catch { runId = this.failures.get('origin')?.runId ?? null; }
      }
      this.failure(row.sessionGroup, runId, cause);
    }
  }

  notifyPending(slots) {
    const running = new Map(slots.filter(row => row.state === 'running').map(row => [row.sessionGroup, row.runId]));
    for (const [group, failure] of this.failures) {
      if (this.now() - failure.since < 60000) continue;
      const retained = running.get(group) === failure.runId;
      this.notify(`failure:${group}`, {
        event: 'run_ending_reconciliation_failed', session_group: group, run_id: failure.runId,
        reason: failure.cause?.code ?? failure.cause?.message,
        slot_deleted: false, status: retained ? 'retained' : 'no_slot',
        message: retained ? 'The occupancy row remains; this group cannot start until reconciliation recovers.' : 'Reconciliation is still failing; there is no occupancy row to release.',
      });
    }
  }

  async pruneHeld() {
    try { await this.db.pruneSlots({ orphans: [], minAgeSeconds: READY_TIMEOUT_MS / 1000 }); }
    catch (cause) { this.reportError(cause, { phase: 'slot-cleanup' }); }
  }

  async prune(context, deferred = false) {
    let slots, fences;
    try { slots = await this.db.listSlotOccupancy(); }
    catch (cause) { this.reportReadFailure(cause); return false; }
    this.syncFailures(slots);
    try { fences = await this.db.listDrainFences(); }
    catch (cause) { this.reportReadFailure(cause); await this.pruneHeld(); this.notifyPending(slots); return false; }
    const orphans = [];
    for (const row of slots) {
      const group = row.sessionGroup;
      if (row.state !== 'running') continue;
      if (!this.isObservable(group) || fences.some(fence => fence.sessionGroup === '*' || fence.sessionGroup === group)) continue;
      if (this.scenePresent(context, group)) { if (!deferred) this.clearFailure(group); continue; }
      const failure = this.failures.get(group);
      if (failure && this.now() - failure.since < 60000) continue;
      try {
        const fresh = await this.readIdentity(group);
        if (fresh?.present === false) orphans.push({ sessionGroup: group, runId: row.runId });
        else if (fresh?.present === true && !deferred) this.clearFailure(group);
      } catch { /* Unobservable tmux is not evidence of absence and preserves timing. */ }
    }
    try {
      const result = await this.db.pruneSlots({ orphans, minAgeSeconds: READY_TIMEOUT_MS / 1000 });
      for (const row of result.deletedOrphans) {
        const failure = this.failures.get(row.sessionGroup);
        if (failure?.runId === row.runId && this.now() - failure.since >= 60000) {
          this.notify('', { event: 'run_ending_reconciliation_failed', session_group: row.sessionGroup,
            run_id: row.runId, reason: failure.cause?.code ?? failure.cause?.message,
            slot_deleted: true, status: 'deleted', message: 'The occupancy row was deleted. This run will not resume automatically; a new message is required.' }, true);
        }
        if (failure?.runId === row.runId) this.clearFailure(row.sessionGroup);
      }
      const deleted = new Set(result.deletedOrphans.map(row => JSON.stringify([row.sessionGroup, row.runId])));
      for (const row of orphans) {
        const key = JSON.stringify([row.sessionGroup, row.runId]);
        // A successful conditional delete missed an old failed identity:
        // that row changed during cleanup, so its failure episode is over.
        if (!deleted.has(key) && this.failures.get(row.sessionGroup)?.runId === row.runId) this.clearFailure(row.sessionGroup);
      }
    } catch (cause) { this.reportError(cause, { phase: 'slot-cleanup' }); }
    this.notifyPending(slots);
    return true;
  }

  async advance(context) {
    if (context.configuration.mode !== 'multi') return;
    let slots;
    try { slots = await this.db.listSlotOccupancy(); }
    catch (cause) { this.reportReadFailure(cause); return; }
    this.syncFailures(slots);
    let fences;
    try { fences = await this.db.listDrainFences(); }
    catch (cause) { this.reportReadFailure(cause); await this.pruneHeld(); return; }
    const candidates = [...slots.filter(row => row.state === 'running'), { sessionGroup: 'origin', runId: null }]
      .filter(row => {
        const group = row.sessionGroup;
        if (!this.isObservable(group) || this.scenePresent(context, group)) return false;
        return !fences.some(fence => fence.sessionGroup === group);
      });
    let authorityFailed = false, deferred = false;
    try {
      let transition;
      try { transition = await this.db.getModeTransition(); }
      catch (cause) { authorityFailed = true; await this.failCandidates(candidates, cause); return; }
      if (transition || fences.some(row => row.sessionGroup === '*')) { deferred = true; return; }
      if (this.isObservable('origin') && !fences.some(row => row.sessionGroup === 'origin') && this.scenePresent(context, 'origin')) this.clearFailure('origin');
      if (!candidates.length) return;
      let records, lastDone;
      try {
        records = new Map((await this.db.listRunEndings(candidates.map(row => row.sessionGroup))).map(row => [row.sessionGroup, row]));
        lastDone = await this.db.getLastCompletedModeTransition();
      } catch (cause) { await this.failCandidates(candidates, cause); return; }
      const multiSince = lastDone?.target_mode === 'multi' ? lastDone.updated_at * 1000 : null;
      for (const row of candidates) {
        const group = row.sessionGroup;
        if (records.get(group)?.reason !== 'unexpected') this.reset(group);
        let current;
        try { current = await this.currentSession(group); }
        catch (cause) { this.failure(group, row.runId ?? this.failures.get(group)?.runId ?? null, cause); continue; }
        if (!current || group !== 'origin' && current.runId !== row.runId ||
          multiSince !== null && current.ts < multiSince || records.get(group)?.runId === current.runId) {
          this.clearFailure(group); continue;
        }
        // Origin has no slot identity; once readable, its F3 identifies the failure episode.
        if (group === 'origin') {
          const failure = this.failures.get(group);
          if (failure?.runId === null) failure.runId = current.runId;
          else if (failure && failure.runId !== current.runId) this.clearFailure(group);
        }
        let fresh;
        try { fresh = await this.readIdentity(group); }
        catch { continue; }
        if (fresh?.present === true) { this.clearFailure(group); continue; }
        if (fresh?.present !== false) continue;
        try {
          const result = await this.db.recordRunEnd(group, { runId: current.runId, reason: 'unexpected' });
          this.clearFailure(group);
          if (!result.recorded) continue;
          const duration = Math.floor(this.now() / 1000) * 1000 - current.ts;
          if (duration >= 600000) this.reset(group);
          else {
            const count = (this.shortRuns.get(group) ?? 0) + 1;
            this.shortRuns.set(group, count);
            if (count >= 5) this.notify(`short:${group}`, { event: 'repeated_unexpected_run_end', session_group: group, reason: 'five_short_runs', count });
          }
        } catch (cause) { this.failure(group, current.runId, cause); }
      }
    } finally {
      const readable = await this.prune(context, deferred);
      if (!authorityFailed && !deferred && readable) this.globalFailure = null;
    }
  }
}
