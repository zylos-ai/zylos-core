import { loadCoreModule } from './core-modules.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { messageForStatus } from '../../comm-bridge/scripts/status-notice-templates.js';
import { runtimeRoot } from './runtime-generation.js';
import { normalizeHealth, recoveryEligibility } from './runtime-health.js';
const { assertSessionGroup } = await loadCoreModule('session-group-paths.js');

export const PROBE_CACHE_TTL_MS = 30000;
export const ROUTE_PROBE_TIMEOUT_MS = 25000;
export const messageForRoute = ({ health, reason }) => messageForStatus({ health, reason });
const runtimeValid = runtime => typeof runtime === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(runtime);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function validRouteRequest(request) {
  if (!object(request) || ![1, 2].includes(request.version) || request.type !== 'route'
      || typeof request.requestId !== 'string' || !request.requestId || typeof request.noReply !== 'boolean'
      || !Number.isSafeInteger(request.receivedAt)) return false;
  if (request.version === 1) return true;
  if (!Object.hasOwn(request, 'channel') || !Object.hasOwn(request, 'endpoint')
      || !Object.hasOwn(request, 'componentName') || !Object.hasOwn(request, 'sessionGroup')) return false;
  if (request.channel !== null && typeof request.channel !== 'string') return false;
  if (request.endpoint !== null && typeof request.endpoint !== 'string') return false;
  if (request.componentName !== null && typeof request.componentName !== 'string') return false;
  if (request.sessionGroup !== null) { try { assertSessionGroup(request.sessionGroup); } catch { return false; } }
  return (request.coreSide === undefined || typeof request.coreSide === 'boolean') && (request.coreSide !== true || request.coreSource === 'scheduler');
}

export class MessageRouter {
  constructor({ healthCoordinator, resolveTargetRuntime, getModeTransition = () => null,
    checkAuth, requestProbe, cacheDirectory = path.join(runtimeRoot(), 'activity-monitor', 'message-router-probe-cache'),
    log = () => {}, now = Date.now } = {}) {
    if (!healthCoordinator || !resolveTargetRuntime) throw new Error('MessageRouter requires runtime health and target resolution');
    Object.assign(this, { healthCoordinator, resolveTargetRuntime, getModeTransition, checkAuth, requestProbe, cacheDirectory, log, now });
  }
  cachePath(runtime) { return path.join(this.cacheDirectory, `${runtime}.json`); }
  clearLegacyCache(file = path.join(runtimeRoot(), 'activity-monitor', 'message-router-probe-cache.json')) {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') this.log(`Cannot clear old probe cache: ${error.message}`); }
  }
  async route(input) {
    if (!validRouteRequest(input)) throw Object.assign(new Error('Invalid route request'), { code: 'invalid_request' });
    const request = input.version === 1 ? { ...input, sessionGroup: null, coreSide: false } : input;
    if (await this.getModeTransition()) return this.decision(request, 'unknown', { health: 'unavailable', reason: 'transition_open', decision: 'pending', transitionHold: true });
    const resolution = await this.resolveTargetRuntime(request.sessionGroup);
    const runtime = typeof resolution === 'string' ? resolution : resolution?.runtime;
    if (!runtimeValid(runtime) || runtime === 'unknown') {
      this.log('MessageRouter: target runtime is unknown');
      return this.decision(request, 'unknown', { health: 'unavailable', reason: 'runtime_unknown', observation: 'runtime_unknown', decision: 'pending' });
    }
    let state = this.healthCoordinator.store(runtime).read();
    if (!state) return this.decision(request, runtime, { health: 'ok', reason: 'ok', decision: 'pending', observation: 'health_record_missing' });
    const rawHealth = state.health ?? 'ok';
    let health = normalizeHealth(rawHealth);
    let reason = this.reason(state);
    if (health === 'ok') { this.clearCache(runtime); return this.decision(request, runtime, { health, reason, decision: 'pending' }); }
    if (health === 'auth_failed') return this.authDecision(request, runtime, state);
    let accelerated = false;
    if (!request.noReply) accelerated = await this.healthCoordinator.notifyUserMessage(runtime);
    if (accelerated) this.clearCache(runtime);
    const cache = !accelerated && this.readNegativeCache(runtime);
    const gate = recoveryEligibility(this.healthCoordinator.store(runtime).read(), { runtime, cache, nowMs: this.now() });
    const probe = gate.eligible ? await this.awaitBudget(Promise.resolve().then(() => this.requestProbe?.(runtime))) : null;
    state = this.healthCoordinator.store(runtime).read();
    health = normalizeHealth(state.health ?? rawHealth); reason = this.reason(state);
    if (health === 'ok') { this.clearCache(runtime); return this.decision(request, runtime, { health, reason, decision: 'pending' }); }
    if (health === 'auth_failed') return this.authDecision(request, runtime, state);
    // No eligible scene means no probe took place. Keep input acceleration
    // available for M1 to register a launch in its next scheduling round.
    if (gate.eligible && !probe?.noTarget) this.writeNegativeCache(runtime, health, reason);
    return this.decision(request, runtime, { health, reason, ...(health === 'rate_limited' ? { decision: 'pending' } : { recovered: false }), ...(gate.code === 'probe_cache' ? { cacheHit: true } : {}) });
  }
  async authDecision(request, runtime, state) {
    const health = 'auth_failed'; const reason = this.reason(state);
    if (request.coreSide || (request.noReply && !request.channel)) return this.decision(request, runtime, { health, reason, decision: 'pending' });
    const action = this.checkAuth?.(runtime);
    const result = await this.awaitBudget(Promise.resolve(action ?? { result: 'uncertain', reason: 'authentication check unavailable' }));
    if (result?.result === 'success' || result?.status === 'success') return this.decision(request, runtime, { health, reason, decision: 'pending' });
    const failed = result?.result === 'failure' || result?.status === 'failure';
    const detail = String(result?.reason ?? (result?.timedOut ? 'authentication check timed out' : 'authentication check unconfirmed')).replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 500);
    return this.decision(request, runtime, { health, reason, decision: 'auth_rejected', auth: { result: failed ? 'failed' : 'unconfirmed', detail } });
  }
  reason(state) { return state.reason || normalizeHealth(state.health); }
  decision(request, runtime, result) {
    const recovered = result.decision === 'pending';
    const answer = { version: request.version, type: 'route', requestId: request.requestId, runtime,
      health: result.health, reason: result.reason || normalizeHealth(result.health), recovered, transitionHold: false, ...result };
    if (!answer.recovered && !request.noReply) {
      answer.userMessage = messageForStatus({ health: answer.health, reason: answer.reason });
    }
    return answer;
  }
  async awaitBudget(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), ROUTE_PROBE_TIMEOUT_MS); })]); }
    finally { clearTimeout(timer); }
  }
  readNegativeCache(runtime) {
    try { return JSON.parse(fs.readFileSync(this.cachePath(runtime), 'utf8')); }
    catch { return null; }
  }
  writeNegativeCache(runtime, health, reason) {
    const file = this.cachePath(runtime); const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      const createdAt = this.now(); fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: 2, runtime, health, reason, recovered: false,
        userMessage: messageForRoute({ health, reason }), createdAt, expiresAt: createdAt + PROBE_CACHE_TTL_MS, probeStartedAt: createdAt }));
      fs.renameSync(tmp, file);
    } catch (error) { try { fs.unlinkSync(tmp); } catch {} this.log(`MessageRouter: cache write failed: ${error.message}`); }
  }
  clearCache(runtime) { try { fs.unlinkSync(this.cachePath(runtime)); } catch (error) { if (error.code !== 'ENOENT') this.log(`MessageRouter: cache clear failed: ${error.message}`); } }
}
