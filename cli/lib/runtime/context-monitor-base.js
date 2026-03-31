/**
 * ContextMonitorBase — abstract base class for runtime context monitoring.
 *
 * Subclasses implement getUsage() to provide token counts for their runtime.
 * Shared logic handles threshold checking, cooldown, and polling.
 *
 * Two-stage design:
 *   1. Early threshold (default: 80% of session-switch threshold) — triggers
 *      a memory sync prompt so sync completes before session switch.
 *   2. Session-switch threshold — triggers the new-session handoff.
 *
 * Usage:
 *   const monitor = adapter.getContextMonitor();
 *   monitor.startPolling({
 *     intervalMs: 30_000,
 *     onExceed: ({ ratio }) => ...,
 *     onEarlyThreshold: ({ ratio }) => ...,
 *   });
 */

export class ContextMonitorBase {
  /**
   * @param {object} [opts]
   * @param {number} [opts.threshold=0.80]           Fraction of ceiling that triggers handoff (0.0–1.0)
   * @param {number} [opts.cooldownMs=300000]         Minimum ms between successive session-switch triggers (default 5 min)
   * @param {number} [opts.earlyThresholdRatio=0.80]  Fraction of threshold for early sync (default 80% of threshold)
   * @param {number} [opts.earlyCooldownMs=600000]    Minimum ms between early sync triggers (default 10 min)
   */
  constructor({ threshold = 0.80, cooldownMs = 300_000, earlyThresholdRatio = 0.80, earlyCooldownMs = 600_000 } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.earlyThreshold = threshold * earlyThresholdRatio;
    this.earlyCooldownMs = earlyCooldownMs;
    this._lastTriggerAt = 0;
    this._lastEarlyTriggerAt = 0;
    this._intervalId = null;
  }

  /**
   * Return current token usage for this runtime.
   * Must be implemented by subclasses.
   *
   * @returns {Promise<{used: number, ceiling: number} | null>}
   *   null when data is unavailable (e.g. no active session)
   */
  async getUsage() {
    throw new Error('ContextMonitorBase.getUsage() must be implemented by subclass');
  }

  /**
   * Check current usage and return structured result.
   *
   * @returns {Promise<{used: number, ceiling: number, ratio: number} | null>}
   */
  async check() {
    const usage = await this.getUsage();
    if (!usage || !usage.ceiling) return null;
    const { used, ceiling } = usage;
    return { used, ceiling, ratio: used / ceiling };
  }

  /**
   * Check thresholds and fire callbacks. Two stages:
   *   1. Early threshold — fires onEarlyThreshold (memory sync injection)
   *   2. Session-switch threshold — fires onExceed (new-session handoff)
   *
   * Both respect independent cooldowns.
   *
   * @param {object} callbacks
   * @param {Function} [callbacks.onExceed]           Fired when session-switch threshold exceeded
   * @param {Function} [callbacks.onEarlyThreshold]   Fired when early threshold reached (but below session-switch)
   * @returns {Promise<void>}
   */
  async checkThreshold({ onExceed, onEarlyThreshold } = {}) {
    const result = await this.check();
    if (!result) return;

    const { used, ceiling, ratio } = result;
    const now = Date.now();

    // Session-switch threshold (higher priority — check first)
    if (ratio >= this.threshold) {
      if (now - this._lastTriggerAt >= this.cooldownMs) {
        this._lastTriggerAt = now;
        if (onExceed) await onExceed({ used, ceiling, ratio });
      }
      return;
    }

    // Early threshold (memory sync injection)
    if (ratio >= this.earlyThreshold && onEarlyThreshold) {
      if (now - this._lastEarlyTriggerAt >= this.earlyCooldownMs) {
        this._lastEarlyTriggerAt = now;
        await onEarlyThreshold({ used, ceiling, ratio });
      }
    }
  }

  /**
   * Start periodic polling. Calls checkThreshold() at each interval.
   * No-op if already started.
   *
   * @param {object} [opts]
   * @param {number}   [opts.intervalMs=30000]       Poll interval in ms
   * @param {Function} [opts.onExceed]               Callback fired when session-switch threshold exceeded
   * @param {Function} [opts.onEarlyThreshold]       Callback fired when early threshold reached
   */
  startPolling({ intervalMs = 30_000, onExceed, onEarlyThreshold } = {}) {
    if (this._intervalId) return;
    this._intervalId = setInterval(() => {
      this.checkThreshold({ onExceed, onEarlyThreshold }).catch(() => {});
    }, intervalMs);
  }

  /**
   * Stop periodic polling.
   */
  stopPolling() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }
}
