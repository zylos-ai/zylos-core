import { accountUsageCache as sharedAccountUsageCache } from './account-usage-cache.js';
import { loadCoreModule } from './core-modules.js';
import { createSessionObservations } from './session-observations.js';
import { Sanitizer } from './sanitizer.js';
import { isDeepStrictEqual } from 'node:util';

const { runtimesWith } = await loadCoreModule('runtime/descriptors.js');

const publicIdentity = identity => Object.fromEntries(
  ['present', 'tmuxName', 'runId', 'createdAt', 'runtime', 'ready', 'sessionId']
    .map(key => [key, identity?.[key] ?? null])
);
const VOLATILE_KEYS = new Set(['updated_at', 'sampledAt', 'sampled_at', 'last_check', 'inactive_seconds']);
function stableBusinessValue(value) {
  if (Array.isArray(value)) return value.map(stableBusinessValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !VOLATILE_KEYS.has(key))
    .map(([key, item]) => [key, stableBusinessValue(item)]));
}
function businessSource(projected, observation, accountUsage, accountRecord) {
  const usage = observation?.usage?.valid ? observation.usage.value : null;
  return stableBusinessValue({
    projected,
    contextPct: usage?.context_window?.used_percentage ?? (usage?.contextUsage?.ceiling > 0 ? usage.contextUsage.used / usage.contextUsage.ceiling * 100 : null),
    rateLimitPct: accountUsage?.five_hour?.used_percentage ?? accountUsage?.fiveHour?.usedPercentage ?? null,
    rateLimit7dPct: accountUsage?.seven_day?.used_percentage ?? accountUsage?.sevenDay?.usedPercentage ?? null,
    accountRecord: accountRecord ? { live: accountRecord.live,
      ...(accountRecord.live === false ? { recordedAt: accountRecord.recordedAt } : {}) } : null,
  });
}
export function projectOrigin(sessionGroup, observation, sanitizer = new Sanitizer(process.env.ZYLOS_DIR || process.cwd()), facts = null, view = null) {
  const { identity, status, usage } = observation;
  let state = !identity.present ? 'OFFLINE' : status.reason === 'starting' ? 'STARTING' : !status.valid ? 'UNKNOWN' : String(status.value.state || 'unknown').toUpperCase();
  const tools = status.valid && Array.isArray(status.value.active_tool_details) ? status.value.active_tool_details.map(tool => ({
    tool_use_id: tool.id,
    tool_name: tool.name,
    tool_detail: sanitizer.sanitizeToolDetail(tool.name, tool.input),
    started_at: Number.isFinite(tool.startedAt) ? new Date(tool.startedAt).toISOString() : null,
  })) : [];
  const targetValid = identity.present && status.reason !== 'identity_changed';
  let reason = status.reason;
  if (view !== null) {
    if (facts?.transitionOpen) state = 'SWITCHING';
    else if (facts?.fenced) state = 'RECLAIMING';
    else if (['sleeping', 'waking', 'wake_overdue', 'auth_wait', 'rate_wait'].includes(view.state)) state = view.state.toUpperCase();
    else if (view.state === 'need_unreadable') { state = 'UNKNOWN'; reason = 'origin_need_unreadable'; }
  }
  return { running_tools: tools, active_subagents: [], subagent_tools: [], last_message: null, last_prompt: null, updated_at: new Date().toISOString(), source: {}, state, sessionGroup, runId: targetValid ? identity.runId : null, sessionId: targetValid ? identity.sessionId : null,
    runtime: identity.runtime, ready: targetValid && identity.ready === true,
    sampledAt: status.sampledAt, reason,
    confidence: status.valid ? 'HIGH' : 'LOW',
    evidence: status.valid ? ['core-session-reader'] : [],
    missing_evidence: status.valid ? [] : [status.reason || 'unknown'],
    suggested_action: status.valid ? null : 'Refresh current Origin state' };
}

export class CoreState {
  constructor({ onChange = () => {}, zylosDir = process.env.ZYLOS_DIR || process.cwd(), accountUsageCache = sharedAccountUsageCache, sessionObservations = createSessionObservations({ zylosDir }), onSample = () => {} } = {}) {
    this.sessionObservations = sessionObservations;
    this.onSample = onSample;
    this.accountUsageCache = accountUsageCache;
    this.onChange = onChange;
    this.zylosDir = zylosDir;
    this.sanitizer = new Sanitizer(zylosDir);
    this.snapshot = { running_tools: [], active_subagents: [], subagent_tools: [], source: {}, state: 'UNKNOWN', reason: 'not_sampled', ready: false, runId: null, sessionId: null };
    this.observation = null;
    this.lastSource = null;
    this.lastSessionMode = undefined;
    this.lastSessionGroup = null;
    this.costKey = null; this.pending = null;
    this.watched = false; this.started = false;
  }
  async refresh({ fresh = false } = {}) {
    if (this.pending) {
      if (!fresh) return this.pending;
      await this.pending;
      return this.refresh({ fresh: true });
    }
    this.pending = this._read({ fresh }).finally(() => { this.pending = null; });
    return this.pending;
  }
  async _read({ fresh = false } = {}) {
    try {
      const { mode, group, observations, reader } = await this.sessionObservations.get({ fresh });
      this.lastSessionMode = mode;
      this.lastSessionGroup = group;
      const observation = observations.get(group);
      try {
        const identities = [...observations].filter(([sessionGroup, item]) => sessionGroup === group || item.identity.present)
          .map(([sessionGroup, item]) => {
            const live = item.identity;
            if (!live.present || !live.runId || live.runtime === 'unknown' || item.status.reason === 'identity_changed') throw new Error('Unknown running identity');
            return [sessionGroup, live.runId, live.sessionId];
          });
        this.costKey = JSON.stringify(identities.sort((a,b) => String(a[0]).localeCompare(String(b[0]))));
      } catch { this.costKey = null; }
      let targetRuntime = observation.identity.runtime, facts = null, view = null;
      if (mode === 'multi') {
        if (!observation.identity.present) {
          try { targetRuntime = await this.sessionObservations.resolveOfflineRuntime('origin'); } catch { targetRuntime = null; }
        }
        let health = null;
        try { health = targetRuntime ? await reader.readRuntimeHealth(targetRuntime) : null; } catch { /* Unreadable health is not an authentication block. */ }
        if (!observation.identity.present || health?.health === 'auth_failed') {
          const { readOriginFacts, describeOrigin } = await loadCoreModule('origin-presence.js');
          const nowSec = Math.floor(Date.now() / 1000);
          facts = await readOriginFacts({ zylosDir: this.zylosDir, nowSec });
          view = describeOrigin({ view: 'multi', origin: { presence: !observation.identity.present ? 'not_running' : observation.identity.ready ? 'running' : 'starting' },
            originNeed: facts.originNeed, runtimeHealth: { [targetRuntime]: health }, targetRuntime, nowSec });
        }
      }
      if (mode !== 'multi' && !observation.identity.present) {
        try { targetRuntime = await this.sessionObservations.resolveOfflineRuntime(null); } catch { targetRuntime = null; }
      }
      const accountRecord = runtimesWith('accountQuota').includes(targetRuntime)
        ? await this.accountUsageCache.read(targetRuntime, { allowRecorded: true }, reader).catch(() => null) : null;
      const accountUsage = accountRecord?.value ?? null;
      const projected = projectOrigin(group, observation, this.sanitizer, facts, view);
      const source = businessSource(projected, observation, accountUsage, accountRecord);
      this.observation = observation;
      this.accountUsage = accountUsage;
      const changed = !isDeepStrictEqual(source, this.lastSource);
      this.lastSource = source;
      this.snapshot = projected;
      this.onSample(this.snapshot);
      if (changed) this.onChange(this.snapshot);
    } catch (error) {
      this.costKey = null;
      this.accountUsage = null;
      this.observation = null;
      const source = { error: { code: error.code || 'read_failed', message: error.message } };
      if (!isDeepStrictEqual(source, this.lastSource)) {
        this.lastSource = source;
        this.snapshot = { running_tools: [], active_subagents: [], subagent_tools: [], source: {}, state: 'UNKNOWN', reason: source.error.code, message: source.error.message, ready: false, runId: null, sessionId: null, sessionGroup: this.lastSessionMode === undefined ? undefined : this.lastSessionGroup };
        this.onChange(this.snapshot);
      }
      this.onSample(this.snapshot);
    }
    return this.snapshot;
  }
  getCurrentSessionId() { return this.observation?.identity?.present && this.observation?.status?.reason !== 'identity_changed' ? this.observation.identity.sessionId : null; }
  getSingleSessionId() { return this.snapshot.sessionGroup === null ? this.getCurrentSessionId() : null; }
  getState() { return structuredClone(this.snapshot); }
  getLaunchConfig() { return this.observation?.identity?.present && this.observation?.status?.reason !== 'identity_changed' && this.observation.identity.launchConfig ? structuredClone(this.observation.identity.launchConfig) : null; }
  getUsageObservation() { return this.observation?.usage ? structuredClone(this.observation.usage) : { valid: false }; }
  async currentTarget() {
    await this.refresh({ fresh: true });
    const identity = this.observation?.identity;
    if (!identity?.present || !identity.ready || !identity.runId || this.observation?.status?.reason === 'identity_changed') throw Object.assign(new Error('Current Origin identity is unavailable'), { code: 'target_unavailable' });
    return { ...publicIdentity(identity), sessionGroup: this.snapshot.sessionGroup };
  }
  setWatched(watched) {
    if (this.watched === watched) return;
    this.watched = watched;
    if (this.started) this._schedule();
  }
  _schedule() {
    clearTimeout(this.timer);
    if (!this.started || !this.watched) return;
    this.timer = setTimeout(() => {
      // Schedule from observation start, sharing a bounded fleet sampling round.
      this._schedule();
      this.refresh();
    }, 2500);
    this.timer.unref?.();
  }
  start() { this.started = true; this._schedule(); return this.watched ? this.refresh() : Promise.resolve(this.snapshot); }
  async stop() { this.started = false; clearTimeout(this.timer); await this.pending; }
}
