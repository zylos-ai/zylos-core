/**
 * Cron Utilities
 * Parsing and validation of cron schedule expressions
 */

import parser from 'cron-parser';

export function getDefaultTimezone() {
  return process.env.TZ || 'UTC';
}

/**
 * Calculate the next run time for a cron expression
 * @param {string} cronExpression - Standard cron expression
 * @param {string} timezone - Timezone (default: from TZ env var or UTC)
 * @param {Date} fromDate - Calculate next run from this date (default: now)
 * @returns {number} Unix timestamp of next run
 */
export function getNextRun(cronExpression, timezone, fromDate = new Date()) {
  try {
    const tz = timezone || getDefaultTimezone();
    const options = {
      currentDate: fromDate,
      tz
    };

    const interval = parser.parseExpression(cronExpression, options);
    return Math.floor(interval.next().getTime() / 1000);
  } catch (error) {
    throw new Error(`Invalid cron expression "${cronExpression}": ${error.message}`);
  }
}

/**
 * Validate a cron expression
 * @param {string} cronExpression - Cron expression to validate
 * @returns {boolean} True if valid
 */
export function isValidCron(cronExpression) {
  try {
    parser.parseExpression(cronExpression);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get human-readable description of a cron expression
 * @param {string} cronExpression - Cron expression
 * @returns {string} Human-readable description
 */
export function describeCron(cronExpression) {
  // Simple descriptions for common patterns
  const patterns = {
    '* * * * *': 'Every minute',
    '*/5 * * * *': 'Every 5 minutes',
    '*/15 * * * *': 'Every 15 minutes',
    '*/30 * * * *': 'Every 30 minutes',
    '0 * * * *': 'Every hour',
    '0 0 * * *': 'Every day at midnight',
    '0 8 * * *': 'Every day at 8:00 AM',
    '0 9 * * 1-5': 'Weekdays at 9:00 AM',
    '0 0 1 * *': 'First day of every month at midnight',
    '0 0 * * 0': 'Every Sunday at midnight',
    '0 0 * * 1': 'Every Monday at midnight'
  };

  return patterns[cronExpression] || cronExpression;
}
