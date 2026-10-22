import { initialHealthEvidence, reduceHealthEvidence, sanitizeHealthEvent, safeHealthReason, HEALTH_EVENT_MAX_AGE_MS } from './health-evidence.js';
import { randomUUID } from 'node:crypto';
import { enqueueFirstFailureNotice } from '../../comm-bridge/scripts/first-failure-notice.js';
import { currentOutageNotice } from './outage-notice.js';

/** All state and inbox writes are synchronous SQLite transactions owned by AM. */
export class HealthStore {
  constructor(db, { runtime = 'claude', initialHealth = 'ok', initialReason = '', now = Date.now, leaseMs = 30000 } = {}) {
    this.db = db; this.runtime = runtime; this.now = now;
    this.initial = initialHealthEvidence(initialHealth,initialReason);
    this.owner=randomUUID();this.leaseMs=leaseMs;
  }
  read() {
    const row = this.db.prepare('SELECT state_json FROM runtime_health_state WHERE runtime_id=?').get(this.runtime);
    return row ? JSON.parse(row.state_json) : structuredClone(this.initial);
  }
  currentNotice({identity,quota} = {}) {
    return this.db.transaction(() => {
      const state = this.read();
      const result = currentOutageNotice(state,identity,quota,this.now());
      if (result.annotation && JSON.stringify(result.annotation) !== JSON.stringify(state.outage_quota)) {
        const owned = this.claim(state);
        this.write({...owned,outage_quota:result.annotation});
      }
      return result.notice;
    }).immediate();
  }
  write(state) {
    this.db.prepare('INSERT INTO runtime_health_state(runtime_id,revision,state_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(runtime_id) DO UPDATE SET revision=excluded.revision,state_json=excluded.state_json,updated_at=excluded.updated_at').run(this.runtime,state.revision,JSON.stringify(state),this.now());
  }
  claim(state) {
    if(state.writer && state.writer.owner!==this.owner && state.writer.expires_at>this.now())throw new Error('Health writer lease held');
    state={...state,writer:{owner:this.owner,expires_at:this.now()+this.leaseMs}};
    this.write(state);return state;
  }
  pruneEvents() {
    // Keep replay-valid evidence and every pending event. Old replayed Hook
    // events fail freshness validation even after their dedup row expires.
    const cutoff=this.now()-HEALTH_EVENT_MAX_AGE_MS-60000;
    this.db.prepare("DELETE FROM runtime_health_events WHERE event_id IN (SELECT event_id FROM runtime_health_events WHERE status <> 'pending' AND processed_at < ? AND received_at < ? AND event_id NOT IN (SELECT json_extract(state_json,'$.evidence_id') FROM runtime_health_state WHERE json_extract(state_json,'$.evidence_id') IS NOT NULL) LIMIT 500)").run(cutoff,cutoff);
  }
  saveScheduling(scheduling, expectedRevision) {
    return this.db.transaction(() => {
      const prior = this.claim(this.read());
      if (prior.revision !== expectedRevision) return false;
      this.write({...prior,scheduling});
      return true;
    }).immediate();
  }
  consume(raw, { identity, quota, fallbackId } = {}) {
    const event = sanitizeHealthEvent(raw,fallbackId);
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT status FROM runtime_health_events WHERE event_id=?').get(event.event_id);
      if (existing && existing.status !== 'pending') return { state:this.read(),status:existing.status,reason:'duplicate' };
      this.db.prepare('INSERT OR IGNORE INTO runtime_health_events(event_id,source,runtime_generation,session_id,prompt_id,received_at,payload_json) VALUES(?,?,?,?,?,?,?)').run(event.event_id,event.source,event.runtime_generation??null,event.session_id??null,event.prompt_id??null,event.received_at,JSON.stringify(event));
      const prior = this.claim(this.read());
      const result = reduceHealthEvidence(prior,event,{identity,quota,now:this.now()});
      const healthChanged = result.state !== prior;
      if (result.status === 'processed' && ['stop','stop_failure'].includes(event.event)) {
        result.state = {...result.state,last_hook:{event_id:event.event_id,event:event.event,error:event.error,observed_at:event.received_at,runtime_generation:event.runtime_generation}};
      }
      if (result.state !== prior) {
        // Observing a Stop during recovery is telemetry, not new health proof.
        // It must not invalidate the heartbeat that produced that Stop.
        result.state = {...result.state,revision:prior.revision+(healthChanged?1:0)};
        this.write(result.state);
      }
      this.db.prepare('UPDATE runtime_health_events SET status=?,reason=?,processed_at=? WHERE event_id=?').run(result.status,result.reason,this.now(),event.event_id);
      enqueueFirstFailureNotice(this.db,{runtime:this.runtime,prior,state:result.state,identity,event,result});
      this.pruneEvents();
      return result;
    }).immediate();
  }
  transition(health, reason, { identity, kind = 'screen', expectedRevision, screenFingerprint = null } = {}) {
    return this.db.transaction(() => {
      const prior = this.claim(this.read());
      const eventId = randomUUID();
      const receivedAt = this.now();
      const payload = {schema_version:1,event_id:eventId,source:kind,runtime_generation:identity?.runtime_generation??null,session_id:identity?.session_id??null,received_at:receivedAt,screen_fingerprint:screenFingerprint,health,reason:safeHealthReason(health,reason),expected_revision:expectedRevision??null};
      const finish = (accepted, state, resultReason) => {
        this.db.prepare('INSERT INTO runtime_health_events(event_id,source,runtime_generation,session_id,prompt_id,received_at,payload_json,status,reason,processed_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(eventId,kind,payload.runtime_generation,payload.session_id,null,receivedAt,JSON.stringify(payload),accepted?'processed':'ignored',resultReason,this.now());
        this.pruneEvents();
        return {accepted,state};
      };
      if (expectedRevision !== undefined && expectedRevision !== prior.revision) return finish(false,prior,'stale_revision');
      // A screen without proven turn ownership cannot replace valid Hook evidence.
      const currentHook = prior.source === 'hook' && prior.runtime_generation === identity?.runtime_generation && prior.session_id === identity?.session_id && prior.hook_process_start === identity?.process_start && prior.hook_pid === identity?.claude_pid;
      if (kind === 'screen' && currentHook && (!prior.hook_ok || health === 'rate_limited')) return finish(false,prior,'hook_priority');
      const generation = identity?.runtime_generation ?? prior.runtime_generation;
      const session = identity?.session_id ?? prior.session_id;
      const next = { ...prior, health, reason:safeHealthReason(health,reason), runtime_generation:generation,session_id:session,source:kind,evidence_id:eventId,revision:prior.revision+1 };
      delete next.notice;
      if (health !== prior.health) delete next.scheduling;
      if (health !== 'ok' && prior.health === 'ok') next.episode++;
      if (kind === 'recovery') {
        next.recovered = { runtime_generation:generation,session_id:session,revision:next.revision,evidence_id:prior.evidence_id,screen_fingerprint:screenFingerprint };
      }
      this.write(next);
      return finish(true,next,'accepted');
    }).immediate();
  }
}
