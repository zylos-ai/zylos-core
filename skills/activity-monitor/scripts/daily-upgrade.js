/**
 * Daily Upgrade Scheduler
 *
 * Determines whether a daily Claude Code upgrade should be enqueued,
 * based on local timezone hour and persisted last-upgrade date.
 */

export class DailyUpgradeScheduler {
  /**
   * @param {object} deps - injected dependencies
   * @param {function} deps.getLocalHour - returns current hour (0-23) in configured timezone
   * @param {function} deps.getLocalDate - returns current date string (YYYY-MM-DD) in configured timezone
   * @param {function} deps.loadState - returns persisted state object or null
   * @param {function} deps.writeState - persists state { last_upgrade_date }
   * @param {function} deps.enqueue - enqueues the upgrade control message, returns boolean
   * @param {function} deps.log - logging function
   * @param {object} [options]
   * @param {number} [options.upgradeHour=5] - hour to trigger upgrade (0-23)
   */
  constructor(deps, options = {}) {
    this.deps = deps;
    this.upgradeHour = options.upgradeHour ?? 5;
  }

  /**
   * Check whether to enqueue a daily upgrade.
   * @param {boolean} claudeRunning - is Claude process alive?
   * @param {string} health - heartbeat health state ('ok', 'recovering', 'down')
   * @returns {boolean} true if upgrade was enqueued
   */
  maybeEnqueue(claudeRunning, health) {
    if (!claudeRunning) return false;
    if (health !== 'ok') return false;

    const hour = this.deps.getLocalHour();
    if (hour !== this.upgradeHour) return false;

    const state = this.deps.loadState();
    const today = this.deps.getLocalDate();
    if (state?.last_upgrade_date === today) return false;

    const ok = this.deps.enqueue();
    if (ok) {
      this.deps.writeState(today);
      this.deps.log(`Daily upgrade enqueued (tz date=${today})`);
    }
    return ok;
  }
}
