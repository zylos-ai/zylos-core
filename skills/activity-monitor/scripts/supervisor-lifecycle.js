import { isDeepStrictEqual } from 'node:util';
import { validLaunchConfigSnapshot as validLaunchConfig } from './launch-config-shape.js';
import { loadCoreModule } from './core-modules.js';
const { modelThreshold } = await loadCoreModule('model-rotation-thresholds.js');
import { MANUAL_WAKE_PROMPT } from './origin-prompts.js';

const TERMINAL_CONTROLS = new Set(['done', 'timeout', 'superseded', 'failed', 'cancelled']);
const CAPACITY_REASONS = new Set(['ttl', 'evict', 'upgrade', 'auth']);
const RECLAIM_REASONS = new Set([...CAPACITY_REASONS, 'mode_switch', 'model_config', 'delete', 'release']);
const error = (code, message) => Object.assign(new Error(message), { code });
const modeOf = context => context.configuration.mode;
const targetOf = group => group === null ? { machine: true } : { sessionGroup: group };
const finite = value => Number.isFinite(value);
const manualGroup = request => request.mode === 'single' ? '*' : request.sessionGroup ?? 'origin';
const manualTarget = request => request.mode === 'single' ? null : request.sessionGroup ?? 'origin';
// Capacity eviction waits only briefly for its pre-reclaim check; TTL keeps the longer acknowledgment timeout.
export const EVICTION_CHECK_ACK_TIMEOUT_MS = 60000;
// An upgrade restart also waits only briefly for its check, and restarts even when the session stays active.
export const UPGRADE_CHECK_ACK_TIMEOUT_MS = 60000;

export function sceneRotationThreshold(scene, configuration) {
  if (!['claude', 'codex'].includes(scene.runtime)) return null;
  return modelThreshold(configuration.rotationPolicy ?? {}, {
    runtime: scene.runtime, model: scene.model, contextWindow: scene.contextWindow,
    launchConfig: scene.launchConfig,
    defaultModel: configuration.defaultModels?.[scene.runtime], codexModels: configuration.codexModels,
  });
}

// Database timestamps are UTC. Runtime observation timestamps are milliseconds.
export function activityTime(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number' && finite(value)) return value;
  if (typeof value === 'object') return activityTime(value.ts);
  if (typeof value !== 'string') throw error('INVALID_OBSERVATION', 'Invalid activity timestamp');
  const result = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? `${value.replace(' ', 'T')}Z` : value);
  if (!finite(result)) throw error('INVALID_OBSERVATION', 'Invalid activity timestamp');
  return result;
}

export function evictionDemand(slots, pending, fences, capacity) {
  if (!Number.isInteger(capacity) || capacity < 1) throw error('CONFIG_UNREADABLE', 'Pool capacity must be positive');
  const occupied = new Set(slots.map(row => row.sessionGroup));
  const waiting = new Set(pending.map(row => row.sessionGroup).filter(g => g !== 'origin' && g !== null && !occupied.has(g))).size;
  const free = capacity - slots.length;
  const inflight = fences.filter(f => f.sessionGroup !== 'origin' && f.sessionGroup !== '*' && ['ttl', 'evict'].includes(f.reason)).length;
  return { waiting, free, inflight, need: waiting ? Math.max(0, waiting - free - inflight) : 0 };
}

/** Lifecycle methods run inside the same serial section as socket admission.
 * Round checks share context.scenes and the captured authorities. Mutations
 * revalidate their gates and stop uses the adapter's expected-run guard.
 * Sync marker reading and prompt constants are supplied by the memory module.
 */
export class SupervisorLifecycle {
  constructor(deps, { now = Date.now, idleConfirmMs = 3000, rotationCooldownMs = 300000,
    syncCheckMs = 60000, ackTimeoutMs = 300000, evictionAckTimeoutMs = EVICTION_CHECK_ACK_TIMEOUT_MS,
    upgradeAckTimeoutMs = UPGRADE_CHECK_ACK_TIMEOUT_MS } = {}) {
    this.d = deps;
    this.now = now;
    this.idleConfirmMs = idleConfirmMs;
    this.rotationCooldownMs = rotationCooldownMs;
    this.syncCheckMs = Math.min(syncCheckMs, 60000);
    this.ackTimeoutMs = ackTimeoutMs;
    if (!(ackTimeoutMs > 0) || !finite(ackTimeoutMs)) throw new TypeError('A finite acknowledgment timeout is required');
    this.evictionAckTimeoutMs = evictionAckTimeoutMs;
    if (!(evictionAckTimeoutMs > 0) || !finite(evictionAckTimeoutMs)) throw new TypeError('A finite eviction acknowledgment timeout is required');
    this.upgradeAckTimeoutMs = upgradeAckTimeoutMs;
    if (!(upgradeAckTimeoutMs > 0) || !finite(upgradeAckTimeoutMs)) throw new TypeError('A finite upgrade acknowledgment timeout is required');
    this.ttlPreparation = new Map();
    this.evictionPreparation = new Map();
    this.releasePreparation = new Map();
    this.deliveredWork = new Map();
    this.upgradePreparation = new Map();
    this.ttlReset = new Map();
    this.reclaimDeferrals = new Map();
    this.rotationSent = new Map();
    this.configurationSent = new Map();
    this.syncSent = new Map();
    this.syncRuns = new Map();
    this.syncProgress = new Map();
    this.referenceReorgSent = new Map();
    this.backlogSent = new Map();
    this.lastSyncCheck = null;
    this.warnings = new Set();
    this.runEndFailures = new Map();
    this.roundToken = null;
    this.runEndNotices = new Map();
    this.capacityWaitDiagnostics = new Map();
  }

  async event(event, details) {
    try { await this.d.diagnostic?.({ event, ...details }); }
    catch (cause) { this.d.reportError?.(cause, { phase: 'diagnostic' }); }
  }

  async each(items, action) {
    for (const item of items) {
      try { await action(item); }
      catch (cause) {
        if (!this.d.reportError) throw cause;
        await this.d.reportError(cause, { phase: 'lifecycle', sessionGroup: item.sessionGroup, requestId: item.requestId });
      }
    }
  }

  async observe(group, context) {
    const scene = await this.d.observeGroup(group);
    if (scene?.observationError) throw scene.observationError;
    if (!scene || typeof scene.present !== 'boolean') throw error('INVALID_OBSERVATION', 'Runtime presence is unknown');
    const current = { ...scene, sessionGroup: group };
    if (context) {
      const index = context.scenes.findIndex(item => item.sessionGroup === group || group === null && item.sessionGroup === 'origin');
      if (index >= 0) context.scenes[index] = current;
      else context.scenes.push(current);
    }
    return current;
  }

  scene(group, context) {
    const scene = context.scenes.find(item => item.sessionGroup === group || group === null && item.sessionGroup === 'origin');
    if (scene?.observationError) throw scene.observationError;
    if (!scene) return { sessionGroup: group, present: false };
    if (typeof scene.present !== 'boolean') throw error('INVALID_OBSERVATION', 'Runtime presence is unknown');
    return { ...scene, sessionGroup: group };
  }

  allowed(group, context) {
    if (context.restartRequestsError || context.transition || context.fences.some(fence => fence.sessionGroup === '*')) return false;
    if (group !== null && context.fences.some(fence => fence.sessionGroup === group)) return false;
    return !context.restartRequests.some(request => request.reason === 'manual_restart' &&
      (manualTarget(request) === group || request.mode === 'single' && group === 'origin'));
  }

  async refreshAuthorities(context) {
    context.transition = await this.d.db.getModeTransition();
    context.fences = await this.d.db.listDrainFences();
    context.restartRequests = this.d.requests?.read() ?? [];
    delete context.restartRequestsError;
  }

  async beforeWrite(group, context, scene) {
    await this.refreshAuthorities(context);
    if (!this.allowed(group, context)) return false;
    if (!scene) return true;
    const current = await this.observe(group, context);
    return current.present && current.ready && current.runId === scene.runId && current.sessionId === scene.sessionId;
  }

  stopped(scene, context) {
    const current = context.scenes.find(item => item.runId === scene.runId &&
      (item.sessionGroup === scene.sessionGroup || scene.sessionGroup === null && item.sessionGroup === 'origin'));
    if (current) Object.assign(current, { present: false, ready: false, processRunning: false });
  }

  async checkReclaimDependencies(scene, context) {
    if (typeof this.d.readSyncMarker !== 'function') throw error('DEPENDENCY_UNAVAILABLE', 'Sync marker reader is unavailable');
    const kinds = modeOf(context) === 'single' ? ['global'] : scene.sessionGroup === 'origin' ? ['group', 'origin'] : ['group'];
    let unheld = true;
    for (const kind of kinds) {
      const marker = await this.d.readSyncMarker({ runDir: scene.runDir, kind, currentRunId: scene.runId });
      if (!marker || typeof marker.held !== 'boolean' || typeof marker.stale !== 'boolean') throw error('INVALID_OBSERVATION', 'Invalid Sync marker result');
      if (marker.held && !marker.stale) unheld = false;
    }
    return unheld;
  }

  async idle(scene, context) {
    if (!scene.present || !scene.ready || scene.processRunning !== true || scene.state !== 'idle' ||
        !finite(scene.idleSince) || this.now() - scene.idleSince < this.idleConfirmMs) return false;
    return this.checkReclaimDependencies(scene, context);
  }

  async alertOnce(key, event) {
    if (this.warnings.has(key)) return;
    this.warnings.add(key);
    await this.event(event.event, event);
    // Alert delivery never holds the lifecycle queue.
    if (this.d.alert) Promise.resolve().then(() => this.d.alert(event)).catch(cause => {
      this.warnings.delete(key);
      this.d.reportError?.(cause, { phase: 'lifecycle_alert' });
    });
  }

  async reclaimRead(fence, operation, name = 'reclaim_observation_unavailable') {
    try { return await operation(); }
    catch (cause) {
      await this.alertOnce(JSON.stringify(['reclaim', fence.sessionGroup, fence.runId, fence.reason, name]), {
        event: name, session_group: fence.sessionGroup, sessionGroup: fence.sessionGroup,
        run_id: fence.runId, reason: cause.code ?? cause.message,
      });
      throw cause;
    }
  }

  async running(group, { withoutDeadline = false } = {}) {
    const conversations = group === null ? await this.d.db.countGlobalRunningConversations() : await this.d.db.countRunningConversations(group);
    const controls = await this.d.db.countNonTerminalControls(targetOf(group));
    if (!Number.isInteger(conversations) || conversations < 0 || !Number.isInteger(controls.running) || controls.running < 0 ||
        (withoutDeadline && (!Number.isInteger(controls.runningWithoutDeadline) || controls.runningWithoutDeadline < 0))) {
      throw error('INVALID_OBSERVATION', 'Invalid in-flight counts');
    }
    return { conversations, controls: controls.running - (withoutDeadline ? controls.runningWithoutDeadline : 0) };
  }

  async clear(fence, context) {
    const current = await this.d.db.getDrainFence(fence.sessionGroup);
    if (!current) {
      context.fences = context.fences.filter(item => item.sessionGroup !== fence.sessionGroup);
      return;
    }
    if (current.reason !== fence.reason || current.runId !== fence.runId) throw error('FENCE_MISMATCH', 'Reclaim fence changed');
    await this.d.db.clearDrainFence(fence.sessionGroup, { expectedReason: fence.reason, expectedRunId: fence.runId });
    context.fences = context.fences.filter(item => item.sessionGroup !== fence.sessionGroup);
  }

  beginRound() { this.roundToken = {}; }

  async completeRun(fence, context) {
    if (modeOf(context) !== 'multi' || fence.sessionGroup === '*') return this.clear(fence, context);
    const key = JSON.stringify([fence.sessionGroup, fence.runId]);
    const current = await this.d.db.getDrainFence(fence.sessionGroup);
    if (!current) { context.fences = context.fences.filter(item => item.sessionGroup !== fence.sessionGroup); this.runEndFailures.delete(key); return; }
    if (current.reason !== fence.reason || current.runId !== fence.runId) { this.runEndFailures.delete(key); throw error('FENCE_MISMATCH', 'Reclaim fence changed'); }
    if (fence.reason === 'delete') {
      // The deleting caller owns the fence until storage cleanup and audit finish.
      // Failure must remain retryable without reopening the group.
      await this.d.db.recordRunEnd(fence.sessionGroup, { runId: fence.runId, reason: 'delete', clearFence: false });
      return;
    }
    try {
      await this.d.db.recordRunEnd(fence.sessionGroup, { runId: fence.runId, reason: fence.reason,
        clearFence: fence.reason === 'manual_restart' ? { expectedReason: fence.reason, expectedRunId: fence.runId } : true });
      this.runEndFailures.delete(key);
      context.fences = context.fences.filter(item => item.sessionGroup !== fence.sessionGroup);
    } catch (cause) {
      if (cause.code === 'FENCE_MISMATCH') { this.runEndFailures.delete(key); throw cause; }
      const previous = this.runEndFailures.get(key);
      const round = this.roundToken ?? context;
      const count = (previous?.count ?? 0) + (previous?.round === round ? 0 : 1);
      this.runEndFailures.set(key, { count, round });
      if (count < 3) throw cause;
      await this.clear(fence, context);
      this.runEndFailures.delete(key);
      const now = this.now(), last = this.runEndNotices.get(fence.sessionGroup);
      if (last === undefined || now - last >= 1800000) {
        this.runEndNotices.set(fence.sessionGroup, now);
        const event = { event: 'run_ending_record_failed', session_group: fence.sessionGroup,
          run_id: fence.runId, reason: 'automatic_continuation_unavailable' };
        await this.event(event.event, event);
        if (this.d.alert) Promise.resolve().then(() => this.d.alert(event)).catch(error => {
          this.runEndNotices.delete(fence.sessionGroup); this.d.reportError?.(error, { phase: 'lifecycle_alert' });
        });
      }
    }
  }

  async beginReclaim(scene, reason, context, { subreason } = {}) {
    if (reason === 'evict' && (scene.sessionGroup === 'origin' || scene.sessionGroup === null)) return false;
    if (reason === 'ttl' && scene.sessionGroup === null) return false;
    if (!scene.present || !scene.ready || !scene.runId || scene.sessionGroup === null) return false;
    if (this.subagentReclaimBlocked(scene, reason, context)) return false;
    if (!await this.allowed(scene.sessionGroup, context)) return false;
    const fresh = await this.observe(scene.sessionGroup, context);
    if (!fresh.present || !fresh.ready || fresh.runId !== scene.runId) return false;
    if (this.subagentReclaimBlocked(fresh, reason, context)) return false;
    await this.checkReclaimDependencies(fresh, context);
    if (reason === 'evict' && !(await this.evictionCandidates([fresh], context)).length) return false;
    if (!await this.beforeWrite(scene.sessionGroup, context)) return false;
    await this.d.db.setDrainFence(scene.sessionGroup, { reason, runId: scene.runId });
    const saved = await this.d.db.getDrainFence(scene.sessionGroup);
    if (saved) context.fences = [...context.fences.filter(item => item.sessionGroup !== scene.sessionGroup), saved];
    const started = saved?.reason === reason && saved.runId === scene.runId;
    if (started && reason === 'evict') await this.event('reclaim_started', {
      session_group: scene.sessionGroup, run_id: scene.runId, reason,
      subreason: subreason ?? 'capacity_demand',
    });
    return started;
  }

  async advanceReclaim(fence, context, { unfenced = false, singleAuth = false } = {}) {
    if (fence.reason === 'manual_restart' || !RECLAIM_REASONS.has(fence.reason)) return 'ignored';
    const group = unfenced ? null : fence.sessionGroup;
    if (group === '*') return 'ignored';
    const preparedTtl = fence.reason === 'ttl' && this.ttlPreparation.get(group)?.runId === fence.runId;
    if (!unfenced) {
      const current = context.fences.find(item => item.sessionGroup === group);
      if (!current || current.runId !== fence.runId || current.reason !== fence.reason) return 'changed';
    }
    let scene = await this.reclaimRead(fence, () => this.scene(group, context));
    if (fence.reason === 'delete' && scene.present && scene.runId && scene.runId !== fence.runId) return 'changed';
    if (finite(scene.currentSessionTs)) {
      const expired = await this.reclaimRead(fence, () => this.d.db.expireStaleRunningControls(targetOf(group), { deliveredBefore: Math.floor(scene.currentSessionTs / 1000) }));
      for (const row of expired) await this.event('control_expired', { session_group: group, control_id: row.id, run_id: fence.runId });
    }
    const counts = await this.reclaimRead(fence, () => this.running(group, { withoutDeadline: singleAuth }));
    if (counts.conversations > 0 || counts.controls > 0) return 'waiting_inflight';
    if (scene.present && scene.runId === fence.runId) {
      if (typeof scene.processRunning !== 'boolean') return 'unknown_process';
      if (scene.processRunning !== false) {
        if (preparedTtl && this.activeSubagents(scene, context)) return 'waiting_idle';
        const childBlocked = this.subagentReclaimBlocked(scene, fence.reason, context);
        if (childBlocked ||
            !await this.reclaimRead(fence, () => this.idle(scene, context))) {
          if (singleAuth || ['model_config', 'delete'].includes(fence.reason)) return 'waiting_idle';
          if (!unfenced) await this.clear(fence, context);
          if (fence.reason === 'ttl') this.ttlReset.set(group, { runId: fence.runId, at: this.now() });
          await this.event('reclaim_cancelled', { session_group: group, run_id: fence.runId, reason: childBlocked ? 'subagent_activity' : 'not_idle' });
          return 'cancelled';
        }
        const again = await this.reclaimRead(fence, async () => singleAuth ? this.running(group, { withoutDeadline: true }) : fence.reason === 'delete' ? this.running(group) : {
          conversations: group === null ? await this.d.db.countGlobalRunningConversations() : await this.d.db.countRunningConversations(group), controls: 0,
        });
        if (again.conversations !== 0 || again.controls !== 0) {
          if (singleAuth || fence.reason === 'delete') return 'waiting_inflight';
          if (!['model_config', 'delete'].includes(fence.reason) && !unfenced) {
            await this.event('reclaim_cancelled', { session_group: group, run_id: fence.runId, reason: 'inflight_after_idle' });
            await this.clear(fence, context);
            if (fence.reason === 'ttl') this.ttlReset.set(group, { runId: fence.runId, at: this.now() });
          }
          throw error('RECLAIM_INFLIGHT', 'Conversation appeared after drain fence');
        }
      }
      // Re-read immediately before constructing the stop; never retarget a replacement.
      scene = await this.reclaimRead(fence, () => this.observe(group, context));
      if (scene.present && scene.runId === fence.runId) {
        if (typeof scene.processRunning !== 'boolean') return 'unknown_process';
        if (scene.processRunning && this.subagentReclaimBlocked(scene, fence.reason, context)) {
          if (fence.reason === 'delete') return 'waiting_idle';
          if (preparedTtl && this.activeSubagents(scene, context)) return 'waiting_idle';
          await this.clear(fence, context);
          if (fence.reason === 'ttl') this.ttlReset.set(group, { runId: fence.runId, at: this.now() });
          await this.event('reclaim_cancelled', { session_group: group, run_id: fence.runId, reason: 'subagent_activity' });
          return 'cancelled';
        }
        await this.reclaimRead(fence, async () => {
          if (!unfenced) {
            const current = await this.d.db.getDrainFence(group);
            if (!current || current.runId !== fence.runId || current.reason !== fence.reason) throw error('FENCE_MISMATCH', 'Reclaim fence changed');
          }
        });
        await this.reclaimRead(fence, async () => {
          await this.d.stop(scene);
          this.stopped(scene, context);
        }, 'reclaim_stop_unconfirmed');
      }
    } else if (scene.present && !scene.runId) {
      return 'unknown_identity';
    }
    if (fence.reason === 'delete') {
      // Keep the deletion fence unless a fresh observation confirms that the
      // stopped executor is gone. Never publish an ending for a replacement.
      const stopped = await this.reclaimRead(fence, () => this.observe(group, context), 'reclaim_stop_unconfirmed');
      if (stopped.present) {
        if (!stopped.runId) return 'unknown_identity';
        if (stopped.runId !== fence.runId) return 'changed';
        if (stopped.processRunning !== false) throw error('STOP_UNCONFIRMED', 'Runtime process termination is not confirmed');
      }
    }
    await this.d.intentionalStop?.(group, fence.runId);
    if (!unfenced) {
      const current = scene.present && scene.runId !== fence.runId ? await this.d.readCurrentSession?.(group) : null;
      if (current?.runId && current.runId !== fence.runId) {
        if (fence.reason === 'delete') return 'changed';
        await this.clear(fence, context);
      }
      else await this.completeRun(fence, context);
    }
    this.ttlPreparation.delete(group);
    this.evictionPreparation.delete(group);
    this.releasePreparation.delete(group);
    if (this.deliveredWork.get(group)?.runId === fence.runId) this.deliveredWork.delete(group);
    this.upgradePreparation.delete(fence.runId);
    if (this.reclaimDeferrals.get(group)?.runId === fence.runId) this.reclaimDeferrals.delete(group);
    for (const name of ['reclaim_observation_unavailable', 'reclaim_stop_unconfirmed']) {
      this.warnings.delete(JSON.stringify(['reclaim', fence.sessionGroup, fence.runId, fence.reason, name]));
    }
    await this.event('reclaim_done', { session_group: group, run_id: fence.runId, reason: fence.reason });
    return 'done';
  }

  // Session and child activity from sessionActivityBefore through sessionActivityAfter is the
  // preparing session's own work and is ignored; C4 messages always count.
  async lastActivity(scene, sessionActivityBefore = Infinity, sessionActivityAfter = Infinity) {
    if (!finite(scene.createdAt)) throw error('INVALID_OBSERVATION', 'Runtime creation time is unknown');
    const reset = this.ttlReset.get(scene.sessionGroup);
    const counted = value => finite(value) && (value < sessionActivityBefore || value > sessionActivityAfter);
    const sessionActivity = counted(scene.lastActivityAt) ? scene.lastActivityAt : 0;
    const subagentActivity = counted(scene.lastSubagentActivityAt) ? scene.lastSubagentActivityAt : 0;
    return Math.max(activityTime(await this.d.db.getLastActivity(scene.sessionGroup)), scene.createdAt,
      reset?.runId === scene.runId ? reset.at : 0, sessionActivity, subagentActivity);
  }

  activeSubagents(scene, context) {
    const ttl = (context.configuration.hotTtlSeconds ?? 1800) * 1000;
    return scene.activeSubagents?.some(agent => finite(agent.lastActivityAt) && this.now() - agent.lastActivityAt < ttl) ?? false;
  }

  subagentReclaimBlocked(scene, reason, context) {
    if (reason === 'delete') return (scene.activeSubagents?.length ?? 0) > 0;
    if (reason === 'release') return this.activeSubagents(scene, context);
    if (!['ttl', 'evict'].includes(reason)) return false;
    if (this.activeSubagents(scene, context)) return true;
    const last = scene.lastSubagentActivityAt;
    if (!finite(last)) return false;
    const preparation = reason === 'ttl' ? this.ttlPreparation.get(scene.sessionGroup) : null;
    if (preparation?.runId === scene.runId && last >= preparation.at) return false;
    const [from, until] = reason === 'evict' ? this.evictionCheckWindow(scene) : [Infinity, Infinity];
    if (last >= from && last <= until) return false;
    const seconds = reason === 'ttl' ? context.configuration.hotTtlSeconds ?? 1800 : context.configuration.evictMinIdleSeconds ?? 300;
    return this.now() - last < seconds * 1000;
  }

  // The pending eviction check's own run activity, bounded by its acknowledgment deadline.
  evictionCheckWindow(scene) {
    const preparation = this.evictionPreparation.get(scene.sessionGroup);
    return preparation?.runId === scene.runId ? [preparation.at, preparation.deadline] : [Infinity, Infinity];
  }

  prompt(name, ...args) {
    const value = this.d.prompts?.[name];
    const text = typeof value === 'function' ? value(...args) : value;
    if (typeof text !== 'string' || !text) throw error('DEPENDENCY_UNAVAILABLE', `Missing control prompt: ${name}`);
    return text;
  }

  async bindCurrentRun(scene) {
    try { return await this.d.bindTarget(scene); }
    catch (cause) {
      if (cause.code?.startsWith('TARGET_')) return null;
      throw cause;
    }
  }

  // Only the existing conversation-dispatch signal resets consecutive requests.
  // Transcript, tool and control activity must not erase a deferral history.
  messageDelivered({ sessionGroup, runId }) {
    if (this.reclaimDeferrals.get(sessionGroup)?.runId === runId) this.reclaimDeferrals.delete(sessionGroup);
  }

  async deferReclaim(request, context) {
    const reject = reason => ({ ok: false, result: 'rejected', reason });
    const group = request.sessionGroup;
    await this.refreshAuthorities(context);
    if (context.fences.some(fence => fence.sessionGroup === group || fence.sessionGroup === '*')) return reject('reclaim_started');
    const preparation = this.ttlPreparation.get(group) ?? this.evictionPreparation.get(group);
    if (!preparation) return reject('no_preparation');
    const scene = await this.d.observeGroup(group);
    if (preparation.runId !== request.expectedRunId || scene?.runId !== request.expectedRunId) return reject('run_changed');
    const configurationChanged = validLaunchConfig(scene.launchConfig) && !isDeepStrictEqual(scene.launchConfig,
      await this.d.db.resolveSessionLaunchConfig({ sessionGroup: group, sessionMode: 'multi' }));
    if (context.transition || configurationChanged || context.restartRequests.some(row =>
      row.reason === 'upgrade' && row.runIds.includes(scene.runId) || row.reason === 'manual_restart' &&
      (manualTarget(row) === group || row.mode === 'single'))) return reject('restart_pending');
    const eviction = this.evictionPreparation.get(group);
    if (eviction?.runId === scene.runId && this.now() >= eviction.deadline) return reject('preparation_expired');
    const now = this.now();
    this.ttlPreparation.delete(group);
    this.evictionPreparation.delete(group);
    // lastActivity already includes ttlReset for both TTL and eviction ordering.
    this.ttlReset.set(group, { runId: scene.runId, at: now });
    const previous = this.reclaimDeferrals.get(group);
    const history = previous?.runId === scene.runId ? previous : { runId: scene.runId, count: 0, reasons: [], alerted: false };
    history.count++;
    if (!history.alerted) history.reasons.push(request.reason);
    this.reclaimDeferrals.set(group, history);
    await this.event('reclaim_deferred', { session_group: group, run_id: scene.runId, reason: request.reason });
    if (!history.alerted && history.count >= (context.configuration.reclaimDeferAlertCount ?? 4)) {
      history.alerted = true;
      const event = { event: 'reclaim_defer_alert', session_group: group, run_id: scene.runId,
        reasons: [...history.reasons], message: `Consecutive reclaim deferrals for ${group}: ${history.reasons.join('; ')}` };
      await this.event(event.event, event);
      if (this.d.alert) Promise.resolve().then(() => this.d.alert(event)).catch(cause => this.d.reportError?.(cause, { phase: 'lifecycle_alert' }));
    }
    return { ok: true, result: 'accepted' };
  }

  // Voluntary intent belongs only to this supervisor process. Restart drops it;
  // ordinary TTL remains the fallback. Registration never exempts any tool from
  // activity tracking: release waits for a closed turn as well as normal idle().
  async requestRelease(scene, context) {
    if (modeOf(context) !== 'multi') return { ok: false, result: 'rejected', reason: 'not_multi' };
    await this.refreshAuthorities(context);
    if (!this.allowed(scene.sessionGroup, context)) return { ok: false, result: 'rejected', reason: 'other_fence' };
    if (this.releasePreparation.get(scene.sessionGroup)?.runId === scene.runId) return { ok: true, result: 'already_accepted' };
    const cutoff = scene.turnOpen === true || scene.state === 'busy' ? (finite(scene.busySince) ? scene.busySince : finite(scene.createdAt) ? scene.createdAt : 0) : this.now();
    this.releasePreparation.set(scene.sessionGroup, { runId: scene.runId, cutoff, controlIds: [], prepared: false });
    const delivered = this.deliveredWork.get(scene.sessionGroup);
    if (delivered?.runId === scene.runId && delivered.pastedAt >= cutoff) {
      this.releasePreparation.delete(scene.sessionGroup);
      await this.event('reclaim_cancelled', { session_group: scene.sessionGroup, run_id: scene.runId, reason: 'new_work' });
    }
    return { ok: true, result: 'accepted' };
  }

  async workDelivered({ sessionGroup, runId, pastedAt, controlId }) {
    const intent = this.releasePreparation.get(sessionGroup);
    if (intent && intent.runId !== runId) return;
    if (intent?.runId === runId && controlId !== undefined && intent.controlIds.includes(controlId)) return;
    // One timestamp per live group/run also covers work notified before intent
    // registration. The round prunes absent/replaced runs; nothing is persisted.
    const at = Number.isFinite(pastedAt) ? pastedAt : this.now();
    const previous = this.deliveredWork.get(sessionGroup);
    if (!previous || previous.runId !== runId || at > previous.pastedAt) this.deliveredWork.set(sessionGroup, { runId, pastedAt: at });
    if (!intent || intent.runId !== runId || at < intent.cutoff) return;
    // The intent is removed when its fence starts. Work pasted after that point
    // remains queued under the existing fence/dispatcher contract.
    this.releasePreparation.delete(sessionGroup);
    await this.event('reclaim_cancelled', { session_group: sessionGroup, run_id: runId, reason: 'new_work' });
  }

  async prepareRelease(scene, context, intent) {
    const group = scene.sessionGroup;
    const range = await this.d.db.getUnsummarizedRange(group);
    if (!Number.isInteger(range.count) || range.count < 0) throw error('INVALID_OBSERVATION', 'Invalid unsummarized count');
    const todo = range.count > 0 ? ['PRE_RECLAIM_SYNC_PROMPT'] : [];
    if (group === 'origin') {
      const backlog = await this.d.db.getOriginSyncBacklog();
      if (backlog.total > 0 || backlog.groups.some(item => item.pendingCheckpoints > 0)) todo.push('PRE_RECLAIM_ORIGIN_SYNC_PROMPT');
    }
    intent.prepared = false;
    // Sync must be delivered before the fence, which blocks pending controls.
    for (const prompt of todo) {
      if (!await this.beforeWrite(group, context, scene)) return;
      const targetBinding = await this.bindCurrentRun(scene);
      if (!targetBinding) return;
      const control = await this.d.db.insertControl(this.prompt(prompt), {
        sessionGroup: group, targetBinding, requireIdle: true, appendAckSuffix: true,
        ackDeadlineAt: Math.floor((this.now() + this.ackTimeoutMs) / 1000),
      });
      intent.controlIds.push(control.id);
    }
    intent.prepared = true;
  }

  async advanceReleases(context) {
    for (const [group, delivered] of this.deliveredWork) {
      const scene = this.scene(group, context);
      if (!scene.present || scene.runId !== delivered.runId) this.deliveredWork.delete(group);
    }
    await this.each([...this.releasePreparation.keys()].map(sessionGroup => ({ sessionGroup })), async ({ sessionGroup }) => {
      const intent = this.releasePreparation.get(sessionGroup), scene = this.scene(sessionGroup, context);
      if (!scene.present || !scene.ready || scene.runId !== intent.runId || modeOf(context) !== 'multi' || !this.allowed(sessionGroup, context)) {
        this.releasePreparation.delete(sessionGroup);
        await this.event('reclaim_cancelled', { session_group: sessionGroup, run_id: intent.runId,
          reason: scene.runId !== intent.runId ? 'run_changed' : 'other_fence' });
        return;
      }
      for (const id of intent.controlIds) {
        const control = await this.d.db.getControlById(id);
        if (!control || !TERMINAL_CONTROLS.has(control.status)) return;
      }
      // An acknowledged Sync can still be finishing its turn or holding its
      // scoped marker; children and activity must drain through normal guards.
      if (scene.turnOpen === true || this.subagentReclaimBlocked(scene, 'release', context) || !await this.idle(scene, context)) return;
      if (!intent.prepared) await this.prepareRelease(scene, context, intent);
      if (!intent.prepared || intent.controlIds.length) {
        for (const id of intent.controlIds) {
          const control = await this.d.db.getControlById(id);
          if (!control || !TERMINAL_CONTROLS.has(control.status)) return;
        }
        if (!intent.prepared) return;
      }
      if (await this.beginReclaim(scene, 'release', context)) this.releasePreparation.delete(sessionGroup);
    });
  }

  async checkTtl(scene, context) {
    if (scene.observationError) throw scene.observationError;
    const group = scene.sessionGroup;
    if (this.releasePreparation.has(group) && scene.turnOpen !== true) return;
    if (modeOf(context) !== 'multi' || !group || !await this.allowed(group, context)) return;
    if (!scene.present || !scene.ready) { this.ttlPreparation.delete(group); return; }
    const preparation = this.ttlPreparation.get(group);
    // Preparation starts only after TTL expiry. Its own Sync activity must not
    // restart that clock; C4 messages and the other activity sources still can.
    const now = this.now(), last = await this.lastActivity(scene,
      preparation?.runId === scene.runId ? preparation.at : Infinity);
    const ttl = (context.configuration.hotTtlSeconds ?? 1800) * 1000;
    if (preparation && (preparation.runId !== scene.runId || last > preparation.at)) {
      this.ttlPreparation.delete(group);
      return;
    }
    if (now - last < ttl) return;
    if (preparation) {
      for (const id of preparation.controlIds) {
        const control = await this.d.db.getControlById(id);
        if (!control || !TERMINAL_CONTROLS.has(control.status)) return;
      }
      if (!preparation.partial && (this.activeSubagents(scene, context) || !await this.idle(scene, context))) return;
      if (preparation.partial) { this.ttlPreparation.delete(group); return; }
      // Keep the preparation cutoff through the fence's final activity recheck.
      await this.beginReclaim(scene, 'ttl', context);
      return;
    }
    if (this.activeSubagents(scene, context)) return;
    const range = await this.d.db.getUnsummarizedRange(group);
    if (!Number.isInteger(range.count) || range.count < 0) throw error('INVALID_OBSERVATION', 'Invalid unsummarized count');
    // Every TTL reclaim first asks for a check of work waiting on external events; Sync, when due, follows it.
    const todo = ['PRE_RECLAIM_CHECK_PROMPT'];
    if (range.count > 0) todo.push('PRE_RECLAIM_SYNC_PROMPT');
    if (group === 'origin') {
      const backlog = await this.d.db.getOriginSyncBacklog();
      if (backlog.total > 0 || backlog.groups.some(item => item.pendingCheckpoints > 0)) todo.push('PRE_RECLAIM_ORIGIN_SYNC_PROMPT');
    }
    const controlIds = [];
    let partial = false;
    for (const prompt of todo) {
      if (!await this.beforeWrite(group, context, scene)) { partial = controlIds.length > 0; break; }
      const targetBinding = await this.bindCurrentRun(scene);
      if (!targetBinding) { partial = controlIds.length > 0; break; }
      const control = await this.d.db.insertControl(this.prompt(prompt), {
        sessionGroup: group, targetBinding, requireIdle: true, appendAckSuffix: true, ackDeadlineAt: Math.floor((now + this.ackTimeoutMs) / 1000),
      });
      controlIds.push(control.id);
    }
    if (controlIds.length) this.ttlPreparation.set(group, { controlIds, runId: scene.runId, at: now, partial });
  }

  async checkEviction(scenes, context) {
    // The entry already reports a missing pool configuration reader; defer only eviction.
    if (context.configuration.capacityUnavailable === true) return;
    if (modeOf(context) !== 'multi' || context.transition || context.fences.some(fence => fence.sessionGroup === '*')) return;
    const failure = scenes.find(scene => scene.observationError);
    if (failure) throw failure.observationError;
    const fences = context.fences;
    const slots = await this.d.db.listSlotOccupancy(), pending = await this.d.db.listPendingSessionGroups();
    const demand = evictionDemand(slots, pending, fences, context.configuration.capacity);
    if (!demand.need) { this.capacityWaitDiagnostics.clear(); return demand; }
    const candidates = await this.evictionCandidates(scenes, context);
    const occupied = new Set(slots.map(row => row.sessionGroup));
    const waiting = new Set(pending.map(row => row.sessionGroup)
      .filter(group => group && group !== 'origin' && !occupied.has(group)));
    const snapshot = JSON.stringify([slots.length, context.configuration.capacity, candidates.length]);
    const previous = this.capacityWaitDiagnostics;
    this.capacityWaitDiagnostics = new Map([...waiting].map(group => [group, snapshot]));
    for (const group of waiting) if (previous.get(group) !== snapshot) {
      await this.event('capacity_eviction_checked', { session_group: group,
        occupied_slots: slots.length, pool_limit: context.configuration.capacity,
        candidate_count: candidates.length, no_evictable_candidate: candidates.length === 0 });
    }
    let selected = 0, preparing = 0;
    const count = outcome => { if (outcome === 'started') selected++; else if (outcome === 'waiting') preparing++; };
    // A group already asked to check counts toward demand while it answers, so no other group is asked meanwhile.
    for (const [group, preparation] of [...this.evictionPreparation]) {
      if (selected + preparing >= demand.need) break;
      const scene = scenes.find(item => item.sessionGroup === group);
      if (!scene || scene.runId !== preparation.runId) { this.evictionPreparation.delete(group); continue; }
      count(await this.prepareEviction(scene, context, preparation.subreason));
    }
    for (const scene of candidates) {
      if (selected + preparing >= demand.need) break;
      if (this.evictionPreparation.has(scene.sessionGroup)) continue;
      count(await this.prepareEviction(scene, context, 'capacity_demand'));
    }
    return { ...demand, selected, preparing };
  }

  // Before an eviction the selected group gets one bound check control and a short wait. A terminal
  // check, or its deadline passing, lets the eviction proceed; new activity in the group abandons it.
  async prepareEviction(scene, context, subreason) {
    const group = scene.sessionGroup;
    // A started reclaim keeps its preparation until it completes; it is not prepared or begun again.
    if (context.fences.some(fence => fence.sessionGroup === group)) return null;
    const preparation = this.evictionPreparation.get(group);
    if (preparation && preparation.runId !== scene.runId) this.evictionPreparation.delete(group);
    else if (preparation) {
      if (await this.lastActivity(scene, preparation.at, preparation.deadline) > preparation.at) {
        this.evictionPreparation.delete(group);
        return null;
      }
      const control = await this.d.db.getControlById(preparation.controlId);
      const expired = this.now() >= preparation.deadline;
      if (!TERMINAL_CONTROLS.has(control?.status) && !expired) return 'waiting';
      // An answered check may still be finishing its turn; that wait also ends at the deadline.
      if (!expired && (this.activeSubagents(scene, context) || !await this.idle(scene, context))) return 'waiting';
      const started = await this.beginReclaim(scene, 'evict', context, { subreason: preparation.subreason });
      if (!started) this.evictionPreparation.delete(group);
      return started ? 'started' : null;
    }
    if (group === 'origin' || group === null || !scene.present || !scene.ready || !scene.runId) return null;
    if (!await this.allowed(group, context)) return null;
    const fresh = await this.observe(group, context);
    if (!fresh.present || !fresh.ready || fresh.runId !== scene.runId) return null;
    if (this.subagentReclaimBlocked(fresh, 'evict', context)) return null;
    if (!(await this.evictionCandidates([fresh], context)).length) return null;
    if (!await this.beforeWrite(group, context, scene)) return null;
    const targetBinding = await this.bindCurrentRun(scene);
    if (!targetBinding) return null;
    const now = this.now();
    const control = await this.d.db.insertControl(this.prompt('PRE_RECLAIM_CHECK_PROMPT'), {
      sessionGroup: group, targetBinding, requireIdle: true, appendAckSuffix: true,
      ackDeadlineAt: Math.floor((now + this.evictionAckTimeoutMs) / 1000),
    });
    this.evictionPreparation.set(group, { controlId: control.id, runId: scene.runId, at: now, deadline: now + this.evictionAckTimeoutMs, subreason });
    return 'waiting';
  }

  async evictionCandidates(scenes, context) {
    const candidates = [], now = this.now(), minIdle = (context.configuration.evictMinIdleSeconds ?? 300) * 1000;
    for (const scene of scenes) {
      if (scene.observationError) throw scene.observationError;
      if (!scene.present || !scene.ready || !scene.sessionGroup || scene.sessionGroup === 'origin' || scene.state !== 'idle' || context.fences.some(f => f.sessionGroup === scene.sessionGroup)) continue;
      if (this.activeSubagents(scene, context)) continue;
      const last = await this.lastActivity(scene, ...this.evictionCheckWindow(scene));
      if (now - last < minIdle) continue;
      candidates.push({ ...scene, last });
    }
    return candidates.sort((a, b) => a.last - b.last || a.sessionGroup.localeCompare(b.sessionGroup));
  }

  async checkCapacityPressure(context) {
    if (context.fences.some(fence => fence.sessionGroup !== 'origin' && CAPACITY_REASONS.has(fence.reason))) return null;
    for (const [group, preparation] of [...this.evictionPreparation]) {
      const scene = context.scenes.find(item => item.sessionGroup === group);
      if (!scene || scene.runId !== preparation.runId) { this.evictionPreparation.delete(group); continue; }
      const outcome = await this.prepareEviction(scene, context, preparation.subreason);
      if (outcome) return outcome === 'started' ? scene : null;
    }
    const [candidate] = await this.evictionCandidates(context.scenes, context);
    if (!candidate) return null;
    return await this.prepareEviction(candidate, context, 'memory_pressure') === 'started' ? candidate : null;
  }

  async checkRotation(scene, context) {
    if (scene.observationError) throw scene.observationError;
    if (!await this.allowed(scene.sessionGroup, context)) return;
    if (!scene.present || !scene.ready) return;
    const threshold = sceneRotationThreshold(scene, context.configuration);
    if (!finite(scene.usagePercent) || threshold === null || scene.usagePercent < threshold) return;
    const key = JSON.stringify([scene.runId, scene.sessionId]), now = this.now();
    if (this.rotationSent.has(key) && now - this.rotationSent.get(key) < this.rotationCooldownMs) return;
    if (!await this.beforeWrite(scene.sessionGroup, context, scene)) return;
    const targetBinding = await this.bindCurrentRun(scene);
    if (!targetBinding) return;
    await this.d.db.insertControl(this.prompt('ROTATION_PROMPT', scene), { targetBinding, sessionGroup: modeOf(context) === 'single' ? null : scene.sessionGroup, bypassState: true, appendAckSuffix: false });
    this.rotationSent.set(key, now);
  }

  async reconcileConfiguration(context) {
    if (modeOf(context) !== 'multi') return;
    await this.each(context.scenes, async scene => {
      if (scene.observationError) throw scene.observationError;
      if (!this.allowed(scene.sessionGroup, context)) return;
      if (!scene.present || !scene.ready) return;
      const actual = scene.launchConfig;
      if (!validLaunchConfig(actual)) {
        await this.event('config_snapshot_unavailable', { session_group: scene.sessionGroup, run_id: scene.runId });
        return;
      }
      const expected = await this.d.db.resolveSessionLaunchConfig({ sessionGroup: scene.sessionGroup, sessionMode: 'multi' });
      if (!validLaunchConfig(expected)) throw error('INVALID_OBSERVATION', 'Invalid expected launch configuration');
      if (isDeepStrictEqual(actual, expected)) return;
      const now = this.now();
      if (this.configurationSent.has(scene.runId) && now - this.configurationSent.get(scene.runId) < this.rotationCooldownMs) return;
      if (!await this.beforeWrite(scene.sessionGroup, context)) return;
      const targetBinding = await this.d.bindTarget(scene);
      await this.d.db.insertControl(this.prompt('CONFIG_RECLAIM_PROMPT', scene, expected), { sessionGroup: scene.sessionGroup, targetBinding,
        priority: 1, bypassState: true, appendAckSuffix: true, ackDeadlineAt: Math.floor((now + this.ackTimeoutMs) / 1000) });
      this.configurationSent.set(scene.runId, now);
    });
  }

  async checkSync(scenes, context) {
    const now = this.now();
    if (this.lastSyncCheck !== null && now - this.lastSyncCheck < this.syncCheckMs) return;
    if (context.restartRequestsError || context.transition || context.fences.some(fence => fence.sessionGroup === '*')) return;
    this.lastSyncCheck = now;
    const single = modeOf(context) === 'single';
    let endings = new Map(), multiSince = null;
    const groups = scenes.filter(scene => !scene.observationError && scene.present && scene.ready &&
      this.allowed(scene.sessionGroup, context)).map(scene => scene.sessionGroup);
    if (!single && groups.length) {
      try {
        const [records, transition] = await Promise.all([
          this.d.db.listRunEndings(groups), this.d.db.getLastCompletedModeTransition(),
        ]);
        endings = new Map(records.map(row => [row.sessionGroup, row.endedAt * 1000]));
        if (transition?.target_mode === 'multi') multiSince = transition.updated_at * 1000;
      } catch (cause) {
        this.d.reportError?.(cause, { phase: 'sync-backlog-boundary' });
      }
    }
    await this.each(scenes, async scene => {
      if (scene.observationError) throw scene.observationError;
      if (!await this.allowed(scene.sessionGroup, context)) return;
      if (!scene.present || !scene.ready) return;
      const kind = single ? 'global' : 'group';
      const range = single ? await this.d.db.getGlobalUnsummarizedRange() : await this.d.db.getUnsummarizedRange(scene.sessionGroup);
      const boundaries = single ? [scene.createdAt] : [endings.get(scene.sessionGroup), multiSince];
      const known = boundaries.filter(finite);
      const inherited = range.firstAt !== null && range.firstAt !== undefined && known.length > 0 &&
        activityTime(range.firstAt) <= Math.max(...known);
      await this.syncScope(scene, kind, { count: range.count, firstAt: range.firstAt,
        firstConversationId: range.firstConversationId, nonempty: range.count > 0, inherited }, context);
    });
    if (modeOf(context) === 'multi' && this.allowed('origin', context)) {
      const origin = scenes.find(scene => scene.sessionGroup === 'origin' && scene.present && scene.ready);
      const originScene = { sessionGroup: 'origin', runDir: this.d.groupRunDir('origin'),
        runId: origin?.runId ?? null, sessionId: origin?.sessionId ?? null };
      const backlog = await this.d.db.getOriginSyncBacklog();
      const times = backlog.groups.flatMap(g => [g.firstAt, g.firstCheckpointAt]).filter(v => v !== null && v !== undefined).map(activityTime);
      const rawTimes = backlog.groups.map(g => g.firstAt).filter(v => v !== null && v !== undefined).map(activityTime);
      await this.syncScope(originScene, 'origin', {
        count: backlog.total, firstAt: times.length ? Math.min(...times) : null,
        alertFirstAt: rawTimes.length ? Math.min(...rawTimes) : null,
        nonempty: backlog.total > 0 || backlog.groups.some(g => g.pendingCheckpoints > 0),
      }, context);
    }
  }

  async checkReferenceReorg(scene, kind, context) {
    if (kind !== 'origin' && kind !== 'global') return;
    const key = JSON.stringify([kind, scene.sessionGroup]);
    const identity = JSON.stringify([scene.runId ?? null, scene.sessionId ?? null]);
    const previous = this.referenceReorgSent.get(key);
    if (previous === identity) return;
    // Missing observations cannot reset a known session's successful send.
    if (previous !== undefined && !scene.runId) return;
    // An unbound proposal already queued for absent Origin belongs to its first run.
    if (previous === '[null,null]') {
      this.referenceReorgSent.set(key, identity);
      return;
    }
    try {
      if (!await this.beforeWrite(kind === 'global' ? null : 'origin', context, kind === 'global' ? scene : undefined)) return;
      const proposal = this.prompt('REFERENCE_REORG_PROMPT');
      if (typeof this.d.prepareReferenceReorg !== 'function') throw error('DEPENDENCY_UNAVAILABLE', 'Reference reorganization check is unavailable');
      if (!await this.d.prepareReferenceReorg()) return;
      await this.d.db.insertControl(proposal, {
        sessionGroup: kind === 'global' ? null : 'origin', priority: 3, appendAckSuffix: false,
      });
      // Keep only the latest identity per scope; a Supervisor restart may retry.
      this.referenceReorgSent.set(key, identity);
    } catch (cause) {
      this.d.reportError?.(cause, { phase: 'reference-reorganization' });
    }
  }

  async syncScope(scene, kind, range, context) {
    if (!Number.isInteger(range.count) || range.count < 0) throw error('INVALID_OBSERVATION', 'Invalid Sync backlog');
    // Reference cleanup must not depend on backlog surviving pre-reclaim Sync.
    await this.checkReferenceReorg(scene, kind, context);
    const now = this.now(), config = context.configuration;
    const key = JSON.stringify([kind, scene.sessionGroup]);
    const min = (config.syncMinIntervalSeconds ?? 600) * 1000, max = (config.syncMaxIntervalSeconds ?? 21600) * 1000;
    const threshold = kind === 'origin' ? (config.originSyncThreshold ?? 50) : (config.syncThreshold ?? 15);
    const lag = range.firstAt === null || range.firstAt === undefined ? 0 : Math.max(0, now - activityTime(range.firstAt));
    const alertLag = kind === 'origin' ? (range.alertFirstAt === null || range.alertFirstAt === undefined ? 0 : Math.max(0, now - activityTime(range.alertFirstAt))) : lag;
    const alert = kind !== 'origin' && range.count > 4 * (config.syncBatchLimit ?? 200) || alertLag > 2 * max;
    if (alert && (!this.backlogSent.has(key) || now - this.backlogSent.get(key) >= 21600000) &&
        await this.beforeWrite(modeOf(context) === 'single' ? null : 'origin', context)) {
      await this.d.db.insertControl(this.prompt('SYNC_BACKLOG_ALERT', kind === 'group' ? scene.sessionGroup : kind, range.count, Math.floor(alertLag / 1000)), {
        sessionGroup: modeOf(context) === 'single' ? null : 'origin', appendAckSuffix: false,
      });
      this.backlogSent.set(key, now);
    }
    const previous = this.syncProgress.get(key);
    const catchingUp = kind !== 'origin' && !this.ttlPreparation.has(scene.sessionGroup) &&
      previous?.n0 > (config.syncBatchLimit ?? 200) && previous.runId === scene.runId &&
      range.firstConversationId > previous.f0;
    if (!range.nonempty || (!catchingUp && this.syncSent.has(key) && now - this.syncSent.get(key) < min)) return;
    const rotationThreshold = sceneRotationThreshold(scene, config);
    const due = range.count > threshold || lag >= max || kind !== 'origin' &&
      (this.syncRuns.get(key) !== scene.runId && range.inherited === true || rotationThreshold !== null && finite(scene.usagePercent) && scene.usagePercent >= 0.8 * rotationThreshold);
    if (!catchingUp && !due) return;
    if (typeof this.d.readSyncMarker !== 'function') throw error('DEPENDENCY_UNAVAILABLE', 'Sync marker reader is unavailable');
    const marker = await this.d.readSyncMarker({ runDir: scene.runDir, kind, currentRunId: scene.runId });
    if (!marker || typeof marker.held !== 'boolean' || typeof marker.stale !== 'boolean') throw error('INVALID_OBSERVATION', 'Invalid Sync marker result');
    if (marker.held && !marker.stale) return;
    if (!await this.beforeWrite(modeOf(context) === 'single' ? null : scene.sessionGroup, context, kind === 'origin' ? undefined : scene)) return;
    await this.d.db.insertControl(this.prompt(kind === 'origin' ? 'ORIGIN_SYNC_PROMPT' : 'GROUP_SYNC_PROMPT'), {
      sessionGroup: modeOf(context) === 'single' ? null : scene.sessionGroup, priority: 2, appendAckSuffix: false,
      ...(kind === 'origin' ? {} : { ackDeadlineAt: Math.floor((now + this.ackTimeoutMs) / 1000) }),
    });
    this.syncSent.set(key, now);
    this.syncRuns.set(key, scene.runId);
    if (kind !== 'origin') this.syncProgress.set(key, { n0: range.count, f0: range.firstConversationId, runId: scene.runId });
  }

  async advanceRestarts(context) {
    if (context.restartRequestsError || context.transition) return;
    await this.each(context.restartRequests.filter(r => r.reason === 'upgrade'), async request => {
      const scenes = context.scenes;
      const failure = scenes.find(scene => scene.observationError);
      if (failure) throw failure.observationError;
      if (!Array.isArray(scenes) || scenes.some(s => typeof s.present !== 'boolean' || s.present && !s.runId)) {
        throw error('INVALID_OBSERVATION', 'Restart inventory contains an unknown runtime identity');
      }
      const remaining = scenes.filter(s => s.present && request.runIds.includes(s.runId));
      if (!remaining.length) {
        await this.refreshAuthorities(context);
        if (context.transition) return;
        this.d.requests.remove(request.requestId);
        for (const runId of request.runIds) this.upgradePreparation.delete(runId);
        context.restartRequests = context.restartRequests.filter(item => item.requestId !== request.requestId);
        await this.event('restart_done', { requestId: request.requestId });
        return;
      }
      for (const scene of remaining) {
        if (scene.ready && await this.prepareUpgrade(scene, context)) await this.beginReclaim(scene, 'upgrade', context);
      }
    });
  }

  // Each run due for an upgrade restart gets one bound check control. The restart proceeds once that check is
  // terminal or its short deadline passes; new activity does not cancel it, because the upgrade must restart.
  async prepareUpgrade(scene, context) {
    const preparation = this.upgradePreparation.get(scene.runId);
    if (preparation) {
      if (this.now() >= preparation.deadline) return true;
      return TERMINAL_CONTROLS.has((await this.d.db.getControlById(preparation.controlId))?.status);
    }
    // A started restart continues as before; other fences and manual work keep their existing precedence.
    if (context.fences.some(fence => fence.sessionGroup === scene.sessionGroup)) return true;
    if (!await this.beforeWrite(scene.sessionGroup, context, scene)) return false;
    // Missing reclaim dependencies stop the upgrade before anything is sent, as they would stop its fence.
    await this.checkReclaimDependencies(scene, context);
    const targetBinding = await this.bindCurrentRun(scene);
    // Without a bindable current run there is nobody to ask; the restart's own guards decide.
    if (!targetBinding) return true;
    const now = this.now();
    const control = await this.d.db.insertControl(this.prompt('UPGRADE_RESTART_CHECK_PROMPT'), {
      sessionGroup: scene.sessionGroup, targetBinding, requireIdle: true, appendAckSuffix: true,
      ackDeadlineAt: Math.floor((now + this.upgradeAckTimeoutMs) / 1000),
    });
    this.upgradePreparation.set(scene.runId, { controlId: control.id, at: now, deadline: now + this.upgradeAckTimeoutMs });
    return false;
  }

  manualBlocked(request, context) {
    const group = manualGroup(request);
    const fence = context.fences.find(item => item.sessionGroup === group);
    return context.restartRequestsError || modeOf(context) !== request.mode || context.transition ||
      request.mode === 'multi' && context.fences.some(item => item.sessionGroup === '*') ||
      fence && (fence.reason !== 'manual_restart' || fence.runId !== request.expectedRunId);
  }

  async checkManualFences(context) {
    if (context.restartRequestsError) return [];
    const requests = context.restartRequests.filter(request => request.reason === 'manual_restart');
    const activeWarnings = new Set(), allowed = [];
    for (const fence of context.fences.filter(item => item.reason === 'manual_restart')) {
      if (!requests.some(request => manualGroup(request) === fence.sessionGroup && request.expectedRunId === fence.runId)) {
        const key = JSON.stringify(['manual', 'orphan', fence.sessionGroup, fence.runId]);
        activeWarnings.add(key);
        await this.alertOnce(key, { event: 'manual_restart_orphan_fence', session_group: fence.sessionGroup, run_id: fence.runId, reason: 'intent_missing' });
      }
    }
    for (const request of requests) {
      if (this.manualBlocked(request, context)) {
        const key = JSON.stringify(['manual', 'blocked', request.requestId]);
        activeWarnings.add(key);
        await this.alertOnce(key, { event: 'manual_restart_blocked', requestId: request.requestId, reason: 'mode_or_fence_conflict' });
      } else allowed.push(request);
    }
    for (const key of this.warnings) {
      const [kind, phase, requestId] = JSON.parse(key);
      if (kind !== 'manual') continue;
      const executing = phase === 'execution' && requests.some(request => request.requestId === requestId);
      if (!activeWarnings.has(key) && !executing) this.warnings.delete(key);
    }
    return allowed;
  }

  async advanceManual(context) {
    const requests = context.manualRequests ?? await this.checkManualFences(context);
    await this.each(requests, async request => {
      try {
        const group = manualGroup(request);
        const targetGroup = manualTarget(request);
        await this.refreshAuthorities(context);
        if (this.manualBlocked(request, context)) return;
        let target = await this.observe(targetGroup, context);
        let fence = context.fences.find(item => item.sessionGroup === group);
        let oldTargetGone = !target.present || target.runId !== request.expectedRunId;
        if (target.present && !target.runId) throw error('INVALID_OBSERVATION', 'Manual target run identity is unknown');
        // A replacement at the target name already proves the requested run gone.
        if (target.present && target.runId === request.expectedRunId) {
          if (!fence) {
            await this.d.db.setDrainFence(group, { reason: 'manual_restart', runId: request.expectedRunId });
            fence = await this.d.db.getDrainFence(group);
            if (fence?.reason !== 'manual_restart' || fence.runId !== request.expectedRunId) throw error('FENCE_MISMATCH', 'Manual fence was not acquired');
            context.fences = [...context.fences.filter(item => item.sessionGroup !== group), fence];
          }
          target = await this.observe(targetGroup, context);
          if (target.present && !target.runId) throw error('INVALID_OBSERVATION', 'Manual target run identity is unknown');
          if (target.present && target.runId === request.expectedRunId) {
            try { await this.d.stop(target); }
            catch (cause) { if (cause.code !== 'RUNID_MISMATCH') throw cause; }
            this.stopped(target, context);
            oldTargetGone = true;
          } else {
            oldTargetGone = true;
          }
        }
        if (oldTargetGone) await this.d.intentionalStop?.(targetGroup, request.expectedRunId);
        const count = request.mode === 'single' ? await this.d.db.countGlobalRunningConversations() : await this.d.db.countRunningConversations(targetGroup);
        if (count !== 0) return;
        await this.refreshAuthorities(context);
        if (this.manualBlocked(request, context)) return;
        if (request.mode === 'multi' && targetGroup === 'origin') await this.d.db.insertControl(MANUAL_WAKE_PROMPT, {
          sessionGroup: 'origin', priority: 2, appendAckSuffix: false,
        });
        fence = context.fences.find(item => item.sessionGroup === group);
        if (fence) await this.completeRun(fence, context);
        this.d.requests.remove(request.requestId);
        context.restartRequests = context.restartRequests.filter(item => item.requestId !== request.requestId);
        await this.event('manual_restart_done', { requestId: request.requestId, run_id: request.expectedRunId, session_group: group });
      } catch (cause) {
        await this.alertOnce(JSON.stringify(['manual', 'execution', request.requestId]), {
          event: 'manual_restart_blocked', requestId: request.requestId,
          run_id: request.expectedRunId, reason: cause.code || 'EXECUTION_FAILED',
        });
        throw cause;
      }
    });
  }
}
