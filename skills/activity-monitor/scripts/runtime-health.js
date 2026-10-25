import { HealthStore } from './health-store.js';
import { safeHealthReason } from './health-evidence.js';
import { parseSessionGroup } from '../../comm-bridge/scripts/c4-session-group.js';

const RUNTIME = /^[a-z][a-z0-9-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST = /^sa-\d+-[0-9a-f]{12}$/;
const RESTRICTED = new Set(['rate_limited', 'unavailable', 'recovering', 'down']);
export const recoveryBackoff = n => n <= 0 ? 0 : Math.min(3600, 60 * 5 ** (n - 1));
export const normalizeHealth = health => ['ok', 'rate_limited', 'auth_failed'].includes(health) ? health : 'unavailable';

/** One recovery gate for registration, background demand and inbound routing. */
export function recoveryEligibility(state, { runtime, cache = null, nowMs = Date.now() } = {}) {
  if (state.health === 'ok') return { eligible: false, code: 'not_restricted' };
  if (state.health === 'auth_failed') return { eligible: false, code: 'auth_blocked' };
  if (!RESTRICTED.has(state.health)) return { eligible: false, code: 'invalid_request' };
  const budget = state.scheduling ?? {}, now = Math.floor(nowMs / 1000);
  if (state.health === 'rate_limited' && budget.cooldownUntil > now) {
    return { eligible: false, code: 'rate_limit_cooldown', notBefore: budget.cooldownUntil * 1000 };
  }
  const health = normalizeHealth(state.health), reason = state.reason || health;
  if (cache?.version === 2 && cache.runtime === runtime && cache.health === health &&
      cache.reason === reason && cache.expiresAt > nowMs) {
    return { eligible: false, code: 'probe_cache', notBefore: cache.expiresAt };
  }
  const down = state.health === 'down';
  const last = (down ? budget.lastDownCheckAt : budget.lastRecoveryAt) || 0;
  const accelerated = (budget.lastUserMessageRecoveryAt || 0) > last;
  const due = last + (down ? 3600 : recoveryBackoff(budget.restartFailureCount || 0));
  if (!accelerated && now < due) {
    return { eligible: false, code: down ? 'down_retry_interval' : 'attempt_backoff', notBefore: due * 1000 };
  }
  return { eligible: true, accelerated };
}

/** Return matching facts only after both observations identify the same run. */
export function classifyRecoveryResult({ runtime, runId, current, terminal, matches = {} }) {
  if (!current || current.runtime !== runtime || current.runId !== runId || terminal === 'STALE_TARGET') return 'stale';
  if (terminal === 'done') return 'ok';
  if (!['failed','timeout','cancelled','superseded'].includes(terminal)) return 'pending';
  if (matches.rateLimit?.detected) return 'rate_limited';
  if (matches.authFailure?.detected) return 'auth_error';
  return 'other';
}

/** Rebuilt every tick; a failed authoritative read propagates, never becomes empty. */
export async function aggregateRuntimeDemand({ mode, pendingGroups, fences = [], resolveTargetRuntime, baselineRuntime }) {
  const result = new Map();
  const blocked = new Set(fences.map(row => row.sessionGroup));
  if (blocked.has('*')) return result;
  for (const item of pendingGroups) {
    const group = mode === 'single' ? 'origin' : item.sessionGroup;
    if (blocked.has(group)) continue;
    const runtime = mode === 'single' ? baselineRuntime : await resolveTargetRuntime(group);
    if (!RUNTIME.test(runtime)) throw new Error('Invalid resolved runtime');
    if (!result.has(runtime)) result.set(runtime, new Set());
    result.get(runtime).add(group);
  }
  return result;
}

/** Runtime health writes share one serial section, including hook and budget writes. */
export class RuntimeHealthCoordinator {
  constructor({ zylosDir, now = Date.now, readMode, resolveTargetRuntime, listScenes,
    probeInFlight = () => false, readNegativeCache = () => null, clearNegativeCache = () => {},
    freezeNotice, log = () => {}, createStore } = {}) {
    Object.assign(this, { zylosDir, now, readMode, resolveTargetRuntime, listScenes, probeInFlight,
      readNegativeCache, clearNegativeCache, freezeNotice, log });
    this.createStore = createStore ?? (runtime => new HealthStore({ runtime, zylosDir, now, freezeNotice, log }));
    this.stores = new Map();
    this.queues = new Map();
    this.associations = new Map();
    this.authRecoveries = new Map();
  }
  store(runtime) {
    if (typeof runtime !== 'string' || !RUNTIME.test(runtime)) throw new TypeError('Invalid runtime');
    if (!this.stores.has(runtime)) this.stores.set(runtime, this.createStore(runtime));
    return this.stores.get(runtime);
  }
  serial(runtime, operation) {
    if (typeof runtime !== 'string' || !RUNTIME.test(runtime)) return Promise.reject(new TypeError('Invalid runtime'));
    const previous = this.queues.get(runtime) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    this.queues.set(runtime, pending);
    pending.finally(() => { if (this.queues.get(runtime) === pending) this.queues.delete(runtime); }).catch(() => {});
    return pending;
  }
  restore(runtime) {
    return this.serial(runtime, () => {
      const store = this.store(runtime), state = store.read();
      if (state.health === 'rate_limited' && state.scheduling.cooldownUntil > 0 && state.scheduling.cooldownUntil <= Math.floor(this.now() / 1000)) {
        state.scheduling.cooldownUntil = 0;
        store.write(state);
      }
      return state;
    });
  }
  registerStartAttempt(request) {
    const envelope = {version:1,type:'start_attempt',requestId:typeof request?.requestId === 'string' ? request.requestId : null};
    const reject = (code, notBefore) => ({...envelope,ok:false,code,...(notBefore === undefined ? {} : {notBefore})});
    if (request?.version !== 1 || request.type !== 'start_attempt' || !REQUEST.test(request.requestId) ||
        typeof request.runtime !== 'string' || !RUNTIME.test(request.runtime) || !UUID.test(request.runId) ||
        request.sessionGroup === 'origin' || !parseSessionGroup(request.sessionGroup)) return Promise.resolve(reject('invalid_request'));
    const runtime = request.runtime;
    return this.serial(runtime, async () => {
      if (await this.readMode() !== 'multi' || await this.resolveTargetRuntime(request.sessionGroup) !== runtime) return reject('invalid_request');
      const store = this.store(runtime);
      let state;
      try { state = store.read(); } catch { return {...envelope,ok:true,result:'not_restricted'}; }
      if (state.health === 'ok') return {...envelope,ok:true,result:'not_restricted'};
      if (state.health === 'auth_failed') return reject('auth_blocked');
      if ((await this.listScenes()).some(scene => scene.runtime === runtime)) return reject('scene_present');
      if (await this.probeInFlight(runtime)) return reject('probe_inflight');
      const nowMs = this.now(), now = Math.floor(nowMs / 1000);
      const cache = await this.readNegativeCache(runtime, state);
      const gate = recoveryEligibility(state, { runtime, cache, nowMs });
      if (!gate.eligible) return reject(gate.code, gate.notBefore);
      const next = structuredClone(state);
      if (state.health === 'down') next.scheduling.lastDownCheckAt = now;
      else { next.scheduling.restartFailureCount++; next.scheduling.lastRecoveryAt = now; }
      try { store.write(next); } catch { return reject('health_write_failed'); }
      this.associations.set(runtime, {sessionGroup:request.sessionGroup,runId:request.runId});
      return {...envelope,ok:true,result:'registered',reason:gate.accelerated ? 'user_message' : 'recovery_due'};
    });
  }
  notifyUserMessage(runtime) {
    return this.serial(runtime, async () => {
      const store = this.store(runtime), state = store.read(), now = Math.floor(this.now() / 1000);
      if (state.health === 'ok' || now - state.scheduling.lastUserMessageRecoveryAt < 60) return false;
      const budget = state.scheduling;
      budget.lastUserMessageRecoveryAt = now;
      if (state.health === 'unavailable' || state.health === 'recovering') { budget.restartFailureCount = 0; budget.lastRecoveryAt = 0; }
      else if (state.health === 'down') budget.lastDownCheckAt = 0;
      else if (state.health === 'rate_limited') budget.cooldownUntil = 0;
      store.write(state);
      if (state.health === 'unavailable' || state.health === 'recovering') this.associations.delete(runtime);
      await this.clearNegativeCache(runtime);
      return true;
    });
  }
  consumeHook(runtime, event, options) {
    return this.serial(runtime, () => {
      const store = this.store(runtime), before = store.read();
      const result = store.consume(event, options);
      if (result.status === 'processed' && (result.state.health === 'ok' || result.state.health === 'auth_failed' ||
          (before.health !== 'rate_limited' && result.state.health === 'rate_limited'))) this.associations.delete(runtime);
      if (result.status === 'processed' && event.event === 'stop_failure' && event.error === 'authentication_failed') this.authRecoveries.delete(runtime);
      return result;
    });
  }
  applyScreenEvidence({runtime,runId,current,matches,identity}) {
    return this.serial(runtime, () => {
      if (!current || current.runtime !== runtime || current.runId !== runId) return false;
      const store=this.store(runtime), state=store.read();
      if (state.source === 'hook' && state.session_id === identity?.session_id && state.hook_pid === identity?.claude_pid && !state.hook_ok) return false;
      const now=Math.floor(this.now()/1000);
      if (matches.rateLimit?.detected) {
        if(state.health !== 'rate_limited') state.scheduling.restartFailureCount=0;
        state.health='rate_limited';state.reason=safeHealthReason('rate_limited',matches.rateLimit.reason);state.rateLimitActive=true;
        state.scheduling.cooldownUntil=matches.rateLimit.cooldownUntil || now+3600;
        state.scheduling.rateLimitResetTime=matches.rateLimit.resetTime || '';
      } else if (matches.authFailure?.detected) {
        state.health='auth_failed';state.reason='authentication_failed';
      } else return false;
      state.source='screen';state.revision++;store.write(state);this.associations.delete(runtime);
      if(state.health==='auth_failed')this.authRecoveries.delete(runtime);
      return true;
    });
  }
  markProbeQueued(runtime) {
    return this.serial(runtime, () => {
      const store = this.store(runtime), state = store.read();
      const field = state.health === 'down' ? 'lastDownCheckAt' : 'lastRecoveryAt';
      state.scheduling[field] = Math.floor(this.now() / 1000);
      store.write(state);
    });
  }
  applyProbeResult(input) {
    return this.serial(input.runtime, () => {
      let classification = classifyRecoveryResult(input);
      if (classification === 'stale' || classification === 'pending') return {classification};
      const runtime = input.runtime, store = this.store(runtime), state = store.read();
      const currentHook = input.terminal !== 'done' && input.identity && state.source === 'hook' && !state.hook_ok &&
        state.session_id === input.identity.session_id && state.hook_pid === input.identity.claude_pid;
      if(currentHook) classification = state.health === 'rate_limited' ? 'rate_limited' : state.health === 'auth_failed' ? 'auth_error' : 'other';
      const hookReason = state.reason;
      const priorHealth = state.health, now = Math.floor(this.now() / 1000), budget = state.scheduling;
      const linked = this.associations.get(runtime)?.runId === input.runId;
      if (classification === 'ok') {
        state.health = 'ok'; state.reason = ''; state.rateLimitActive = false;
        budget.restartFailureCount = 0; budget.cooldownUntil = 0; budget.lastUserMessageRecoveryAt = 0;
        budget.unavailableSince = 0;
        state.recovered = {session_id:input.identity?.session_id ?? state.session_id,revision:state.revision + 1,
          evidence_id:state.evidence_id,screen_fingerprint:input.screenFingerprint ?? null,observed_at:this.now()};
      } else if (classification === 'rate_limited') {
        state.health = 'rate_limited'; state.reason = safeHealthReason('rate_limited', input.matches?.rateLimit?.reason);
        state.rateLimitActive = true;
        if (priorHealth !== 'rate_limited') budget.restartFailureCount = 0;
        const cooldown = input.matches?.rateLimit?.cooldownUntil;
        budget.cooldownUntil = Math.max(budget.cooldownUntil, Number.isSafeInteger(cooldown) && cooldown >= 0 ? cooldown : now + 3600);
        budget.rateLimitResetTime = input.matches?.rateLimit?.resetTime || budget.rateLimitResetTime;
      } else if (classification === 'auth_error') {
        state.health = 'auth_failed'; state.reason = 'authentication_failed';
      } else {
        state.health = 'unavailable'; state.reason = 'runtime_unavailable'; state.rateLimitActive = false;
        if (!linked) budget.restartFailureCount++;
        budget.lastRecoveryAt = now;
        if (!budget.unavailableSince) budget.unavailableSince = now;
      }
      state.revision++;
      state.source = currentHook ? 'hook' : 'recovery';
      if(currentHook) state.reason = hookReason;
      store.write(state);
      if (state.health === 'auth_failed' || state.health === 'ok') this.authRecoveries.delete(runtime);
      if (linked || state.health === 'ok' || state.health === 'auth_failed' || (priorHealth !== 'rate_limited' && state.health === 'rate_limited')) this.associations.delete(runtime);
      return {classification,state,linked};
    });
  }
  noteRunExited(runtime, runId) {
    return this.serial(runtime, () => { if (this.associations.get(runtime)?.runId === runId) this.associations.delete(runtime); });
  }
  beginAuthRecovery(runtime, checkResult, scenes) {
    return this.serial(runtime, () => {
      const state = this.store(runtime).read();
      if (state.health !== 'auth_failed' || checkResult.status !== 'success') return false;
      if (!this.authRecoveries.has(runtime)) this.authRecoveries.set(runtime, scenes.filter(scene => scene.runtime === runtime).map(scene => ({...scene})));
      return true;
    });
  }
  authTargets(runtime) { return (this.authRecoveries.get(runtime) ?? []).map(scene => ({...scene})); }
  completeAuthRecovery(runtime, { isGone, hasAuthFence = () => false }) {
    // Lifecycle checks run outside the health queue; no cross-queue lock inversion.
    const targets = this.authRecoveries.get(runtime);
    if (!targets) return Promise.resolve(false);
    return Promise.all(targets.map(async target => await isGone(target) && !await hasAuthFence(target))).then(confirmed => {
      if (confirmed.some(value => !value)) return false;
      return this.serial(runtime, () => {
        if (this.authRecoveries.get(runtime) !== targets) return false;
        const store = this.store(runtime), state = store.read(), now = Math.floor(this.now() / 1000);
        if (state.health !== 'auth_failed') { this.authRecoveries.delete(runtime); return false; }
        state.health = state.rateLimitActive ? 'rate_limited' : 'ok';
        state.reason = safeHealthReason(state.health, state.reason);
        if (state.health === 'rate_limited') {
          if (state.scheduling.cooldownUntil <= now) state.scheduling.cooldownUntil = 0;
        } else { state.scheduling.restartFailureCount = 0; state.scheduling.cooldownUntil = 0; state.scheduling.lastUserMessageRecoveryAt = 0; state.scheduling.unavailableSince = 0; }
        state.revision++;
        store.write(state);
        this.authRecoveries.delete(runtime);
        this.associations.delete(runtime);
        return true;
      });
    });
  }
}
