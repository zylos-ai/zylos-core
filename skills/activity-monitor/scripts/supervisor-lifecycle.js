import { isDeepStrictEqual } from 'node:util';
import { validLaunchConfigSnapshot as validLaunchConfig } from './launch-config-shape.js';

const TERMINAL_CONTROLS = new Set(['done', 'timeout', 'superseded', 'failed', 'cancelled']);
const CAPACITY_REASONS = new Set(['ttl', 'evict', 'upgrade', 'auth']);
const RECLAIM_REASONS = new Set([...CAPACITY_REASONS, 'mode_switch', 'model_config']);
const error = (code, message) => Object.assign(new Error(message), { code });
const modeOf = context => context.configuration.mode ?? context.configuration.session_mode ?? context.configuration.sessionMode;
const targetOf = group => group === null ? { machine: true } : { sessionGroup: group };
const finite = value => Number.isFinite(value);

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

export function evictionDemand(scenes, pending, fences, capacity) {
  if (!Number.isInteger(capacity) || capacity < 1) throw error('CONFIG_UNREADABLE', 'Pool capacity must be positive');
  const present = new Set(scenes.filter(s => s.present && s.sessionGroup !== 'origin' && s.sessionGroup !== null).map(s => s.sessionGroup));
  const waiting = new Set(pending.map(row => row.sessionGroup).filter(g => g !== 'origin' && g !== null && !present.has(g))).size;
  const free = capacity - present.size;
  const inflight = fences.filter(f => f.sessionGroup !== 'origin' && f.sessionGroup !== '*' && CAPACITY_REASONS.has(f.reason)).length;
  return { waiting, free, inflight, need: Math.max(0, waiting - free - inflight) };
}

/** Lifecycle methods run inside the same serial section as socket admission.
 * observeGroup returns current facts, never a cached absence. stop and the manual
 * fixed-target providers must use the adapter's pinned object guard.
 * Sync marker reading and prompt constants are supplied by the memory module.
 */
export class SupervisorLifecycle {
  constructor(deps, { now = Date.now, idleConfirmMs = 3000, rotationCooldownMs = 300000,
    syncCheckMs = 60000, ackTimeoutMs = 300000 } = {}) {
    this.d = deps;
    this.now = now;
    this.idleConfirmMs = idleConfirmMs;
    this.rotationCooldownMs = rotationCooldownMs;
    this.syncCheckMs = Math.min(syncCheckMs, 60000);
    this.ackTimeoutMs = ackTimeoutMs;
    if (!(ackTimeoutMs > 0) || !finite(ackTimeoutMs)) throw new TypeError('A finite acknowledgment timeout is required');
    this.ttlPreparation = new Map();
    this.ttlReset = new Map();
    this.rotationSent = new Map();
    this.configurationSent = new Map();
    this.syncSent = new Map();
    this.syncRuns = new Map();
    this.backlogSent = new Map();
    this.sessions = new Map();
    this.lastSyncCheck = null;
    this.manualWarnings = new Set();
    this.reclaimWarnings = new Set();
    this.reclaimStopPending = new Set();
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

  async observe(group) {
    const scene = await this.d.observeGroup(group);
    if (!scene || typeof scene.present !== 'boolean') throw error('INVALID_OBSERVATION', 'Runtime presence is unknown');
    return { ...scene, sessionGroup: group };
  }

  async allowed(group, context) {
    if (context.transition || await this.d.db.getModeTransition() || await this.d.db.getDrainFence('*')) return false;
    if (group !== null && await this.d.db.getDrainFence(group)) return false;
    if ((group === 'origin' || group === null) && this.d.requests && this.d.requests.read().some(r => r.reason === 'manual_restart')) return false;
    return true;
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

  async reclaimObservation(fence, unfenced, operation) {
    try { return await operation(); }
    catch (cause) {
      // A previous stop with an unknown outcome still requires confirmation.
      // Otherwise cancel only our exact fence; no stop was issued this round.
      if (this.reclaimStopPending.has(JSON.stringify([fence.sessionGroup, fence.runId, fence.reason]))) throw cause;
      if (!unfenced) await this.reclaimRead(fence, () => this.clear(fence));
      if (fence.reason === 'ttl') this.ttlReset.set(fence.sessionGroup, { runId: fence.runId, at: this.now() });
      await this.event('reclaim_cancelled', { session_group: fence.sessionGroup, run_id: fence.runId, reason: 'observation_error', error: cause.code ?? cause.message });
      throw cause;
    }
  }

  async warnReclaim(fence, cause, name = 'reclaim_observation_unavailable') {
    const key = JSON.stringify([fence.sessionGroup, fence.runId, fence.reason, name]);
    if (this.reclaimWarnings.has(key)) return;
    this.reclaimWarnings.add(key);
    const event = { event: name, session_group: fence.sessionGroup, sessionGroup: fence.sessionGroup,
      run_id: fence.runId, reason: cause.code ?? cause.message };
    await this.event(name, event);
    if (this.d.alert) Promise.resolve().then(() => this.d.alert(event)).catch(alertError => {
      this.reclaimWarnings.delete(key); this.d.reportError?.(alertError, { phase: 'reclaim_alert' });
    });
  }

  async reclaimRead(fence, operation) {
    try { return await operation(); }
    catch (cause) { await this.warnReclaim(fence, cause); throw cause; }
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

  async clear(fence) {
    const current = await this.d.db.getDrainFence(fence.sessionGroup);
    if (!current) return;
    if (current.reason !== fence.reason || current.runId !== fence.runId) throw error('FENCE_MISMATCH', 'Reclaim fence changed');
    await this.d.db.clearDrainFence(fence.sessionGroup, { expectedReason: fence.reason, expectedRunId: fence.runId });
  }

  async beginReclaim(scene, reason, context) {
    if (['ttl', 'evict'].includes(reason) && (scene.sessionGroup === 'origin' || scene.sessionGroup === null)) return false;
    if (!scene.present || !scene.ready || !scene.runId || scene.sessionGroup === null) return false;
    if (!await this.allowed(scene.sessionGroup, context)) return false;
    const fresh = await this.observe(scene.sessionGroup);
    if (!fresh.present || !fresh.ready || fresh.runId !== scene.runId) return false;
    await this.checkReclaimDependencies(fresh, context);
    await this.d.db.setDrainFence(scene.sessionGroup, { reason, runId: scene.runId });
    const saved = await this.d.db.getDrainFence(scene.sessionGroup);
    return saved?.reason === reason && saved.runId === scene.runId;
  }

  async advanceReclaim(fence, context, { unfenced = false, singleAuth = false } = {}) {
    if (fence.reason === 'manual_restart' || !RECLAIM_REASONS.has(fence.reason)) return 'ignored';
    const group = unfenced ? null : fence.sessionGroup;
    if (group === '*') return 'ignored';
    if (!unfenced) {
      const current = await this.reclaimRead(fence, () => this.d.db.getDrainFence(group));
      if (!current || current.runId !== fence.runId || current.reason !== fence.reason) return 'changed';
    }
    let scene = await this.reclaimObservation(fence, unfenced, () => this.observe(group));
    if (finite(scene.currentSessionTs)) {
      const expired = await this.reclaimRead(fence, () => this.d.db.expireStaleRunningControls(targetOf(group), { deliveredBefore: Math.floor(scene.currentSessionTs / 1000) }));
      for (const row of expired) await this.event('control_expired', { session_group: group, control_id: row.id, run_id: fence.runId });
    }
    const counts = await this.reclaimRead(fence, () => this.running(group, { withoutDeadline: singleAuth }));
    if (counts.conversations > 0 || counts.controls > 0) return 'waiting_inflight';
    if (scene.present && scene.runId === fence.runId) {
      if (typeof scene.processRunning !== 'boolean') return 'unknown_process';
      if (scene.processRunning !== false) {
        if (!await this.reclaimObservation(fence, unfenced, () => this.idle(scene, context))) {
          if (singleAuth || fence.reason === 'model_config') return 'waiting_idle';
          if (!unfenced) await this.clear(fence);
          if (fence.reason === 'ttl') this.ttlReset.set(group, { runId: fence.runId, at: this.now() });
          await this.event('reclaim_cancelled', { session_group: group, run_id: fence.runId, reason: 'not_idle' });
          return 'cancelled';
        }
        const again = await this.reclaimRead(fence, async () => singleAuth ? this.running(group, { withoutDeadline: true }) : {
          conversations: group === null ? await this.d.db.countGlobalRunningConversations() : await this.d.db.countRunningConversations(group), controls: 0,
        });
        if (again.conversations !== 0 || again.controls !== 0) {
          if (singleAuth) return 'waiting_inflight';
          if (fence.reason !== 'model_config' && !unfenced) await this.clear(fence);
          if (fence.reason === 'ttl') this.ttlReset.set(group, { runId: fence.runId, at: this.now() });
          throw error('RECLAIM_INFLIGHT', 'Conversation appeared after drain fence');
        }
      }
      // Re-read immediately before constructing the stop; never retarget a replacement.
      scene = await this.reclaimObservation(fence, unfenced, () => this.observe(group));
      if (scene.present && scene.runId === fence.runId) {
        if (typeof scene.processRunning !== 'boolean') return 'unknown_process';
        try {
          await this.d.stop(scene);
          const after = await this.observe(group);
          if (after.present && after.runId === fence.runId) throw error('STOP_UNCONFIRMED', 'Target tmux still exists');
        } catch (cause) {
          this.reclaimStopPending.add(JSON.stringify([fence.sessionGroup, fence.runId, fence.reason]));
          await this.warnReclaim(fence, cause, 'reclaim_stop_unconfirmed');
          throw cause;
        }
      }
    } else if (scene.present && !scene.runId) {
      return 'unknown_identity';
    }
    if (!unfenced) await this.clear(fence);
    this.ttlPreparation.delete(group);
    this.reclaimStopPending.delete(JSON.stringify([fence.sessionGroup, fence.runId, fence.reason]));
    for (const name of ['reclaim_observation_unavailable', 'reclaim_stop_unconfirmed']) {
      this.reclaimWarnings.delete(JSON.stringify([fence.sessionGroup, fence.runId, fence.reason, name]));
    }
    await this.event('reclaim_done', { session_group: group, run_id: fence.runId, reason: fence.reason });
    return 'done';
  }

  async lastActivity(scene) {
    if (!finite(scene.createdAt)) throw error('INVALID_OBSERVATION', 'Runtime creation time is unknown');
    const reset = this.ttlReset.get(scene.sessionGroup);
    return Math.max(activityTime(await this.d.db.getLastActivity(scene.sessionGroup)), scene.createdAt,
      reset?.runId === scene.runId ? reset.at : 0);
  }

  prompt(name, ...args) {
    const value = this.d.prompts?.[name];
    const text = typeof value === 'function' ? value(...args) : value;
    if (typeof text !== 'string' || !text) throw error('DEPENDENCY_UNAVAILABLE', `Missing control prompt: ${name}`);
    return text;
  }

  async checkTtl(scene, context) {
    const group = scene.sessionGroup;
    if (modeOf(context) !== 'multi' || !group || group === 'origin' || !await this.allowed(group, context)) return;
    scene = await this.observe(group);
    if (!scene.present || !scene.ready) { this.ttlPreparation.delete(group); return; }
    const now = this.now(), last = await this.lastActivity(scene);
    const ttl = (context.configuration.hotTtlSeconds ?? 1800) * 1000;
    const preparation = this.ttlPreparation.get(group);
    if (preparation && (preparation.runId !== scene.runId || last > preparation.at)) {
      this.ttlPreparation.delete(group);
      return;
    }
    if (now - last < ttl) return;
    if (preparation) {
      const control = await this.d.db.getControlById(preparation.controlId);
      if (!control || !TERMINAL_CONTROLS.has(control.status)) return;
      this.ttlPreparation.delete(group);
      if (await this.idle(scene, context)) await this.beginReclaim(scene, 'ttl', context);
      return;
    }
    const range = await this.d.db.getUnsummarizedRange(group);
    if (range.count > 0) {
      const control = await this.d.db.insertControl(this.prompt('PRE_RECLAIM_SYNC_PROMPT'), {
        sessionGroup: group, requireIdle: true, appendAckSuffix: true, ackDeadlineAt: Math.floor((now + this.ackTimeoutMs) / 1000),
      });
      this.ttlPreparation.set(group, { controlId: control.id, runId: scene.runId, at: now });
    } else if (range.count === 0) await this.beginReclaim(scene, 'ttl', context);
    else throw error('INVALID_OBSERVATION', 'Invalid unsummarized count');
  }

  async checkEviction(scenes, context) {
    if (modeOf(context) !== 'multi' || context.transition || await this.d.db.getModeTransition() || await this.d.db.getDrainFence('*')) return;
    const fences = await this.d.db.listDrainFences();
    const demand = evictionDemand(scenes, await this.d.db.listPendingSessionGroups(), fences, context.configuration.capacity);
    if (!demand.need) return demand;
    const candidates = [];
    for (const scene of scenes) {
      if (!scene.present || !scene.ready || !scene.sessionGroup || scene.sessionGroup === 'origin' || scene.state !== 'idle' || fences.some(f => f.sessionGroup === scene.sessionGroup)) continue;
      candidates.push({ ...scene, last: await this.lastActivity(scene) });
    }
    candidates.sort((a, b) => a.last - b.last || a.sessionGroup.localeCompare(b.sessionGroup));
    let selected = 0;
    for (const scene of candidates) {
      if (selected >= demand.need) break;
      if (await this.beginReclaim(scene, 'evict', context)) selected++;
    }
    return { ...demand, selected };
  }

  async checkRotation(scene, context) {
    if (!await this.allowed(scene.sessionGroup, context)) return;
    scene = await this.observe(scene.sessionGroup);
    if (!scene.present || !scene.ready) return;
    const previous = this.sessions.get(scene.runId);
    if (previous && previous !== scene.sessionId) await this.event('rotate_done', { session_group: scene.sessionGroup, run_id: scene.runId, old_session_id: previous, session_id: scene.sessionId, reason: 'threshold' });
    this.sessions.set(scene.runId, scene.sessionId);
    const threshold = context.configuration.rotationThresholds?.[scene.runtime] ?? (scene.runtime === 'claude' ? 70 : scene.runtime === 'codex' ? 75 : null);
    if (!finite(scene.usagePercent) || threshold === null || scene.usagePercent < threshold) return;
    const key = JSON.stringify([scene.runId, scene.sessionId]), now = this.now();
    if (this.rotationSent.has(key) && now - this.rotationSent.get(key) < this.rotationCooldownMs) return;
    await this.d.db.insertControl(this.prompt('ROTATION_PROMPT', scene), { sessionGroup: modeOf(context) === 'single' ? null : scene.sessionGroup, bypassState: true, appendAckSuffix: false });
    this.rotationSent.set(key, now);
  }

  async reconcileConfiguration(context) {
    if (modeOf(context) !== 'multi') return;
    await this.each(await this.d.observe(context), async original => {
      if (!await this.allowed(original.sessionGroup, context)) return;
      const scene = await this.observe(original.sessionGroup);
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
      const targetBinding = await this.d.bindTarget(scene);
      await this.d.db.insertControl(this.prompt('CONFIG_RECLAIM_PROMPT', scene, expected), { sessionGroup: scene.sessionGroup, targetBinding,
        priority: 1, bypassState: true, appendAckSuffix: true, ackDeadlineAt: Math.floor((now + this.ackTimeoutMs) / 1000) });
      this.configurationSent.set(scene.runId, now);
    });
  }

  async checkSync(scenes, context) {
    const now = this.now();
    if (this.lastSyncCheck !== null && now - this.lastSyncCheck < this.syncCheckMs) return;
    if (context.transition || await this.d.db.getModeTransition() || await this.d.db.getDrainFence('*')) return;
    this.lastSyncCheck = now;
    await this.each(scenes, async scene => {
      if (!await this.allowed(scene.sessionGroup, context)) return;
      scene = await this.observe(scene.sessionGroup);
      if (!scene.present || !scene.ready) return;
      const single = modeOf(context) === 'single';
      const kind = single ? 'global' : 'group';
      const range = single ? await this.d.db.getGlobalUnsummarizedRange() : await this.d.db.getUnsummarizedRange(scene.sessionGroup);
      await this.syncScope(scene, kind, { count: range.count, firstAt: range.firstAt, nonempty: range.count > 0 }, context);
      if (!single && scene.sessionGroup === 'origin') {
        const backlog = await this.d.db.getOriginSyncBacklog();
        const times = backlog.groups.flatMap(g => [g.firstAt, g.firstCheckpointAt]).filter(v => v !== null && v !== undefined).map(activityTime);
        const rawTimes = backlog.groups.map(g => g.firstAt).filter(v => v !== null && v !== undefined).map(activityTime);
        await this.syncScope(scene, 'origin', { count: backlog.total,
          firstAt: times.length ? Math.min(...times) : null,
          alertFirstAt: rawTimes.length ? Math.min(...rawTimes) : null,
          nonempty: backlog.total > 0 || backlog.groups.some(g => g.pendingCheckpoints > 0) }, context);
      }
    });
  }

  async syncScope(scene, kind, range, context) {
    if (!Number.isInteger(range.count) || range.count < 0) throw error('INVALID_OBSERVATION', 'Invalid Sync backlog');
    const now = this.now(), config = context.configuration;
    const key = JSON.stringify([kind, scene.sessionGroup]);
    const min = (config.syncMinIntervalSeconds ?? 600) * 1000, max = (config.syncMaxIntervalSeconds ?? 21600) * 1000;
    const threshold = kind === 'origin' ? (config.originSyncThreshold ?? 50) : (config.syncThreshold ?? 15);
    const lag = range.firstAt === null || range.firstAt === undefined ? 0 : Math.max(0, now - activityTime(range.firstAt));
    const alertLag = kind === 'origin' ? (range.alertFirstAt === null || range.alertFirstAt === undefined ? 0 : Math.max(0, now - activityTime(range.alertFirstAt))) : lag;
    const alert = kind !== 'origin' && range.count > 4 * (config.syncBatchLimit ?? 200) || alertLag > 2 * max;
    if (alert && (!this.backlogSent.has(key) || now - this.backlogSent.get(key) >= 21600000) &&
        await this.allowed(modeOf(context) === 'single' ? null : 'origin', context)) {
      await this.d.db.insertControl(this.prompt('SYNC_BACKLOG_ALERT', kind === 'group' ? scene.sessionGroup : kind, range.count, Math.floor(alertLag / 1000)), {
        sessionGroup: modeOf(context) === 'single' ? null : 'origin', appendAckSuffix: false,
      });
      this.backlogSent.set(key, now);
    }
    if (!range.nonempty || this.syncSent.has(key) && now - this.syncSent.get(key) < min) return;
    const rotationThreshold = config.rotationThresholds?.[scene.runtime] ?? (scene.runtime === 'claude' ? 70 : 75);
    const due = range.count > threshold || lag >= max || kind !== 'origin' &&
      (this.syncRuns.get(key) !== scene.runId || finite(scene.usagePercent) && scene.usagePercent >= 0.8 * rotationThreshold);
    if (!due) return;
    if (typeof this.d.readSyncMarker !== 'function') throw error('DEPENDENCY_UNAVAILABLE', 'Sync marker reader is unavailable');
    const marker = await this.d.readSyncMarker({ runDir: scene.runDir, kind, currentRunId: scene.runId });
    if (!marker || typeof marker.held !== 'boolean' || typeof marker.stale !== 'boolean') throw error('INVALID_OBSERVATION', 'Invalid Sync marker result');
    if (marker.held && !marker.stale) return;
    await this.d.db.insertControl(this.prompt(kind === 'origin' ? 'ORIGIN_SYNC_PROMPT' : 'GROUP_SYNC_PROMPT'), {
      sessionGroup: modeOf(context) === 'single' ? null : scene.sessionGroup, priority: 2, appendAckSuffix: false,
    });
    this.syncSent.set(key, now);
    this.syncRuns.set(key, scene.runId);
  }

  async advanceRestarts(context) {
    if (context.transition || await this.d.db.getModeTransition()) return;
    await this.each(this.d.requests.read().filter(r => r.reason === 'upgrade'), async request => {
      const scenes = await this.d.observe(context);
      if (!Array.isArray(scenes) || scenes.some(s => typeof s.present !== 'boolean' || s.present && !s.runId)) {
        throw error('INVALID_OBSERVATION', 'Restart inventory contains an unknown runtime identity');
      }
      const remaining = scenes.filter(s => s.present && request.runIds.includes(s.runId));
      if (!remaining.length) {
        this.d.requests.remove(request.requestId);
        await this.event('restart_done', { requestId: request.requestId });
        return;
      }
      for (const scene of remaining) if (scene.ready) await this.beginReclaim(scene, 'upgrade', context);
    });
  }

  async warnManual(key, event) {
    if (this.manualWarnings.has(key)) return;
    await this.event(event.event, event);
    // The product callback queues delivery; never await channel I/O while holding
    // the lifecycle lock. A failed attempt is eligible again next round.
    this.manualWarnings.add(key);
    if (this.d.alert) Promise.resolve().then(() => this.d.alert(event)).catch(cause => {
      this.manualWarnings.delete(key);
      this.d.reportError?.(cause, { phase: 'manual_restart_alert' });
    });
  }

  async checkManualFences(context) {
    const requests = this.d.requests.read().filter(r => r.reason === 'manual_restart');
    const fences = (await this.d.db.listDrainFences()).filter(f => f.reason === 'manual_restart');
    const activeWarnings = new Set();
    for (const fence of fences) {
      const matches = requests.some(r => (r.mode === 'single' ? '*' : 'origin') === fence.sessionGroup && r.expectedRunId === fence.runId);
      if (!matches) {
        const key = JSON.stringify(['orphan', fence.sessionGroup, fence.runId]);
        activeWarnings.add(key);
        await this.warnManual(key, { event: 'manual_restart_orphan_fence', session_group: fence.sessionGroup, run_id: fence.runId, reason: 'intent_missing' });
      }
    }
    const transition = context.transition || await this.d.db.getModeTransition();
    for (const request of requests) {
      const group = request.mode === 'single' ? '*' : 'origin';
      const fence = await this.d.db.getDrainFence(group);
      if (modeOf(context) !== request.mode || transition ||
          request.mode === 'multi' && await this.d.db.getDrainFence('*') ||
          fence && (fence.reason !== 'manual_restart' || fence.runId !== request.expectedRunId)) {
        const key = JSON.stringify(['blocked', request.requestId]);
        activeWarnings.add(key);
        await this.warnManual(key, { event: 'manual_restart_blocked', requestId: request.requestId, reason: 'mode_or_fence_conflict' });
      }
    }
    for (const key of this.manualWarnings) {
      const executing = requests.some(request => key === JSON.stringify(['execution', request.requestId]));
      if (!activeWarnings.has(key) && !executing) this.manualWarnings.delete(key);
    }
    return requests;
  }

  async advanceManual(context) {
    const requests = await this.checkManualFences(context);
    await this.each(requests, async request => {
      try {
        const group = request.mode === 'single' ? '*' : 'origin';
        const target = await this.d.observeFixedTarget(request);
        if (!target || typeof target.present !== 'boolean') throw error('INVALID_OBSERVATION', 'Fixed target presence is unknown');
        let fence = await this.d.db.getDrainFence(group);
        if (modeOf(context) !== request.mode || context.transition || await this.d.db.getModeTransition() ||
            request.mode === 'multi' && await this.d.db.getDrainFence('*') ||
            fence && (fence.reason !== 'manual_restart' || fence.runId !== request.expectedRunId)) {
          const key = JSON.stringify(['blocked', request.requestId]);
          await this.warnManual(key, { event: 'manual_restart_blocked', requestId: request.requestId, reason: 'mode_or_fence_conflict' });
          return;
        }
        // The absent-target/absent-fence case is the crash-after-clear recovery path.
        if (target.present) {
          if (!fence) {
            await this.d.db.setDrainFence(group, { reason: 'manual_restart', runId: request.expectedRunId });
            fence = await this.d.db.getDrainFence(group);
            if (fence?.reason !== 'manual_restart' || fence.runId !== request.expectedRunId) throw error('FENCE_MISMATCH', 'Manual fence was not acquired');
          }
          await this.d.stopFixedTarget(request);
          const after = await this.d.observeFixedTarget(request);
          if (!after || after.present !== false) throw error('STOP_UNCONFIRMED', 'Manual target disappearance is unconfirmed');
        }
        const count = request.mode === 'single' ? await this.d.db.countGlobalRunningConversations() : await this.d.db.countRunningConversations('origin');
        if (count !== 0) return;
        if (fence) await this.clear(fence);
        this.d.requests.remove(request.requestId);
        await this.event('manual_restart_done', { requestId: request.requestId, run_id: request.expectedRunId, session_group: group });
      } catch (cause) {
        await this.warnManual(JSON.stringify(['execution', request.requestId]), {
          event: 'manual_restart_blocked', requestId: request.requestId,
          run_id: request.expectedRunId, reason: cause.code || 'EXECUTION_FAILED',
        });
        throw cause;
      }
    });
  }
}
