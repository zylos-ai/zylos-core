import { loadCoreModule } from './core-modules.js';

export function projectOrigin(sessionGroup, observation) {
  const { identity, status, usage } = observation;
  const state = !identity.present ? 'OFFLINE' : status.reason === 'starting' ? 'STARTING' : !status.valid ? 'UNKNOWN' : String(status.value.state || 'unknown').toUpperCase();
  return { running_tools: [], active_subagents: [], subagent_tools: [], last_message: null, last_prompt: null, updated_at: new Date().toISOString(), source: {}, state, sessionGroup, runId: identity.runId, sessionId: identity.sessionId,
    runtime: identity.runtime, identity, status, usage,
    sampledAt: status.sampledAt, reason: status.reason,
    confidence: status.valid ? 'HIGH' : 'LOW',
    evidence: status.valid ? ['core-session-reader'] : [],
    missing_evidence: status.valid ? [] : [status.reason || 'unknown'],
    suggested_action: status.valid ? null : 'Refresh current Origin state' };
}

export class CoreState {
  constructor({ load = loadCoreModule, onChange = () => {} } = {}) {
    this.load = load; this.onChange = onChange;
    this.snapshot = { running_tools: [], active_subagents: [], subagent_tools: [], source: {}, state: 'UNKNOWN', reason: 'not_sampled', identity: null, status: { valid: false }, usage: { valid: false }, runId: null, sessionId: null };
    this.costKey = null; this.pending = null;
  }
  refresh() {
    if (this.pending) return this.pending;
    this.pending = this._read().finally(() => { this.pending = null; });
    return this.pending;
  }
  async _read() {
    try {
      const [{ readSessionMode }, reader, paths] = await Promise.all([this.load('config.js'), this.load('session-state-reader.js'), this.load('session-group-paths.js')]);
      const { mode } = readSessionMode();
      const group = mode === 'multi' ? 'origin' : null;
      const observation = await reader.readSessionState(group, { freshnessMs: 5000 });
      this.snapshot = projectOrigin(group, observation);
      try {
      const groups = mode === 'multi' ? await paths.listGroupTmuxSessions() : [{ sessionGroup: null }];
      const identities = await Promise.all(groups.map(async ({ sessionGroup }) => {
        const live = await reader.readLiveIdentity(sessionGroup);
        if (!live.present || !live.runId || live.runtime === 'unknown') throw new Error('Unknown running identity');
        return [sessionGroup, live.runId, live.sessionId];
      }));
      this.costKey = observation.status.reason === 'identity_changed' || observation.identity.runtime === 'unknown' ? null : JSON.stringify(identities.sort((a,b) => String(a[0]).localeCompare(String(b[0]))));
      } catch { this.costKey = null; }
      this.accountUsage = await reader.readAccountUsage(observation.identity.runtime).catch(() => null);
    } catch (error) {
      this.costKey = null;
      this.accountUsage = null;
      this.snapshot = { running_tools: [], active_subagents: [], subagent_tools: [], source: {}, state: 'UNKNOWN', reason: error.code || 'read_failed', message: error.message, identity: null, status: { valid: false }, usage: { valid: false }, runId: null, sessionId: null };
    }
    this.onChange(this.snapshot);
    return this.snapshot;
  }
  getCurrentSessionId() { return this.snapshot.identity?.present && this.snapshot.status?.reason !== 'identity_changed' ? this.snapshot.sessionId : null; }
  getState() { return structuredClone(this.snapshot); }
  async currentTarget() {
    const snapshot = await this.refresh();
    if (!snapshot.identity?.present || !snapshot.identity.ready || !snapshot.runId || snapshot.status.reason === 'identity_changed') throw Object.assign(new Error('Current Origin identity is unavailable'), { code: 'target_unavailable' });
    return { ...snapshot.identity, sessionGroup: snapshot.sessionGroup };
  }
  start() { this.timer = setInterval(() => this.refresh(), 1000); this.timer.unref?.(); return this.refresh(); }
  async stop() { clearInterval(this.timer); await this.pending; }
}
