/**
 * Generic daily schedule runner.
 *
 * Triggers a task once per day at a configured hour (local timezone).
 * Uses date-based deduplication to prevent re-triggering on the same day,
 * even if the monitor loop is imprecise.
 *
 * Timing guarantees:
 * - The target hour provides a ~3600s window; with ~1s loop interval
 *   it is virtually impossible to skip an entire window.
 * - Date-based dedup (last_date === today) ensures exactly-once per day.
 */

export class DailySchedule {
  /**
   * @param {object} deps - injected dependencies
   * @param {function} deps.getLocalHour - returns current hour (0-23)
   * @param {function} deps.getLocalDate - returns current date string (YYYY-MM-DD)
   * @param {function} deps.loadState - returns { last_date } or null
   * @param {function} deps.writeState - persists date string
   * @param {function} deps.execute - runs the task, returns boolean success
   * @param {function} [deps.log] - logging function
   * @param {object} [options]
   * @param {number} options.hour - hour to trigger (0-23, required)
   * @param {string} [options.name] - task name for log messages
   */
  constructor(deps, options) {
    this.deps = deps;
    this.targetHour = options.hour;
    this.name = options.name || 'daily-task';
  }

  /**
   * Check whether to run the daily task. Call this every loop tick.
   * @returns {boolean} true if the task was executed
   */
  maybeTrigger() {
    const hour = this.deps.getLocalHour();
    if (hour !== this.targetHour) return false;

    const state = this.deps.loadState();
    const today = this.deps.getLocalDate();
    if (state?.last_date === today) return false;

    const ok = this.deps.execute();
    if (ok) {
      this.deps.writeState(today);
      this.deps.log?.(`${this.name}: executed (date=${today})`);
    }
    return ok;
  }
}
