import { loadCoreModule } from './core-modules.js';
import { Sanitizer } from './sanitizer.js';
import { isDeepStrictEqual } from 'node:util';

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
function businessSource(projected, observation, accountUsage) {
  const usage = observation?.usage?.valid ? observation.usage.value : null;
  return stableBusinessValue({
    projected,
    contextPct: usage?.context_window?.used_percentage ?? (usage?.contextUsage?.ceiling > 0 ? usage.contextUsage.used / usage.contextUsage.ceiling * 100 : null),
    rateLimitPct: accountUsage?.five_hour?.used_percentage ?? accountUsage?.fiveHour?.usedPercentage ?? null,
    rateLimit7dPct: accountUsage?.seven_day?.used_percentage ?? accountUsage?.sevenDay?.usedPercentage ?? null,
  });
}
export function projectOrigin(sessionGroup, observation, sanitizer = new Sanitizer(process.env.ZYLOS_DIR || process.cwd())) {
  const { identity, status, usage } = observation;
  const state = !identity.present ? 'OFFLINE' : status.reason === 'starting' ? 'STARTING' : !status.valid ? 'UNKNOWN' : String(status.value.state || 'unknown').toUpperCase();
  const tools = status.valid && Array.isArray(status.value.active_tool_details) ? status.value.active_tool_details.map(tool => ({
    tool_use_id: tool.id,
    tool_name: tool.name,
    tool_detail: sanitizer.sanitizeToolDetail(tool.name, tool.input),
    started_at: Number.isFinite(tool.startedAt) ? new Date(tool.startedAt).toISOString() : null,
  })) : [];
  const targetValid = identity.present && status.reason !== 'identity_changed';
  return { running_tools: tools, active_subagents: [], subagent_tools: [], last_message: null, last_prompt: null, updated_at: new Date().toISOString(), source: {}, state, sessionGroup, runId: targetValid ? identity.runId : null, sessionId: targetValid ? identity.sessionId : null,
    runtime: identity.runtime, ready: targetValid && identity.ready === true,
    sampledAt: status.sampledAt, reason: status.reason,
    confidence: status.valid ? 'HIGH' : 'LOW',
    evidence: status.valid ? ['core-session-reader'] : [],
    missing_evidence: status.valid ? [] : [status.reason || 'unknown'],
    suggested_action: status.valid ? null : 'Refresh current Origin state' };
}

export class CoreState {
  constructor({ onChange = () => {}, zylosDir = process.env.ZYLOS_DIR || process.cwd() } = {}) {
    this.onChange = onChange;
    this.sanitizer = new Sanitizer(zylosDir);
    this.snapshot = { running_tools: [], active_subagents: [], subagent_tools: [], source: {}, state: 'UNKNOWN', reason: 'not_sampled', ready: false, runId: null, sessionId: null };
    this.observation = null;
    this.lastSource = null;
    this.lastSessionMode = undefined;
    this.lastSessionGroup = null;
    this.costKey = null; this.pending = null;
  }
  refresh() {
    if (this.pending) return this.pending;
    this.pending = this._read().finally(() => { this.pending = null; });
    return this.pending;
  }
  async _read() {
    try {
      const [{ readSessionMode }, reader, paths] = await Promise.all([loadCoreModule('config.js'), loadCoreModule('session-state-reader.js'), loadCoreModule('session-group-paths.js')]);
      const { mode } = readSessionMode();
      if (!['single', 'multi'].includes(mode)) throw Object.assign(new Error('Session mode is unavailable'), { code: 'mode_unavailable' });
      const group = mode === 'multi' ? 'origin' : null;
      this.lastSessionMode = mode;
      this.lastSessionGroup = group;
      const observation = await reader.readSessionState(group, { freshnessMs: 5000 });
      try {
      const groups = mode === 'multi' ? await paths.listGroupTmuxSessions() : [{ sessionGroup: null }];
      const identities = await Promise.all(groups.map(async ({ sessionGroup }) => {
        const live = sessionGroup === group ? observation.identity : await reader.readLiveIdentity(sessionGroup);
        if (!live.present || !live.runId || live.runtime === 'unknown') throw new Error('Unknown running identity');
        return [sessionGroup, live.runId, live.sessionId];
      }));
      this.costKey = observation.status.reason === 'identity_changed' || observation.identity.runtime === 'unknown' ? null : JSON.stringify(identities.sort((a,b) => String(a[0]).localeCompare(String(b[0]))));
      } catch { this.costKey = null; }
      const accountUsage = await reader.readAccountUsage(observation.identity.runtime).catch(() => null);
      const projected = projectOrigin(group, observation, this.sanitizer);
      const source = businessSource(projected, observation, accountUsage);
      this.observation = observation;
      this.accountUsage = accountUsage;
      if (!isDeepStrictEqual(source, this.lastSource)) {
        this.lastSource = source;
        this.snapshot = projected;
        this.onChange(this.snapshot);
      }
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
    }
    return this.snapshot;
  }
  getCurrentSessionId() { return this.observation?.identity?.present && this.observation?.status?.reason !== 'identity_changed' ? this.observation.identity.sessionId : null; }
  getState() { return structuredClone(this.snapshot); }
  getUsageObservation() { return this.observation?.usage ? structuredClone(this.observation.usage) : { valid: false }; }
  async currentTarget() {
    await this.refresh();
    const identity = this.observation?.identity;
    if (!identity?.present || !identity.ready || !identity.runId || this.observation?.status?.reason === 'identity_changed') throw Object.assign(new Error('Current Origin identity is unavailable'), { code: 'target_unavailable' });
    return { ...publicIdentity(identity), sessionGroup: this.snapshot.sessionGroup };
  }
  start() { this.timer = setInterval(() => this.refresh(), 1000); this.timer.unref?.(); return this.refresh(); }
  async stop() { clearInterval(this.timer); await this.pending; }
}
