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
      if (status === 'pending' || status === 'running' || status === 'error') {
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
      return;
    }

    if (!claudeRunning) {
      return;
    }

    if (this.healthState === 'recovering') {
      this.enqueueHeartbeat('recovery');
      return;
    }

    if (this.healthState === 'down') {
      this.enqueueHeartbeat('down-check');
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

    if (this.healthState === 'ok') {
      this.setHealth('recovering', reason);
    }

    this.restartFailureCount += 1;
    this.deps.log(`Heartbeat recovery attempt ${this.restartFailureCount}/${this.maxRestartFailures} (${reason})`);
    this.deps.killTmuxSession();

    if (this.restartFailureCount >= this.maxRestartFailures) {
      this.setHealth('down', 'max_restart_failures_reached');
    }
  }

  onHeartbeatFailure(pending, status) {
    const phase = pending.phase || 'primary';
    this.deps.clearHeartbeatPending();

    if (phase === 'primary' && this.healthState === 'ok') {
      this.deps.log('Heartbeat primary failed; entering verify phase');
      this.enqueueHeartbeat('verify');
      return;
    }

    if (phase === 'verify' && this.healthState === 'ok') {
      this.triggerRecovery(`verify_${status}`);
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

    this.triggerRecovery(`heartbeat_${status}`);
  }

  /** Wrapper that updates lastHeartbeatAt on successful primary enqueue. */
  enqueueHeartbeat(phase) {
    const ok = this.deps.enqueueHeartbeat(phase);
    if (ok && phase === 'primary') {
      this.lastHeartbeatAt = Math.floor(Date.now() / 1000);
    }
    return ok;
  }
}
