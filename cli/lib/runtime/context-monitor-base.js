/**
 * ContextMonitorBase — abstract base class for runtime context monitoring.
 *
 * Subclasses implement getUsage() to provide token counts for their runtime.
 * Shared logic handles threshold checking, cooldown, and polling.
 *
 * Usage:
 *   const monitor = adapter.getContextMonitor();
 *   monitor.startPolling({ intervalMs: 30_000, onExceed: ({ ratio }) => ... });
 */

export class ContextMonitorBase {
  /**
   * @param {object} [opts]
   * @param {number} [opts.threshold=0.80]   Fraction of ceiling that triggers handoff (0.0–1.0)
   * @param {number} [opts.cooldownMs=300000] Minimum ms between successive triggers (default 5 min)
   */
  constructor({ threshold = 0.80, cooldownMs = 300_000 } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this._lastTriggerAt = 0;
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
   * Check threshold and call onExceed if exceeded. Respects cooldown to avoid
   * re-triggering during the grace period after a handoff is initiated.
   *
   * @param {(info: {used: number, ceiling: number, ratio: number}) => Promise<void>} onExceed
   * @returns {Promise<void>}
   */
  async checkThreshold(onExceed) {
    const result = await this.check();
    if (!result) return;

    const { used, ceiling, ratio } = result;
    if (ratio < this.threshold) return;

    const now = Date.now();
    if (now - this._lastTriggerAt < this.cooldownMs) return;

    this._lastTriggerAt = now;
    if (onExceed) await onExceed({ used, ceiling, ratio });
  }

  /**
   * Start periodic polling. Calls checkThreshold() at each interval.
   * No-op if already started.
   *
   * @param {object} [opts]
   * @param {number}   [opts.intervalMs=30000] Poll interval in ms
   * @param {Function} [opts.onExceed]         Callback fired when threshold exceeded
   */
  startPolling({ intervalMs = 30_000, onExceed } = {}) {
    if (this._intervalId) return;
    this._intervalId = setInterval(() => {
      this.checkThreshold(onExceed).catch(() => {});
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
