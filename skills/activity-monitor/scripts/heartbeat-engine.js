/**
 * HeartbeatEngine - Heartbeat liveness state machine.
 *
 * v4 changes (#256 — behavioral rate limit detection):
 *   - Rate limit detection moved from proactive tmux scan to heartbeat failure
 *   - deps.detectRateLimit callback: called on heartbeat failure before triggering
 *     kill+restart recovery. If rate limit detected → enter rate_limited instead.
 *   - Eliminates false positives from conversation content matching "rate limit"
 *
 * v3 changes (#233 — RATE_LIMITED state + user message triggered recovery):
 *   - New RATE_LIMITED health state: no kill+restart, waits for cooldown
 *   - enterRateLimited(cooldownUntil, resetTime): called by activity-monitor
 *     when rate-limit signals detected in tmux pane content
 *   - After cooldownUntil expires: restart Claude + heartbeat verification
 *   - User message triggered recovery: notifyUserMessage() resets cooldown
 *     timer (5 min cooldown between triggers)
 *   - State transitions: ok/recovering → rate_limited → ok
 *
 * v2 changes (#177 — exponential backoff + process signal acceleration):
 *   - Exponential backoff: min(3600, 60 × 5^(n-1)) → 1m, 5m, 25m, 60m cap
 *   - Infinite retries in recovering state (no maxRestartFailures limit)
 *   - DOWN degradation: after downDegradeThreshold seconds of continuous failure
 *   - DOWN retry interval: 60 min (periodic heartbeat probe)
 *   - Process signal acceleration: when agentRunning transitions false→true,
 *     wait a grace period then immediately verify via heartbeat (skip backoff)
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
   * @param {() => {detected: boolean, cooldownUntil?: number, resetTime?: string}} [deps.detectRateLimit]
   * @param {object} [options]
   * @param {number} [options.heartbeatInterval=1800]
   * @param {number} [options.downDegradeThreshold=3600] - Seconds of continuous failure before entering DOWN
   * @param {number} [options.downRetryInterval=3600] - Seconds between DOWN-state probes
   * @param {number} [options.signalGracePeriod=30] - Seconds to wait after agentRunning transitions before probing
   * @param {number} [options.rateLimitDefaultCooldown=3600] - Default cooldown when reset time can't be parsed
   * @param {number} [options.userMessageRecoveryCooldown=60] - Min seconds between user-message-triggered recoveries
   * @param {string} [options.initialHealth='ok']
   */
  constructor(deps, options = {}) {
    this.deps = deps;
    this.heartbeatInterval = options.heartbeatInterval ?? 1800;
    this.downDegradeThreshold = options.downDegradeThreshold ?? 3600; // 1 hour
    this.downRetryInterval = options.downRetryInterval ?? 3600; // 1 hour
    this.signalGracePeriod = options.signalGracePeriod ?? 30;
    this.rateLimitDefaultCooldown = options.rateLimitDefaultCooldown ?? 3600; // 1 hour
    this.userMessageRecoveryCooldown = options.userMessageRecoveryCooldown ?? 60; // 1 min

    // Internal state
    this.healthState = options.initialHealth ?? 'ok';
    this.restartFailureCount = 0;
    this.lastHeartbeatAt = Math.floor(Date.now() / 1000);
    this.lastRecoveryAt = 0;
    this.lastDownCheckAt = 0;
    // If resuming in recovering state (e.g., PM2 restart mid-recovery),
    // initialize recoveringStartedAt so DOWN degradation timer works correctly.
    this.recoveringStartedAt = this.healthState === 'recovering' ? Math.floor(Date.now() / 1000) : 0;

    // Process signal acceleration state
    this.lastAgentRunning = null; // null = unknown (first tick)
    this.signalDetectedAt = 0; // When agentRunning transitioned false→true

    // Rate-limited state
    this.cooldownUntil = 0; // Epoch seconds when rate limit cooldown expires
    this.rateLimitResetTime = ''; // Human-readable reset time for display
    this.lastUserMessageRecoveryAt = 0; // Last time user message triggered early recovery
  }

  get health() {
    return this.healthState;
  }

  /**
   * Returns true if Guardian is allowed to restart the agent now.
   * Encapsulates health-state restart policy so Guardian does not read
   * internal state directly (separation of concerns).
   *
   * 'recovering' and 'down' allow restarts — the agent is down and we want to
   * bring it back. Only 'rate_limited' blocks restarts because restarting cannot
   * clear a rate limit; the HeartbeatEngine manages its own cooldown recovery.
   */
  canRestart() {
    return this.healthState !== 'rate_limited';
  }

  setHealth(nextHealth, reason = '') {
    if (this.healthState === nextHealth) return;
    const suffix = reason ? ` (${reason})` : '';
    this.deps.log(`Health: ${this.healthState.toUpperCase()} -> ${nextHealth.toUpperCase()}${suffix}`);
    this.healthState = nextHealth;
  }

  /**
   * Calculate exponential backoff delay for the current failure count.
   * Formula: min(3600, 60 × 5^(n-1)) where n = restartFailureCount
   * Sequence: 60s, 300s, 1500s, 3600s, 3600s, ...
   */
  getBackoffDelay() {
    if (this.restartFailureCount <= 0) return 0;
    return Math.min(3600, 60 * Math.pow(5, this.restartFailureCount - 1));
  }

  /**
   * Enter RATE_LIMITED state. Called by activity-monitor when rate-limit
   * signals are detected in tmux pane content.
   *
   * @param {number} cooldownUntil - Epoch seconds when cooldown expires
   * @param {string} [resetTime] - Human-readable reset time for display
   */
  enterRateLimited(cooldownUntil, resetTime = '') {
    if (this.healthState === 'rate_limited') {
      // Already rate-limited; update cooldown if the new one is later
      if (cooldownUntil > this.cooldownUntil) {
        this.cooldownUntil = cooldownUntil;
        this.rateLimitResetTime = resetTime || this.rateLimitResetTime;
        this.deps.log(`Rate limit cooldown extended to ${cooldownUntil} (${resetTime || 'unknown'})`);
      }
      return;
    }

    this.cooldownUntil = cooldownUntil;
    this.rateLimitResetTime = resetTime;
    this.restartFailureCount = 0;
    this.recoveringStartedAt = 0;
    this.signalDetectedAt = 0;
    this.setHealth('rate_limited', resetTime ? `resets at ${resetTime}` : `cooldown ${cooldownUntil - Math.floor(Date.now() / 1000)}s`);
  }

  /**
   * Notify that a user message was received while service is unavailable.
   * Triggers or accelerates recovery depending on current health state.
   *
   * - rate_limited: clears cooldown for immediate recovery check
   * - recovering: resets backoff to retry immediately
   * - down: triggers immediate probe (skips downRetryInterval wait)
   *
   * Returns true if recovery was triggered/accelerated, false if on cooldown or healthy.
   */
  notifyUserMessage(currentTime) {
    if (this.healthState === 'ok') return false;

    if ((currentTime - this.lastUserMessageRecoveryAt) < this.userMessageRecoveryCooldown) {
      const remaining = this.userMessageRecoveryCooldown - (currentTime - this.lastUserMessageRecoveryAt);
      this.deps.log(`User message recovery on cooldown (${remaining}s remaining)`);
      return false;
    }

    this.lastUserMessageRecoveryAt = currentTime;

    if (this.healthState === 'rate_limited') {
      this.deps.log('User message triggered rate-limit recovery attempt');
      this.cooldownUntil = 0;
      return true;
    }

    if (this.healthState === 'recovering') {
      this.deps.log('User message triggered recovery acceleration (backoff reset)');
      this.restartFailureCount = 0;
      this.lastRecoveryAt = 0;
      return true;
    }

    if (this.healthState === 'down') {
      this.deps.log('User message triggered immediate down-state probe');
      this.lastDownCheckAt = 0;
      return true;
    }

    return false;
  }

  processHeartbeat(agentRunning, currentTime) {
    // Track agentRunning transitions for process signal acceleration
    this._trackAgentRunning(agentRunning, currentTime);

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

    // Rate-limited recovery: must be checked BEFORE the !agentRunning early
    // return. After cooldown expires Claude is not running (tmux was killed),
    // so the early return would skip this block and cause a deadlock (#252).
    if (this.healthState === 'rate_limited') {
      if (currentTime < this.cooldownUntil) {
        return;
      }
      this.deps.log('Rate limit cooldown expired, transitioning to recovering');
      this.deps.killTmuxSession();
      this.cooldownUntil = 0;
      this.setHealth('recovering', 'rate_limit_cooldown_expired');
      // Guardian will now restart Claude since health !== 'rate_limited'
      return;
    }

    if (!agentRunning) {
      return;
    }

    // Process signal acceleration: agentRunning just transitioned false→true,
    // grace period elapsed — send immediate heartbeat to verify recovery.
    // Works in recovering and down states.
    if ((this.healthState === 'recovering' || this.healthState === 'down') && this._shouldAccelerate(currentTime)) {
      this.deps.log(`Process signal acceleration: Agent restarted (health=${this.healthState}), verifying immediately`);
      this.signalDetectedAt = 0; // Consume the signal
      const phase = this.healthState === 'down' ? 'signal-down-check' : 'signal-recovery';
      const ok = this.enqueueHeartbeat(phase);
      if (!ok) {
        this.lastRecoveryAt = Math.floor(Date.now() / 1000);
      }
      if (ok && this.healthState === 'down') {
        this.lastDownCheckAt = currentTime;
      }
      return;
    }

    if (this.healthState === 'recovering') {
      // Exponential backoff: wait progressively longer between recovery attempts
      const backoffDelay = this.getBackoffDelay();
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
    this.recoveringStartedAt = 0;
    this.signalDetectedAt = 0;
    this.cooldownUntil = 0;
    this.rateLimitResetTime = '';
    this.lastUserMessageRecoveryAt = 0;
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

    const now = Math.floor(Date.now() / 1000);

    if (this.healthState === 'ok') {
      this.setHealth('recovering', reason);
      this.recoveringStartedAt = now;
    }

    this.restartFailureCount += 1;
    this.lastRecoveryAt = now;
    this.deps.log(`Heartbeat recovery attempt ${this.restartFailureCount} (${reason}), next backoff ${this.getBackoffDelay()}s`);
    this.deps.killTmuxSession();

    // Degrade to DOWN after continuous failure exceeds threshold
    const failureDuration = now - this.recoveringStartedAt;
    if (this.recoveringStartedAt > 0 && failureDuration >= this.downDegradeThreshold) {
      this.lastDownCheckAt = now;
      this.setHealth('down', `continuous_failure_for_${failureDuration}s`);
    }
  }

  onHeartbeatFailure(pending, status) {
    const phase = pending.phase || 'primary';
    const now = Math.floor(Date.now() / 1000);
    this.deps.clearHeartbeatPending();

    // Before triggering kill+restart recovery, check if the failure is due to
    // a rate limit. This is the "behavioral + text" dual-signal approach:
    // heartbeat failed (behavioral) AND tmux shows rate limit text (text signal).
    // Only checked in ok/recovering states where we'd otherwise kill the session.
    if ((this.healthState === 'ok' || this.healthState === 'recovering') && this.deps.detectRateLimit) {
      const rateLimit = this.deps.detectRateLimit();
      if (rateLimit.detected) {
        this.enterRateLimited(rateLimit.cooldownUntil, rateLimit.resetTime);
        return;
      }
    }

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
      this.deps.log(`Heartbeat failed in DOWN state (${status}); still probing periodically`);
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
    this.deps.log(`Immediate probe triggered: ${reason}`);
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

  /**
   * Track agentRunning state transitions for process signal acceleration.
   * When agentRunning goes false→true while recovering, record the timestamp
   * so we can send an accelerated probe after the grace period.
   */
  _trackAgentRunning(agentRunning, currentTime) {
    const prev = this.lastAgentRunning;
    this.lastAgentRunning = agentRunning;

    // Detect false→true transition (skip null→true on first tick)
    if (prev === false && agentRunning === true && (this.healthState === 'recovering' || this.healthState === 'down')) {
      this.signalDetectedAt = currentTime;
      this.deps.log(`Process signal: agentRunning false→true, grace period ${this.signalGracePeriod}s`);
    }
  }

  /**
   * Check if process signal acceleration should fire.
   * Returns true when a signal was detected and the grace period has elapsed.
   */
  _shouldAccelerate(currentTime) {
    if (this.signalDetectedAt === 0) return false;
    return (currentTime - this.signalDetectedAt) >= this.signalGracePeriod;
  }
}
