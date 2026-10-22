import { readHealthQuota } from './health-quota.js';

const SCHEDULING_FIELDS = ['cooldownUntil','restartFailureCount','lastRecoveryAt','recoveringStartedAt','unavailableSince','lastDownCheckAt','lastUserMessageRecoveryAt'];

export class HealthController {
  constructor({ store, engine, identity, fingerprint = () => null, quota = () => readHealthQuota({identity:identity(),zylosDir}), zylosDir, log = () => {}, onDrained = () => {}, drainEvents = () => {} }) {
    Object.assign(this,{store,engine,identity,fingerprint,quota,zylosDir,log,onDrained,drainEvents});
    this.reading = false;
    this.lastScreen = null;
    this.lastVerificationAt = 0;
    this.apply(store.read());
    engine.evidence = this;
    const scheduling = store.read().scheduling;
    if (scheduling) {
      for (const name of SCHEDULING_FIELDS) {
        if (Number.isFinite(scheduling[name]) && scheduling[name] >= 0) engine[name] = scheduling[name];
      }
    }
    // Persist synchronous scheduling changes without turning timer updates into
    // new health revisions, which would invalidate an in-flight heartbeat.
    for (const name of ['enterRateLimited','notifyUserMessage','onHeartbeatSuccess','onHeartbeatFailure','onProcessRestarted','runMaintenanceCycle','_expireRateLimitCooldown']) {
      const operation = engine[name].bind(engine);
      engine[name] = (...args) => {
        const result = operation(...args);
        try {
          this.persistScheduling();
        } catch {
          this.log('Health scheduling state unavailable; durable scheduling retained');
        }
        return result;
      };
    }
    for (const name of ['detectRateLimit','detectAuthFailure','detectApiError']) {
      const detect = engine.deps[name];
      if (!detect) continue;
      engine.deps[name] = () => {
        const before = this.captureFence();
        const first = fingerprint();
        const value = detect();
        const last = fingerprint();
        if (!this.validFence(before) || (first && last && first !== last)) return {detected:false};
        const state = this.store.read();
        if (value.detected && state.recovered?.screen_fingerprint && state.recovered.screen_fingerprint === last) return {detected:false};
        this.lastScreen = last;
        return value;
      };
    }
  }
  captureFence() {
    const identity = this.identity();
    return { revision:this.store.read().revision, pid:identity?.claude_pid??null,session:identity?.session_id??null,process:identity?.process_start??null };
  }
  notice() {
    try { return this.store.currentNotice({identity:this.identity(),quota:this.quota()}); }
    catch {
      this.log('Current quota unavailable; original failure notice retained');
      return this.store.read().notice;
    }
  }
  refresh() {
    const state=this.store.read();
    if(state.revision!==this.revision)this.apply(state);
  }
  persistScheduling() {
    const scheduling = Object.fromEntries(SCHEDULING_FIELDS.map(name => [name,this.engine[name]]));
    this.store.saveScheduling(scheduling,this.revision);
  }
  validFence(fence) {
    const current=this.captureFence();
    return fence && Object.keys(current).every(key=>current[key]===fence[key]);
  }
  apply(state) {
    this.revision=state.revision;
    this.engine.healthState=state.health;
    this.engine.healthReason=state.reason;
    this.engine.healthRevision=state.revision;
    if (state.health==='rate_limited' && !this.engine.cooldownUntil) this.engine.cooldownUntil=Math.floor(this.engine.now()/1000)+this.engine.rateLimitDefaultCooldown;
    if (state.health!=='rate_limited') this.engine._clearRateLimitCooldownTimer();
    if(state.health==='ok'||state.health==='rate_limited')this.engine._clearPostRestartProbeTimer();
  }
  transition(health,reason,kind='screen') {
    const result=this.store.transition(health,reason,{identity:this.identity(),kind,expectedRevision:this.revision,screenFingerprint:kind==='recovery'?this.fingerprint():this.lastScreen});
    if(result.accepted)this.revision=result.state.revision;
    else if(result.state.revision!==this.revision)this.apply(result.state);
    return result.accepted;
  }
  consume(event) {
    const result=this.store.consume(event,{identity:this.identity(),quota:this.quota()});
    this.apply(result.state);
    if(result.verify && this.engine.now()-this.lastVerificationAt>=60000) {
      this.lastVerificationAt=this.engine.now();
      if(!this.engine.deps.readHeartbeatPending())this.engine.enqueueHeartbeat('hook_evidence_unordered');
    }
    return result;
  }
  drain() {
    if(this.reading)return;
    this.reading=true;
    try {
      this.drainEvents();
    } catch {
      this.log('Health evidence storage unavailable; stream cursor retained');
    } finally {
      this.reading = false;
      try { this.onDrained(); }
      catch { this.log('Health notice worker unavailable; pending notices retained'); }
    }
  }
}
