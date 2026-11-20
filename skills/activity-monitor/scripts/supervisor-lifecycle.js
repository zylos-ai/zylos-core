import { SyncAlertEpisodes } from './sync-alert-episodes.js';
import { isDeepStrictEqual } from 'node:util';
import { validLaunchConfigSnapshot as validLaunchConfig } from './launch-config-shape.js';
import { loadCoreModule } from './core-modules.js';
const { modelThreshold } = await loadCoreModule('model-rotation-thresholds.js');
import { MANUAL_WAKE_PROMPT } from './origin-prompts.js';
import { captureSyncTarget, observeSyncCompletion, latestSyncFailure } from './sync-reclaim.js';
import { CHECKPOINT_THRESHOLD } from '../../comm-bridge/scripts/c4-config.js';

const SYNC_DIAGNOSTIC_TYPES = new Set(['origin_frequency', 'origin_idle', 'control_timeout', 'state_uncommitted']);
const TERMINAL_CONTROLS = new Set(['done', 'timeout', 'superseded', 'failed', 'cancelled']);
const CAPACITY_REASONS = new Set(['ttl', 'evict', 'upgrade', 'auth']);
const RECLAIM_REASONS = new Set([...CAPACITY_REASONS, 'mode_switch', 'model_config', 'delete', 'release']);
const error = (code, message) => Object.assign(new Error(message), { code });
const modeOf = context => context.configuration.mode;
const finite = value => Number.isFinite(value);
const groupSyncThreshold = configuration => configuration.syncThreshold ?? CHECKPOINT_THRESHOLD;
const legacy = context => context.configuration.legacy === true;
const oldUnique = (scene, context) => !legacy(context) && scene.sessionGroup === 'origin' && scene.sourceScope === null;
const manualTarget = request => request.sessionGroup ?? 'origin';
// Pre-reclaim Sync covers long-running workers; ordinary check deadlines stay separate.
export const PRE_RECLAIM_SYNC_ACK_TIMEOUT_MS = 900000;
// Capacity eviction waits only briefly for its pre-reclaim check.
export const EVICTION_CHECK_ACK_TIMEOUT_MS = 60000;
// An upgrade restart also waits only briefly for its check, and restarts even when the session stays active.
export const UPGRADE_CHECK_ACK_TIMEOUT_MS = 60000;

export function sceneRotationThreshold(scene, configuration) {
  if (!['claude', 'codex', 'agy'].includes(scene.runtime)) return null;
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
    this.reclaimSyncFailures = new Map();
    this.deliveredWork = new Map();
    this.upgradePreparation = new Map();
    this.ttlReset = new Map();
    this.reclaimDeferrals = new Map();
    this.rotationSent = new Map();
    this.configurationSent = new Map();
    this.syncSent = new Map();
    this.syncProgress = new Map();
    this.referenceReorgSent = new Map();
    this.syncBacklogCandidates = new Map();
    this.syncAlertEpisodes = deps.syncAlertEpisodes ?? new SyncAlertEpisodes({ env: deps.env, now,
      diagnostic: row => deps.diagnostic?.(row) });
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
      const index = context.scenes.findIndex(item => item.sessionGroup === group);
      if (index >= 0) context.scenes[index] = current;
      else context.scenes.push(current);
    }
    return current;
  }

  scene(group, context) {
    const scene = context.scenes.find(item => item.sessionGroup === group);
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
    this.reclaimSyncFailures.delete(scene.sessionGroup);
    const current = context.scenes.find(item => item.runId === scene.runId && item.sessionGroup === scene.sessionGroup);
    if (current) Object.assign(current, { present: false, ready: false, processRunning: false });
  }

  async checkReclaimDependencies(scene, context) {
    if (typeof this.d.readSyncMarker !== 'function') throw error('DEPENDENCY_UNAVAILABLE', 'Sync marker reader is unavailable');
    const kinds = oldUnique(scene, context) ? ['global'] : scene.sessionGroup === 'origin' ? ['group', 'origin'] : ['group'];
    let unheld = true;
    for (const kind of kinds) {
      const marker = await this.d.readSyncMarker({ runDir: scene.runDir, kind, currentRunId: scene.runId });
      if (!marker || typeof marker.held !== 'boolean' || typeof marker.stale !== 'boolean') throw error('INVALID_OBSERVATION', 'Invalid Sync marker result');
      if (marker.held && !marker.stale) unheld = false;
    }
    return unheld;
  }

  async idle(scene, context, { ignoreSyncMarker = false } = {}) {
    if (!scene.present || !scene.ready || scene.processRunning !== true || scene.state !== 'idle' ||
        !finite(scene.idleSince) || this.now() - scene.idleSince < this.idleConfirmMs) return false;
    return ignoreSyncMarker || this.checkReclaimDependencies(scene, context);
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

  async running(group, { context } = {}) {
    const conversations = group === 'origin' && context && modeOf(context) === 'single' ? await this.d.db.countGlobalRunningConversations() : await this.d.db.countRunningConversations(group);
    const controls = await this.d.db.countNonTerminalControls({ sessionGroup: group });
    if (!Number.isInteger(conversations) || conversations < 0 || !Number.isInteger(controls.running) || controls.running < 0) {
      throw error('INVALID_OBSERVATION', 'Invalid in-flight counts');
    }
    return { conversations, controls: controls.running };
  }

  async clear(fence, context) {
    this.reclaimSyncFailures.delete(fence.sessionGroup);
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
    if (legacy(context) || fence.sessionGroup === '*') return this.clear(fence, context);
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
    if (reason === 'evict' && scene.sessionGroup === 'origin') return false;
    if (!scene.present || !scene.ready || !scene.runId) return false;
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

  async stopForModeSwitch(scene, context) {
    const group = scene.sessionGroup;
    if (await this.d.db.countRunningConversations(group) !== 0) return;
    const fresh = await this.observe(group, context);
    if (!fresh.present || !fresh.ready || fresh.runId !== scene.runId) return;
    await this.d.stop(fresh);
    this.stopped(fresh, context);
  }

  async advanceReclaim(fence, context) {
    if (fence.reason === 'manual_restart' || !RECLAIM_REASONS.has(fence.reason)) return 'ignored';
    const group = fence.sessionGroup;
    if (group === '*') return 'ignored';
    const preparedTtl = fence.reason === 'ttl' && this.ttlPreparation.get(group)?.runId === fence.runId;
    const currentFence = context.fences.find(item => item.sessionGroup === group);
    if (!currentFence || currentFence.runId !== fence.runId || currentFence.reason !== fence.reason) return 'changed';
    let scene = await this.reclaimRead(fence, () => this.scene(group, context));
    if (fence.reason === 'delete' && scene.present && scene.runId && scene.runId !== fence.runId) return 'changed';
    const switchingGroup = context.transition?.phase === 'gating' && group !== 'origin';
    if (switchingGroup && scene.present) return 'waiting_inflight';
    const staleBefore = switchingGroup ? Math.floor(this.now() / 1000) + 1 : Math.floor(scene.currentSessionTs / 1000);
    if (finite(staleBefore)) {
      const expired = await this.reclaimRead(fence, () => this.d.db.expireStaleRunningControls({ sessionGroup: group }, { deliveredBefore: staleBefore }));
      for (const row of expired) await this.event('control_expired', { session_group: group, control_id: row.id, run_id: fence.runId });
    }
    const counts = await this.reclaimRead(fence, () => this.running(group, { context }));
    if (counts.conversations > 0 || counts.controls > 0) return 'waiting_inflight';
    if (scene.present && scene.runId === fence.runId) {
      if (typeof scene.processRunning !== 'boolean') return 'unknown_process';
      if (scene.processRunning !== false) {
        if (preparedTtl && this.activeSubagents(scene, context)) return 'waiting_idle';
        const childBlocked = this.subagentReclaimBlocked(scene, fence.reason, context);
        if (childBlocked ||
            !await this.reclaimRead(fence, () => this.idle(scene, context, {
              ignoreSyncMarker: ['ttl', 'release'].includes(fence.reason) && this.reclaimSyncFailures.get(group) === scene.runId,
            }))) {
          if (['model_config', 'delete'].includes(fence.reason)) return 'waiting_idle';
          await this.clear(fence, context);
          if (fence.reason === 'ttl') this.ttlReset.set(group, { runId: fence.runId, at: this.now() });
          await this.event('reclaim_cancelled', { session_group: group, run_id: fence.runId, reason: childBlocked ? 'subagent_activity' : 'not_idle' });
          return 'cancelled';
        }
        const again = await this.reclaimRead(fence, async () => fence.reason === 'delete' ? this.running(group, { context }) : {
          conversations: group === 'origin' && modeOf(context) === 'single' ? await this.d.db.countGlobalRunningConversations() : await this.d.db.countRunningConversations(group), controls: 0,
        });
        if (again.conversations !== 0 || again.controls !== 0) {
          if (fence.reason === 'delete') return 'waiting_inflight';
          if (!['model_config', 'delete'].includes(fence.reason)) {
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
          const current = await this.d.db.getDrainFence(group);
          if (!current || current.runId !== fence.runId || current.reason !== fence.reason) throw error('FENCE_MISMATCH', 'Reclaim fence changed');
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
    const replacement = scene.present && scene.runId !== fence.runId ? await this.d.readCurrentSession?.(group) : null;
    if (replacement?.runId && replacement.runId !== fence.runId) {
      if (fence.reason === 'delete') return 'changed';
      await this.clear(fence, context);
    } else await this.completeRun(fence, context);
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
    const ttl = (context.configuration.hotTtlSeconds ?? 3300) * 1000;
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
    const seconds = reason === 'ttl' ? context.configuration.hotTtlSeconds ?? 3300 : context.configuration.evictMinIdleSeconds ?? 300;
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
    const preparation = this.ttlPreparation.get(group) ?? this.evictionPreparation.get(group) ?? this.releasePreparation.get(group);
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
    this.releasePreparation.delete(group);
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
    this.reclaimSyncFailures.delete(scene.sessionGroup);
    const group = scene.sessionGroup;
    const range = await this.d.db.getUnsummarizedRange(group);
    if (!Number.isInteger(range.count) || range.count < 0) throw error('INVALID_OBSERVATION', 'Invalid unsummarized count');
    const todo = ['PRE_RECLAIM_CHECK_PROMPT'];
    // A backlog at or below the Sync threshold stays in C4 for the group's next session.
    if (range.count > groupSyncThreshold(context.configuration)) todo.push('PRE_RECLAIM_SYNC_PROMPT');
    if (group === 'origin') {
      const backlog = await this.d.db.getOriginSyncBacklog();
      if (backlog.total > 0 || backlog.groups.some(item => item.pendingCheckpoints > 0)) todo.push('PRE_RECLAIM_ORIGIN_SYNC_PROMPT');
    }
    intent.prepared = false;
    // Reuse TTL check/Sync prompts and their bound-control wait before fencing.
    for (const prompt of todo) {
      if (!await this.beforeWrite(group, context, scene)) return;
      const targetBinding = await this.bindCurrentRun(scene);
      if (!targetBinding) return;
      const now = this.now();
      const syncKind = prompt === 'PRE_RECLAIM_ORIGIN_SYNC_PROMPT' ? 'origin' : 'group';
      const syncTarget = prompt === 'PRE_RECLAIM_CHECK_PROMPT' ? null :
        await captureSyncTarget({ db: this.d.db, scene, kind: syncKind, range, now });
      const checkpointId = syncTarget?.checkpointId ?? null;
      const control = await this.d.db.insertControl(this.prompt(prompt), {
        sessionGroup: group, targetBinding, requireIdle: true, appendAckSuffix: true,
        ackDeadlineAt: Math.floor((now + (prompt === 'PRE_RECLAIM_CHECK_PROMPT' ? this.ackTimeoutMs : PRE_RECLAIM_SYNC_ACK_TIMEOUT_MS)) / 1000), createdAt: Math.floor(now / 1000),
      });
      if (prompt !== 'PRE_RECLAIM_CHECK_PROMPT') await this.recordSyncTrigger(scene, syncKind, ['pre_reclaim'], range, control, checkpointId);
      intent.controlIds.push(control.id);
      if (syncTarget) {
        intent.syncs ??= [];
        intent.syncs.push({ target: syncTarget, prompt, range, controlId: control.id, at: now, deadline: now + PRE_RECLAIM_SYNC_ACK_TIMEOUT_MS });
      }
    }
    intent.prepared = true;
  }

  async preparationControlsSettled(preparation) {
    for (const id of preparation.controlIds) {
      if (preparation.settledSyncIds?.includes(id)) continue;
      const control = await this.d.db.getControlById(id);
      if (control && TERMINAL_CONTROLS.has(control.status)) continue;
      // Expired Sync controls cannot stall a bounded preparation indefinitely,
      // including when the dispatcher has not yet marked them timeout.
      const sync = preparation.syncs?.find(row => row.controlId === id);
      if (sync && this.now() >= sync.deadline) continue;
      return false;
    }
    return true;
  }

  async advancePreparationSync(scene, context, preparation) {
    const failures = [];
    for (const sync of preparation.syncs ?? []) {
      const proof = await observeSyncCompletion({ db: this.d.db, scene, target: sync.target,
        readSyncMarker: this.d.readSyncMarker, env: this.d.env });
      if (proof.ok) continue;
      if (proof.reason === 'control_timeout' && this.now() < sync.deadline) return false;
      failures.push({ sync, reason: proof.reason });
    }
    if (!failures.length) return this.checkReclaimDependencies(scene, context);
    if (!preparation.syncRetried) {
      for (const { sync } of failures) {
        if (!await this.beforeWrite(scene.sessionGroup, context, scene)) return false;
        const targetBinding = await this.bindCurrentRun(scene);
        if (!targetBinding) return false;
        const at = this.now();
        const control = await this.d.db.insertControl(this.prompt(sync.prompt), {
          sessionGroup: scene.sessionGroup, targetBinding, requireIdle: true, appendAckSuffix: true,
          ackDeadlineAt: Math.floor((at + PRE_RECLAIM_SYNC_ACK_TIMEOUT_MS) / 1000), createdAt: Math.floor(at / 1000),
        });
        // Retain every owned ID so late delivery of our own control never
        // masquerades as new human work and cancels voluntary release.
        preparation.settledSyncIds ??= [];
        preparation.settledSyncIds.push(sync.controlId);
        preparation.controlIds.push(control.id);
        preparation.syncRetried = true;
        Object.assign(sync, { controlId: control.id, at, deadline: at + PRE_RECLAIM_SYNC_ACK_TIMEOUT_MS });
        await this.recordSyncTrigger(scene, sync.target.kind, ['pre_reclaim'], sync.range, control, sync.target.checkpointId ?? null);
      }
      return false;
    }
    this.reclaimSyncFailures.set(scene.sessionGroup, scene.runId);
    if (!preparation.syncFailureAlerted) {
      // One alert per preparation even when both group and Origin repair fail.
      const { sync, reason } = failures[0];
      const code = latestSyncFailure({ env: this.d.env, scene, target: sync.target, startedAt: sync.at });
      const control = await this.d.db.getControlById(sync.controlId);
      const alert = { type: 'repair_failed', kind: sync.target.kind, scope: scene.sessionGroup, repairAttempt: 'pre_reclaim_retry',
        reason: code ?? (control?.status === 'timeout' ? 'control_timeout' : reason), controlId: sync.controlId,
        checkpointId: sync.target.checkpointId, checkpointEnd: sync.target.end,
        ...(sync.target.kind === 'origin' ? { cursors: sync.target.cursors } : {}) };
      preparation.syncFailureAlerted = true;
      await this.sendSyncAlert(alert, context);
    }
    return true;
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
      if (!await this.preparationControlsSettled(intent)) return;
      // An acknowledged check/Sync can still be finishing its turn or holding its
      // scoped marker; children and activity must drain through normal guards.
      if (scene.turnOpen === true || this.subagentReclaimBlocked(scene, 'release', context) ||
          !await this.idle(scene, context, { ignoreSyncMarker: Boolean(intent.syncs?.length) })) return;
      if (!intent.prepared) await this.prepareRelease(scene, context, intent);
      if (!intent.prepared || intent.controlIds.length) {
        if (!await this.preparationControlsSettled(intent)) return;
        if (!intent.prepared) return;
      }
      if (!await this.advancePreparationSync(scene, context, intent)) return;
      if (await this.beginReclaim(scene, 'release', context)) this.releasePreparation.delete(sessionGroup);
    });
  }

  async checkTtl(scene, context) {
    if (scene.observationError) throw scene.observationError;
    const group = scene.sessionGroup;
    if (this.releasePreparation.has(group) && scene.turnOpen !== true) return;
    if (legacy(context) || !group || !await this.allowed(group, context)) return;
    if (!scene.present || !scene.ready) { this.ttlPreparation.delete(group); return; }
    const preparation = this.ttlPreparation.get(group);
    // Preparation starts only after TTL expiry. Its own Sync activity must not
    // restart that clock; C4 messages and the other activity sources still can.
    const now = this.now(), last = await this.lastActivity(scene,
      preparation?.runId === scene.runId ? preparation.at : Infinity);
    const ttl = (context.configuration.hotTtlSeconds ?? 3300) * 1000;
    if (preparation && (preparation.runId !== scene.runId || last > preparation.at)) {
      this.ttlPreparation.delete(group);
      return;
    }
    if (now - last < ttl) return;
    if (preparation) {
      if (!await this.preparationControlsSettled(preparation)) return;
      if (!preparation.partial && (this.activeSubagents(scene, context) || !await this.idle(scene, context,
        { ignoreSyncMarker: Boolean(preparation.syncs?.length) }))) return;
      if (preparation.partial) { this.ttlPreparation.delete(group); return; }
      if (!await this.advancePreparationSync(scene, context, preparation)) return;
      // Keep the preparation cutoff through the fence's final activity recheck.
      await this.beginReclaim(scene, 'ttl', context);
      return;
    }
    if (this.activeSubagents(scene, context)) return;
    if (oldUnique(scene, context)) { await this.beginReclaim(scene, 'ttl', context); return; }
    const range = await this.d.db.getUnsummarizedRange(group);
    if (!Number.isInteger(range.count) || range.count < 0) throw error('INVALID_OBSERVATION', 'Invalid unsummarized count');
    // Every TTL reclaim first asks for a check of work waiting on external events; Sync, when due, follows it.
    const todo = ['PRE_RECLAIM_CHECK_PROMPT'];
    // A backlog at or below the Sync threshold stays in C4 for the group's next session.
    if (range.count > groupSyncThreshold(context.configuration)) todo.push('PRE_RECLAIM_SYNC_PROMPT');
    if (group === 'origin') {
      const backlog = await this.d.db.getOriginSyncBacklog();
      if (backlog.total > 0 || backlog.groups.some(item => item.pendingCheckpoints > 0)) todo.push('PRE_RECLAIM_ORIGIN_SYNC_PROMPT');
    }
    const controlIds = [];
    const syncs = [];
    this.reclaimSyncFailures.delete(group);
    let partial = false;
    for (const prompt of todo) {
      if (!await this.beforeWrite(group, context, scene)) { partial = controlIds.length > 0; break; }
      const targetBinding = await this.bindCurrentRun(scene);
      if (!targetBinding) { partial = controlIds.length > 0; break; }
      const syncKind = prompt === 'PRE_RECLAIM_ORIGIN_SYNC_PROMPT' ? 'origin' : 'group';
      const syncTarget = prompt === 'PRE_RECLAIM_CHECK_PROMPT' ? null :
        await captureSyncTarget({ db: this.d.db, scene, kind: syncKind, range, now });
      const checkpointId = syncTarget?.checkpointId ?? null;
      const control = await this.d.db.insertControl(this.prompt(prompt), {
        sessionGroup: group, targetBinding, requireIdle: true, appendAckSuffix: true, ackDeadlineAt: Math.floor((now + (prompt === 'PRE_RECLAIM_CHECK_PROMPT' ? this.ackTimeoutMs : PRE_RECLAIM_SYNC_ACK_TIMEOUT_MS)) / 1000),
        createdAt: Math.floor(now / 1000),
      });
      if (prompt !== 'PRE_RECLAIM_CHECK_PROMPT') await this.recordSyncTrigger(scene, syncKind, ['pre_reclaim'], range, control, checkpointId);
      controlIds.push(control.id);
      if (syncTarget) syncs.push({ target: syncTarget, prompt, range, controlId: control.id, at: now, deadline: now + PRE_RECLAIM_SYNC_ACK_TIMEOUT_MS });
    }
    if (controlIds.length) this.ttlPreparation.set(group, { controlIds, syncs, runId: scene.runId, at: now, partial });
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
    if (group === 'origin' || !scene.present || !scene.ready || !scene.runId) return null;
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
      ackDeadlineAt: Math.floor((now + this.evictionAckTimeoutMs) / 1000), createdAt: Math.floor(now / 1000),
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
    if (!scene.present || !scene.ready || oldUnique(scene, context)) return;
    const threshold = sceneRotationThreshold(scene, context.configuration);
    if (!finite(scene.usagePercent) || threshold === null || scene.usagePercent < threshold) return;
    const key = JSON.stringify([scene.runId, scene.sessionId]), now = this.now();
    if (this.rotationSent.has(key) && now - this.rotationSent.get(key) < this.rotationCooldownMs) return;
    if (!await this.beforeWrite(scene.sessionGroup, context, scene)) return;
    const targetBinding = await this.bindCurrentRun(scene);
    if (!targetBinding) return;
    await this.d.db.insertControl(this.prompt('ROTATION_PROMPT', scene), { targetBinding, sessionGroup: scene.sessionGroup, bypassState: true, appendAckSuffix: false });
    this.rotationSent.set(key, now);
  }

  async reconcileConfiguration(context) {
    if (legacy(context)) return;
    await this.each(context.scenes, async scene => {
      if (scene.observationError) throw scene.observationError;
      if (!this.allowed(scene.sessionGroup, context)) return;
      if (!scene.present || !scene.ready || oldUnique(scene, context)) return;
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
        priority: 1, bypassState: true, appendAckSuffix: true, ackDeadlineAt: Math.floor((now + this.ackTimeoutMs) / 1000),
        createdAt: Math.floor(now / 1000) });
      this.configurationSent.set(scene.runId, now);
    });
  }

  async checkSync(scenes, context) {
    const now = this.now();
    if (this.lastSyncCheck !== null && now - this.lastSyncCheck < this.syncCheckMs) return;
    if (context.restartRequestsError || context.transition || context.fences.some(fence => fence.sessionGroup === '*')) return;
    this.lastSyncCheck = now;
    await this.each(scenes, async scene => {
      if (scene.observationError) throw scene.observationError;
      if (!await this.allowed(scene.sessionGroup, context)) return;
      if (!scene.present || !scene.ready || oldUnique(scene, context)) return;
      const range = await this.d.db.getUnsummarizedRange(scene.sessionGroup);
      await this.syncScope(scene, 'group', { count: range.count, firstAt: range.firstAt,
        firstConversationId: range.firstConversationId, nonempty: range.count > 0 }, context);
    });
    if (this.allowed('origin', context) &&
        !scenes.some(scene => scene.sessionGroup === 'origin' &&
          (context.configuration.mode === 'single' && scene.observationError || scene.present && oldUnique(scene, context)))) {
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
    await this.syncAlerts(context);
  }

  async syncCheckpoint(scene, kind) {
    try {
      return kind !== 'origin' && this.d.db.getLatestContentCheckpoint
        ? (await this.d.db.getLatestContentCheckpoint(kind === 'global' ? '*' : scene.sessionGroup))?.id ?? null : null;
    } catch (cause) { this.d.reportError?.(cause, { phase: 'sync-trigger-metadata' }); return null; }
  }

  async recordSyncTrigger(scene, kind, reason, range, control, checkpointId) {
    try {
      if (kind === 'origin') {
        const backlog = await this.d.db.getOriginSyncBacklog();
        const times = backlog.groups.flatMap(row => [row.firstAt, row.firstCheckpointAt]).filter(value => value != null).map(activityTime);
        range = { count: backlog.total, firstAt: times.length ? Math.min(...times) : null };
      }
    } catch (cause) { this.d.reportError?.(cause, { phase: 'sync-trigger-metadata' }); }
    await this.event('sync_triggered', { scope: kind === 'global' ? '*' : scene.sessionGroup, kind, reason,
      backlog: range.count, lag: range.firstAt == null ? 0 : Math.floor(Math.max(0, this.now() - activityTime(range.firstAt)) / 1000),
      ...(finite(scene.usagePercent) ? { contextPercent: scene.usagePercent } : {}), checkpointId,
      controlId: control?.id ?? null, runId: scene.runId ?? null });
  }

  async syncAlerts(context) {
    if (!this.d.syncObserver) return;
    let alerts = await this.d.syncObserver.inspect(this.d.db, { ...context.configuration,
      mode: 'multi',
      episodes: this.syncAlertEpisodes.entries(),
      activeScopes: context.scenes.filter(scene => (scene.present || scene.observationError) && !oldUnique(scene, context))
        .map(scene => scene.sessionGroup),
    }, async (scope, kind) => {
      const scene = context.scenes.find(row => row.sessionGroup === scope);
      const marker = await this.d.readSyncMarker({ runDir: scene?.runDir ?? this.d.groupRunDir(scope === '*' ? 'origin' : scope), kind, currentRunId: scene?.runId ?? null });
      return marker.held && !marker.stale;
    });
    for (const candidate of this.syncBacklogCandidates.values()) {
      // Origin backlog retains threshold-based notification even when bounded
      // rounds succeed; successful progress need not drain all pending work.
      if (candidate.kind === 'origin') { alerts.push(candidate); continue; }
      const trigger = [...this.d.syncObserver.groups.values()].find(row => row.kind === candidate.kind && row.scope === candidate.scope);
      const startedAt = trigger?.ts;
      const scene = context.scenes.find(row => row.sessionGroup === candidate.scope && row.present);
      if (!scene) continue;
      const code = scene && startedAt != null ? latestSyncFailure({ env: this.d.env, scene,
        target: { kind: candidate.kind, scope: candidate.scope }, startedAt }) : null;
      const failed = trigger?.attempts >= 3;
      if (code || failed) alerts.push({ ...candidate, ...(code ? { reason: code } : {}) });
    }
    // Scheduling anomalies are engineering evidence, including timeouts owned
    // by reclaim. Record before those owners suppress symptoms;
    // no Origin control or session write gate is involved.
    for (const alert of alerts.filter(row => SYNC_DIAGNOSTIC_TYPES.has(row.type))) {
      if (await this.sendSyncAlert(alert, context)) this.d.syncObserver.acknowledged(alert);
    }
    alerts = alerts.filter(row => !SYNC_DIAGNOSTIC_TYPES.has(row.type));
    let resolved = this.d.syncObserver.resolved ?? [];
    for (const episode of this.syncAlertEpisodes.entries().filter(row => row.type === 'repair_failed')) {
      if (episode.kind === 'global' || episode.kind === 'origin' && !episode.cursors) continue;
      const scene = context.scenes.find(row => row.sessionGroup === episode.scope) ?? {
        sessionGroup: episode.scope, runId: null, runDir: this.d.groupRunDir(episode.scope),
      };
      const proof = await observeSyncCompletion({ db: this.d.db, scene,
        target: { kind: episode.kind, scope: episode.scope, end: episode.checkpointEnd ?? 0,
          checkpointId: episode.checkpointId, cursors: episode.cursors },
        readSyncMarker: this.d.readSyncMarker, env: this.d.env, requireNewCheckpoint: false });
      if (proof.ok) resolved.push(episode);
    }
    const resolvedKeys = new Set(resolved.map(row => JSON.stringify([row.scope, row.kind, row.type])));
    alerts.push(...this.syncAlertEpisodes.entries().filter(row => row.type === 'repair_failed' && !row.sent &&
      !resolvedKeys.has(JSON.stringify([row.scope, row.kind, row.type]))));
    const activeKeys = new Set(alerts.map(alert => JSON.stringify([alert.scope, alert.kind, alert.type])));
    this.syncAlertEpisodes.reconcile({ active: alerts, resolved: resolved.filter(alert =>
      !activeKeys.has(JSON.stringify([alert.scope, alert.kind, alert.type]))) });
    for (const alert of alerts) if (await this.sendSyncAlert(alert, context)) this.d.syncObserver.acknowledged(alert);
  }

  async sendSyncAlert(alert, context) {
    if (context.scenes.some(scene => scene.sessionGroup === 'origin' &&
      (context.configuration.mode === 'single' && scene.observationError || scene.present && oldUnique(scene, context)))) return false;
    this.syncAlertEpisodes.reconcile({ active: [alert] });
    if (!this.syncAlertEpisodes.available) return false;
    if (SYNC_DIAGNOSTIC_TYPES.has(alert.type)) {
      if (this.syncAlertEpisodes.claim(alert)) await this.event('sync_alert', alert);
      return this.syncAlertEpisodes.available;
    }
    if (!await this.beforeWrite('origin', context)) return false;
    if (!this.syncAlertEpisodes.claim(alert)) return true;
    try {
      await this.d.db.insertControl(this.prompt('SYNC_BACKLOG_ALERT', alert.kind, alert.backlog ?? 0, alert.lag ?? 0, alert.scope, alert.type, alert), {
        sessionGroup: 'origin', appendAckSuffix: false,
      });
    } catch (cause) {
      // SQLite admission failures are definite non-enqueues; an unknown result
      // keeps its durable claim so supervisor restart cannot multiply messages.
      if (/^(?:SQLITE_|DRAIN_|MODE_)/.test(cause.code ?? '')) this.syncAlertEpisodes.retry(alert);
      throw cause;
    }
    await this.event('sync_alert', alert);
    return true;
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
    const threshold = kind === 'origin' ? (config.originSyncThreshold ?? 50) : groupSyncThreshold(config);
    const lag = range.firstAt === null || range.firstAt === undefined ? 0 : Math.max(0, now - activityTime(range.firstAt));
    const alertLag = kind === 'origin' ? (range.alertFirstAt === null || range.alertFirstAt === undefined ? 0 : Math.max(0, now - activityTime(range.alertFirstAt))) : lag;
    const alert = kind !== 'origin' && range.count > 4 * (config.syncBatchLimit ?? 200) || alertLag > 2 * max;
    const alertScope = kind === 'global' ? '*' : scene.sessionGroup;
    const backlogKey = JSON.stringify([kind, alertScope]);
    if (alert) this.syncBacklogCandidates.set(backlogKey, { type: 'backlog', kind, scope: alertScope,
      backlog: range.count, lag: Math.floor(alertLag / 1000) });
    else {
      this.syncBacklogCandidates.delete(backlogKey);
      this.syncAlertEpisodes.reconcile({ resolved: [{ type: 'backlog', kind, scope: alertScope }] });
    }
    const previous = this.syncProgress.get(key);
    const catchingUp = kind !== 'origin' && !this.ttlPreparation.has(scene.sessionGroup) &&
      previous?.n0 > (config.syncBatchLimit ?? 200) && previous.runId === scene.runId &&
      range.firstConversationId > previous.f0;
    if (!range.nonempty || (!catchingUp && this.syncSent.has(key) && now - this.syncSent.get(key) < min)) return;
    // Early Sync at 80% of the rotation threshold is disabled: a smaller backlog reaches the next
    // session through its startup context, and a larger one is already due by the threshold.
    // const rotationThreshold = sceneRotationThreshold(scene, config);
    // ... || kind !== 'origin' && rotationThreshold !== null && finite(scene.usagePercent) && scene.usagePercent >= 0.8 * rotationThreshold
    const due = range.count > threshold || lag >= max;
    if (!catchingUp && !due) return;
    if (typeof this.d.readSyncMarker !== 'function') throw error('DEPENDENCY_UNAVAILABLE', 'Sync marker reader is unavailable');
    const marker = await this.d.readSyncMarker({ runDir: scene.runDir, kind, currentRunId: scene.runId });
    if (!marker || typeof marker.held !== 'boolean' || typeof marker.stale !== 'boolean') throw error('INVALID_OBSERVATION', 'Invalid Sync marker result');
    if (marker.held && !marker.stale) return;
    if (!await this.beforeWrite(scene.sessionGroup, context, kind === 'origin' ? undefined : scene)) return;
    const checkpointId = await this.syncCheckpoint(scene, kind);
    const control = await this.d.db.insertControl(this.prompt(kind === 'origin' ? 'ORIGIN_SYNC_PROMPT' : 'GROUP_SYNC_PROMPT'), {
      sessionGroup: scene.sessionGroup, priority: 2, appendAckSuffix: false,
      ...(kind === 'origin' ? {} : { ackDeadlineAt: Math.floor((now + this.ackTimeoutMs) / 1000), createdAt: Math.floor(now / 1000) }),
    });
    const reason = [];
    if (range.count > threshold) reason.push('threshold');
    if (lag >= max) reason.push('max_lag');
    if (catchingUp) reason.push('catch_up');
    await this.recordSyncTrigger(scene, kind, reason, range, control, checkpointId);
    this.syncSent.set(key, now);
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
    if (oldUnique(scene, context)) return true;
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
      ackDeadlineAt: Math.floor((now + this.upgradeAckTimeoutMs) / 1000), createdAt: Math.floor(now / 1000),
    });
    this.upgradePreparation.set(scene.runId, { controlId: control.id, at: now, deadline: now + this.upgradeAckTimeoutMs });
    return false;
  }

  manualBlocked(request, context) {
    const group = manualTarget(request);
    const fence = context.fences.find(item => item.sessionGroup === group);
    return context.restartRequestsError || modeOf(context) !== request.mode || context.transition ||
      context.fences.some(item => item.sessionGroup === '*') ||
      fence && (fence.reason !== 'manual_restart' || fence.runId !== request.expectedRunId);
  }

  async checkManualFences(context) {
    if (context.restartRequestsError) return [];
    const requests = context.restartRequests.filter(request => request.reason === 'manual_restart');
    const activeWarnings = new Set(), allowed = [];
    for (const fence of context.fences.filter(item => item.reason === 'manual_restart')) {
      if (!requests.some(request => manualTarget(request) === fence.sessionGroup && request.expectedRunId === fence.runId)) {
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
        const group = manualTarget(request);
        const targetGroup = group;
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
        if (targetGroup === 'origin') await this.d.db.insertControl(MANUAL_WAKE_PROMPT, {
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
