/**
 * HeartbeatEngine - Heartbeat liveness state machine.
 *
 * All external side-effects (C4 control, file I/O, tmux) are injected via
 * the `deps` object so the class can be tested in isolation.
 */

export class HeartbeatEngine {
  /**
   * @param {object} deps - Injected dependencies
   * @param {(phase: string) => boolean} deps.enqueueHeartbeat
   * @param {(controlId: number) => string} deps.getHeartbeatStatus
   * @param {() => object|null} deps.readHeartbeatPending
   * @param {() => void} deps.clearHeartbeatPending
   * @param {() => void} deps.killTmuxSession
   * @param {() => void} deps.notifyPendingChannels
   * @param {(message: string) => void} deps.log
   * @param {object} [options]
   * @param {number} [options.heartbeatInterval=1800]
   * @param {number} [options.maxRestartFailures=3]
   * @param {number} [options.rateLimitedProbeInterval=300]
   * @param {string} [options.initialHealth='ok']
   */
  constructor(deps, options = {}) {
    this.deps = deps;
    this.heartbeatInterval = options.heartbeatInterval ?? 1800;
    this.maxRestartFailures = options.maxRestartFailures ?? 3;

    // Internal state
    this.healthState = options.initialHealth ?? 'ok';
    this.restartFailureCount = 0;
    this.lastHeartbeatAt = Math.floor(Date.now() / 1000);
    this.lastRecoveryAt = 0;
    this.lastDownCheckAt = 0;
    this.lastRateLimitedCheckAt = this.healthState === 'rate_limited' ? Math.floor(Date.now() / 1000) : 0;
    this.downRetryInterval = options.downRetryInterval ?? 1800; // 30 min
    this.rateLimitedProbeInterval = options.rateLimitedProbeInterval ?? 300; // 5 min
    this.rateLimitResetAt = null;
  }

  get health() {
    return this.healthState;
  }

  setHealth(nextHealth, reason = '') {
    if (this.healthState === nextHealth) return;
    const suffix = reason ? ` (${reason})` : '';
    this.deps.log(`Health: ${this.healthState.toUpperCase()} -> ${nextHealth.toUpperCase()}${suffix}`);
    this.healthState = nextHealth;
  }

  processHeartbeat(claudeRunning, currentTime) {
    const pending = this.deps.readHeartbeatPending();
    if (pending) {
      const status = this.deps.getHeartbeatStatus(pending.control_id);

      // Guard against stuck pending: if created_at is too old, treat as timeout
      const pendingAge = currentTime - (pending.created_at || 0);
      const maxPendingAge = 600; // 10 min absolute ceiling
      if ((status === 'pending' || status === 'running' || status === 'error') && pendingAge < maxPendingAge) {
        return;
      }
      if (pendingAge >= maxPendingAge && status !== 'done') {
        this.deps.log(`Heartbeat pending too long (${pendingAge}s, status=${status}), treating as timeout`);
        this.onHeartbeatFailure(pending, 'stale_pending');
        return;
      }

      if (status === 'done') {
        this.onHeartbeatSuccess(pending.phase || 'unknown');
        return;
      }

      if (status === 'failed' || status === 'timeout' || status === 'not_found') {
        this.onHeartbeatFailure(pending, status);
        return;
      }

      this.deps.log(`Heartbeat unexpected status: ${status}`);
      this.onHeartbeatFailure(pending, `unexpected_${status}`);
      return;
    }

    if (!claudeRunning) {
      return;
    }

    if (this.healthState === 'recovering') {
      // Backoff: wait progressively longer between recovery attempts
      const backoffDelay = Math.min(this.restartFailureCount * 60, 300);
      if (backoffDelay > 0 && (currentTime - this.lastRecoveryAt) < backoffDelay) {
        return;
      }
      const ok = this.enqueueHeartbeat('recovery');
      if (!ok) {
        // Prevent retry storm: treat failed enqueue as if we just tried
        this.lastRecoveryAt = Math.floor(Date.now() / 1000);
      }
      return;
    }

    if (this.healthState === 'rate_limited') {
      if ((currentTime - this.lastRateLimitedCheckAt) < this.rateLimitedProbeInterval) {
        return;
      }
      const ok = this.enqueueHeartbeat('rate-limit-check');
      if (ok) {
        this.lastRateLimitedCheckAt = currentTime;
      }
      return;
    }

    if (this.healthState === 'down') {
      // Periodic retry: check every downRetryInterval instead of every tick
      if ((currentTime - this.lastDownCheckAt) < this.downRetryInterval) {
        return;
      }
      const ok = this.enqueueHeartbeat('down-check');
      if (ok) {
        this.lastDownCheckAt = currentTime;
      }
      return;
    }

    if ((currentTime - this.lastHeartbeatAt) >= this.heartbeatInterval) {
      this.enqueueHeartbeat('primary');
    }
  }

  onHeartbeatSuccess(phase) {
    this.deps.clearHeartbeatPending();
    this.restartFailureCount = 0;
    if (this.healthState !== 'ok') {
      this.setHealth('ok', `heartbeat_ack phase=${phase}`);
      this.deps.notifyPendingChannels();
    }
    if (phase !== 'primary') {
      this.lastHeartbeatAt = Math.floor(Date.now() / 1000);
    }
  }

  triggerRecovery(reason) {
    if (this.healthState === 'down') {
      this.deps.log(`Heartbeat recovery skipped in DOWN state (${reason})`);
      return;
    }

    if (this.healthState === 'rate_limited') {
      this.deps.log(`Heartbeat recovery skipped in RATE_LIMITED state (${reason})`);
      return;
    }

    if (this.healthState === 'ok') {
      this.setHealth('recovering', reason);
    }

    this.restartFailureCount += 1;
    this.lastRecoveryAt = Math.floor(Date.now() / 1000);
    this.deps.log(`Heartbeat recovery attempt ${this.restartFailureCount}/${this.maxRestartFailures} (${reason})`);
    this.deps.killTmuxSession();

    if (this.restartFailureCount >= this.maxRestartFailures) {
      this.lastDownCheckAt = Math.floor(Date.now() / 1000);
      this.setHealth('down', 'max_restart_failures_reached');
    }
  }

  /**
   * Enter rate_limited state. Called by the activity monitor when a rate-limit
   * screen is detected in the tmux pane. This state suppresses restart
   * escalation and probes more frequently than "down".
   * @param {number|null} resetSeconds - estimated seconds until rate limit clears
   */
  enterRateLimited(resetSeconds = null) {
    if (this.healthState === 'rate_limited') {
      // Update reset estimate if a new value is available
      if (resetSeconds != null) {
        this.rateLimitResetAt = Math.floor(Date.now() / 1000) + resetSeconds;
      }
      return;
    }
    const reason = resetSeconds != null ? `api_rate_limit_reset_in_${resetSeconds}s` : 'api_rate_limit';
    this.setHealth('rate_limited', reason);
    this.rateLimitResetAt = resetSeconds != null
      ? Math.floor(Date.now() / 1000) + resetSeconds
      : null;
    this.lastRateLimitedCheckAt = Math.floor(Date.now() / 1000);
    this.restartFailureCount = 0;
  }

  onHeartbeatFailure(pending, status) {
    const phase = pending.phase || 'primary';
    this.deps.clearHeartbeatPending();

    // In ok state, any failure triggers recovery directly (no verify phase).
    // The verify phase was removed in v2 — stuck detection provides the
    // corroborating signal that verify used to offer.
    if (this.healthState === 'ok') {
      this.triggerRecovery(`${phase}_${status}`);
      return;
    }

    if (this.healthState === 'recovering') {
      this.triggerRecovery(`recovery_${status}`);
      return;
    }

    if (this.healthState === 'down') {
      this.deps.log(`Heartbeat failed in DOWN state (${status}); waiting for manual fix`);
      return;
    }

    if (this.healthState === 'rate_limited') {
      this.deps.log(`Heartbeat failed in RATE_LIMITED state (${status}); waiting for rate limit to clear`);
      return;
    }

    this.triggerRecovery(`heartbeat_${status}`);
  }

  /**
   * Request an immediate heartbeat probe (used by stuck detection).
   * Returns false if a probe cannot be sent (wrong health state or
   * another heartbeat is already in flight).
   */
  requestImmediateProbe(reason) {
    if (this.healthState !== 'ok') return false;
    const pending = this.deps.readHeartbeatPending();
    if (pending) return false;
    this.deps.log(`Stuck detection triggered: ${reason}`);
    return this.enqueueHeartbeat('stuck');
  }

  /** Wrapper that updates lastHeartbeatAt on successful primary/stuck enqueue. */
  enqueueHeartbeat(phase) {
    const ok = this.deps.enqueueHeartbeat(phase);
    if (ok && (phase === 'primary' || phase === 'stuck')) {
      this.lastHeartbeatAt = Math.floor(Date.now() / 1000);
    }
    return ok;
  }
}
