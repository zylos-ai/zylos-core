import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initialHealthEvidence, reduceHealthEvidence, sanitizeHealthEvent, safeHealthReason } from './health-evidence.js';
import { durableJson, runtimeRoot } from './runtime-generation.js';
import { currentOutageNotice } from './outage-notice.js';

// AM is the only writer. Health, replay marker and pending reply commit together.
export class HealthStore {
  constructor({ runtime = 'claude', zylosDir = runtimeRoot(), initialHealth = 'ok', initialReason = '', now = Date.now, freezeNotice = () => null } = {}) {
    this.runtime = runtime; this.now = now; this.freezeNotice = freezeNotice;
    this.file = path.join(zylosDir, 'activity-monitor', 'runtime-health', `${runtime}.json`);
    this.initial = initialHealthEvidence(initialHealth, initialReason);
  }
  read() {
    try {
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (state.version !== 1 || !Number.isSafeInteger(state.revision)) throw new Error('Invalid health state');
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(this.initial);
      throw error;
    }
  }
  write(state) { durableJson(this.file, state); }
  currentNotice({ identity, quota } = {}) {
    const state = this.read();
    const result = currentOutageNotice(state, identity, quota, this.now());
    if (result.annotation && JSON.stringify(result.annotation) !== JSON.stringify(state.outage_quota)) this.write({ ...state, outage_quota: result.annotation });
    return result.notice;
  }
  saveScheduling(scheduling, expectedRevision) {
    const state = this.read();
    if (state.revision !== expectedRevision) return false;
    this.write({ ...state, scheduling });
    return true;
  }
  updatePending(eventId, patch) {
    const state = this.read();
    if (state.pending_notice?.event_id !== eventId) return false;
    this.write({ ...state, pending_notice: { ...state.pending_notice, ...patch } });
    return true;
  }
  consume(raw, { identity, quota, fallbackId } = {}) {
    const event = sanitizeHealthEvent(raw, fallbackId);
    const prior = this.read();
    if (!['stop', 'stop_failure'].includes(event.event)) return { state: prior, status: 'ignored', reason: 'nonterminal_event' };
    const result = reduceHealthEvidence(prior, event, { identity, quota, now: this.now() });
    if (result.status !== 'processed') return result;
    if (event.received_at <= (prior.last_processed?.received_at ?? 0)) return { state: prior, status: 'ignored', reason: 'replay' };
    const healthChanged = result.state !== prior;
    result.state = { ...result.state, revision: prior.revision + (healthChanged ? 1 : 0),
      last_processed: { received_at: event.received_at, event_id: event.event_id },
      last_hook: { event_id: event.event_id, event: event.event, error: event.error, observed_at: event.received_at,
        session_id:event.session_id, claude_pid:event.claude_pid, process_start:event.process_start } };
    const pending = this.freezeNotice({ runtime: this.runtime, state: result.state, identity, event, result });
    if (pending) result.state.pending_notice = pending;
    this.write(result.state);
    return result;
  }
  transition(health, reason, { identity, kind = 'screen', expectedRevision, screenFingerprint = null } = {}) {
    const prior = this.read();
    if (expectedRevision !== undefined && expectedRevision !== prior.revision) return { accepted: false, state: prior };
    const currentHook = prior.source === 'hook' && prior.session_id === identity?.session_id && prior.hook_process_start === identity?.process_start && prior.hook_pid === identity?.claude_pid;
    if (kind === 'screen' && currentHook && (!prior.hook_ok || health === 'rate_limited')) return { accepted: false, state: prior };
    const next = { ...prior, health, reason: safeHealthReason(health, reason), session_id: identity?.session_id ?? prior.session_id,
      hook_process_start:identity?.process_start ?? prior.hook_process_start, hook_pid:identity?.claude_pid ?? prior.hook_pid,
      source: kind, evidence_id: randomUUID(), revision: prior.revision + 1 };
    delete next.notice;
    if (health !== prior.health) delete next.scheduling;
    if (health !== 'ok' && prior.health === 'ok') next.episode++;
    if (kind === 'recovery') next.recovered = { session_id: next.session_id, revision: next.revision, evidence_id: prior.evidence_id, screen_fingerprint: screenFingerprint };
    this.write(next);
    return { accepted: true, state: next };
  }
}
