import fs from 'fs';
import path from 'path';

export const PROBE_CACHE_TTL_MS = 30000;
export const ROUTE_PROBE_TIMEOUT_MS = 25000;

const USER_MESSAGE_CATALOG = {
  rate_limit_detected:
    'I am currently being rate-limited by the upstream service and will recover automatically. Your message has been received but will not enter the processing queue for now.',
  rate_limit_cooldown_expired:
    'I am recovering from rate-limiting, please try again later.',
  auth_still_failed:
    'Authentication is currently unavailable. An administrator needs to resolve this before I can continue.',
  auth_check_failed:
    'Authentication is currently unavailable. An administrator needs to resolve this before I can continue.',
  heartbeat_timeout:
    'I am temporarily unresponsive and attempting to recover. Please resend your message shortly.',
  heartbeat_failed:
    'I am temporarily unresponsive and attempting to recover. Please resend your message shortly.',
  sticky_context_restart:
    'I detected an issue with the current session context and am switching to a new session to recover. Please resend your message shortly.',
  tool_timeout:
    'A tool execution got stuck. I am restarting the session to recover. Please resend your message shortly.',
  unavailable:
    'I am temporarily unavailable and attempting to recover. Please resend your message shortly.',
  unknown:
    'I am temporarily unavailable and attempting to recover. Please resend your message shortly.',
};

function nowMs() {
  return Date.now();
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

export function normalizeHealth(health) {
  if (health === 'ok' || health === 'rate_limited' || health === 'auth_failed') return health;
  return 'unavailable';
}

export function messageForRoute({ health, reason }) {
  if (reason?.startsWith('tool_timeout_')) return USER_MESSAGE_CATALOG.tool_timeout;
  if (reason?.startsWith('sticky_')) return USER_MESSAGE_CATALOG.sticky_context_restart;
  if (reason && USER_MESSAGE_CATALOG[reason]) return USER_MESSAGE_CATALOG[reason];
  if (health === 'rate_limited') return USER_MESSAGE_CATALOG.rate_limit_detected;
  if (health === 'auth_failed') return USER_MESSAGE_CATALOG.auth_still_failed;
  return USER_MESSAGE_CATALOG.unknown;
}

export class MessageRouter {
  constructor({ healthEngine, cacheFile, log = () => {}, now = nowMs } = {}) {
    if (!healthEngine) {
      throw new Error('MessageRouter requires healthEngine');
    }
    this.healthEngine = healthEngine;
    this.cacheFile = cacheFile;
    this.log = log;
    this.now = now;
    this.inFlightProbe = null;
  }

  async route(request) {
    if (!request || request.version !== 1 || request.type !== 'route') {
      throw new Error('invalid route request');
    }

    const rawHealth = this.healthEngine.health ?? 'ok';
    const health = normalizeHealth(rawHealth);
    const reason = this._currentReason(rawHealth);

    if (health === 'ok') {
      this._clearCache();
      return this._decision(request, { recovered: true, health: 'ok' });
    }

    let forceProbe = false;
    if (!request.noReply && typeof this.healthEngine.notifyUserMessage === 'function') {
      forceProbe = this.healthEngine.notifyUserMessage(Math.floor(this.now() / 1000));
      if (forceProbe) this._clearCache();
    }

    if (!forceProbe) {
      const cached = this._readValidCache(health, reason);
      if (cached) {
        return this._decision(request, {
          recovered: false,
          health,
          reason,
          userMessage: request.noReply ? undefined : cached.userMessage,
          cacheHit: true,
        });
      }

      if (this._isWithinUnavailableBackoff(rawHealth)) {
        const userMessage = messageForRoute({ health, reason });
        return this._decision(request, {
          recovered: false,
          health,
          reason,
          userMessage: request.noReply ? undefined : userMessage,
        });
      }
    }

    const probeResult = await this._joinOrStartProbe(rawHealth, reason);
    if (probeResult?.recovered || normalizeHealth(this.healthEngine.health ?? 'ok') === 'ok') {
      this._clearCache();
      return this._decision(request, { recovered: true, health: 'ok', probeStarted: probeResult?.probeStarted });
    }

    const finalHealth = normalizeHealth(this.healthEngine.health ?? rawHealth);
    const finalReason = this._currentReason(this.healthEngine.health ?? rawHealth);
    const userMessage = messageForRoute({ health: finalHealth, reason: finalReason });
    this._writeNegativeCache(finalHealth, finalReason, userMessage, probeResult?.probeStartedAt);

    return this._decision(request, {
      recovered: false,
      health: finalHealth,
      reason: finalReason,
      userMessage: request.noReply ? undefined : userMessage,
      probeStarted: probeResult?.probeStarted,
    });
  }

  _decision(request, decision) {
    return {
      version: 1,
      requestId: request.requestId,
      ...decision,
    };
  }

  _currentReason(rawHealth) {
    return this.healthEngine.healthReason || this.healthEngine.unavailableReason || rawHealth || 'unknown';
  }

  _isWithinUnavailableBackoff(rawHealth) {
    if (rawHealth !== 'recovering' && rawHealth !== 'down' && rawHealth !== 'unavailable') return false;
    const lastRecoveryAt = Number(this.healthEngine.lastRecoveryAt) || 0;
    const backoffDelay = typeof this.healthEngine.getBackoffDelay === 'function'
      ? this.healthEngine.getBackoffDelay()
      : Number(this.healthEngine.backoffDelay) || 0;
    if (lastRecoveryAt <= 0 || backoffDelay <= 0) return false;
    const nowSec = Math.floor(this.now() / 1000);
    return (nowSec - lastRecoveryAt) < backoffDelay;
  }

  async _joinOrStartProbe(rawHealth, reason) {
    const key = `${rawHealth}:${reason || ''}`;
    if (this.inFlightProbe?.key === key) {
      return this._awaitWithBudget(this.inFlightProbe.promise);
    }

    const startedAt = this.now();
    const promise = this._runRecoveryProbe()
      .finally(() => {
        if (this.inFlightProbe?.key === key) this.inFlightProbe = null;
      });
    this.inFlightProbe = { key, startedAt, promise };
    const result = await this._awaitWithBudget(promise);
    return { ...result, probeStarted: true, probeStartedAt: startedAt };
  }

  async _awaitWithBudget(promise) {
    let timeoutId;
    const timeout = new Promise(resolve => {
      timeoutId = setTimeout(() => resolve({ recovered: false, timedOut: true }), ROUTE_PROBE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async _runRecoveryProbe() {
    if (typeof this.healthEngine.runRecoveryProbe === 'function') {
      return this.healthEngine.runRecoveryProbe({ timeoutMs: ROUTE_PROBE_TIMEOUT_MS });
    }
    return { recovered: false };
  }

  _readValidCache(health, reason) {
    if (!this.cacheFile) return null;
    try {
      const cache = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (cache.version !== 1) return null;
      if (cache.expiresAt <= this.now()) return null;
      if (cache.recovered !== false) return null;
      if (cache.health !== health || cache.reason !== reason) return null;
      return cache;
    } catch {
      return null;
    }
  }

  _writeNegativeCache(health, reason, userMessage, probeStartedAt = this.now()) {
    if (!this.cacheFile) return;
    try {
      const createdAt = this.now();
      atomicWriteJson(this.cacheFile, {
        version: 1,
        health,
        reason,
        recovered: false,
        userMessage,
        createdAt,
        expiresAt: createdAt + PROBE_CACHE_TTL_MS,
        probeStartedAt,
      });
    } catch (err) {
      this.log(`MessageRouter: failed to write probe cache (${err.message})`);
    }
  }

  _clearCache() {
    if (!this.cacheFile) return;
    try {
      fs.rmSync(this.cacheFile, { force: true });
    } catch { /* best-effort */ }
  }
}
