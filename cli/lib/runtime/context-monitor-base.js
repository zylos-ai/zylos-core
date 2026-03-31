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
   * @param {number} [opts.threshold=0.75]   Fraction of ceiling that triggers handoff (0.0–1.0)
   * @param {number} [opts.cooldownMs=300000] Minimum ms between successive triggers (default 5 min)
   */
  constructor({ threshold = 0.75, cooldownMs = 300_000 } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this._lastTriggerAt = 0;
    this._intervalId = null;
    this._lastSessionId = null;
  }

  /**
   * Return current token usage for this runtime.
   * Must be implemented by subclasses.
   *
   * @returns {Promise<{used: number, ceiling: number, sessionId?: string} | null>}
   *   null when data is unavailable (e.g. no active session)
   */
  async getUsage() {
    throw new Error('ContextMonitorBase.getUsage() must be implemented by subclass');
  }

  /**
   * Check current usage and return structured result.
   *
   * @returns {Promise<{used: number, ceiling: number, ratio: number, sessionId?: string} | null>}
   */
  async check() {
    const usage = await this.getUsage();
    if (!usage || !usage.ceiling) return null;
    const { used, ceiling, sessionId } = usage;
    return { used, ceiling, ratio: used / ceiling, sessionId };
  }

  /**
   * Check current usage and run callbacks for session switch and threshold exceed.
   * Session change detection is callback-based and independent from threshold logic.
   *
   * @param {object} [opts]
   * @param {(info: {used: number, ceiling: number, ratio: number}) => Promise<void>} [opts.onExceed]
   * @param {(info: {sessionId: string, previousSessionId: string, used: number, ceiling: number, ratio: number}) => Promise<void>} [opts.onSessionChange]
   * @returns {Promise<void>}
   */
  async checkOnce({ onExceed, onSessionChange } = {}) {
    const result = await this.check();
    if (!result) return;

    const { used, ceiling, ratio, sessionId } = result;

    if (sessionId) {
      if (!this._lastSessionId) {
        this._lastSessionId = sessionId;
      } else if (this._lastSessionId !== sessionId) {
        const previousSessionId = this._lastSessionId;
        this._lastSessionId = sessionId;
        if (onSessionChange) {
          await onSessionChange({ sessionId, previousSessionId, used, ceiling, ratio });
        }
      }
    }

    if (ratio < this.threshold) return;

    const now = Date.now();
    if (now - this._lastTriggerAt < this.cooldownMs) return;
    this._lastTriggerAt = now;
    if (onExceed) await onExceed({ used, ceiling, ratio });
  }

  /**
   * Backward-compatible wrapper retained for existing callers/tests.
   *
   * @param {(info: {used: number, ceiling: number, ratio: number}) => Promise<void>} onExceed
   * @returns {Promise<void>}
   */
  async checkThreshold(onExceed) {
    await this.checkOnce({ onExceed });
  }

  /**
   * Start periodic polling. Calls checkOnce() at each interval.
   * No-op if already started.
   *
   * @param {object} [opts]
   * @param {number}   [opts.intervalMs=30000] Poll interval in ms
   * @param {Function} [opts.onExceed]         Callback fired when threshold exceeded
   * @param {Function} [opts.onSessionChange]  Callback fired when session id changes
   */
  startPolling({ intervalMs = 30_000, onExceed, onSessionChange } = {}) {
    if (this._intervalId) return;
    this._intervalId = setInterval(() => {
      this.checkOnce({ onExceed, onSessionChange }).catch(() => {});
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
