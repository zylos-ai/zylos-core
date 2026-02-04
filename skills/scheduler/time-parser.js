/**
 * Human-friendly time parsing for Scheduler V2
 * Uses chrono-node for natural language parsing
 */

import chrono from 'chrono-node';

/**
 * Parse a human-friendly time string into a Unix timestamp
 * Examples:
 *   - "in 30 minutes"
 *   - "tomorrow at 9am"
 *   - "next monday at 8am"
 *   - "2025-01-15 14:30"
 *
 * @param {string} timeStr - Human-friendly time string
 * @param {Date} referenceDate - Reference date (default: now)
 * @returns {number|null} Unix timestamp or null if parsing failed
 */
export function parseTime(timeStr, referenceDate = new Date()) {
  // Try chrono-node first (for natural language)
  const result = chrono.parseDate(timeStr, referenceDate, { forwardDate: true });

  if (result) {
    return Math.floor(result.getTime() / 1000);
  }

  // Try parsing as ISO date string
  const isoDate = new Date(timeStr);
  if (!isNaN(isoDate.getTime())) {
    return Math.floor(isoDate.getTime() / 1000);
  }

  return null;
}

/**
 * Parse a duration string into seconds
 * Examples:
 *   - "30 minutes" -> 1800
 *   - "2 hours" -> 7200
 *   - "1 day" -> 86400
 *
 * @param {string} durationStr - Duration string
 * @returns {number|null} Duration in seconds or null if parsing failed
 */
export function parseDuration(durationStr) {
  const str = durationStr.toLowerCase().trim();

  // Common patterns
  const patterns = [
    { regex: /^(\d+)\s*(?:s|sec|second|seconds?)$/i, multiplier: 1 },
    { regex: /^(\d+)\s*(?:m|min|minute|minutes?)$/i, multiplier: 60 },
    { regex: /^(\d+)\s*(?:h|hr|hour|hours?)$/i, multiplier: 3600 },
    { regex: /^(\d+)\s*(?:d|day|days?)$/i, multiplier: 86400 },
    { regex: /^(\d+)\s*(?:w|week|weeks?)$/i, multiplier: 604800 }
  ];

  for (const { regex, multiplier } of patterns) {
    const match = str.match(regex);
    if (match) {
      return parseInt(match[1], 10) * multiplier;
    }
  }

  return null;
}

/**
 * Format a Unix timestamp for display
 * @param {number} timestamp - Unix timestamp
 * @param {string} timezone - Timezone (default: from TZ env var or UTC)
 * @returns {string} Formatted date string
 */
export function formatTime(timestamp, timezone = process.env.TZ || 'UTC') {
  const date = new Date(timestamp * 1000);
  return date.toLocaleString('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

/**
 * Format a duration in seconds for display
 * @param {number} seconds - Duration in seconds
 * @returns {string} Human-readable duration
 */
export function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * Get relative time description
 * @param {number} timestamp - Unix timestamp
 * @returns {string} Relative time (e.g., "in 5 minutes", "2 hours ago")
 */
export function getRelativeTime(timestamp) {
  const now = Math.floor(Date.now() / 1000);
  const diff = timestamp - now;
  const absDiff = Math.abs(diff);

  const suffix = diff >= 0 ? '' : ' ago';
  const prefix = diff >= 0 ? 'in ' : '';

  if (absDiff < 60) return `${prefix}${absDiff}s${suffix}`;
  if (absDiff < 3600) return `${prefix}${Math.floor(absDiff / 60)}m${suffix}`;
  if (absDiff < 86400) return `${prefix}${Math.floor(absDiff / 3600)}h${suffix}`;
  return `${prefix}${Math.floor(absDiff / 86400)}d${suffix}`;
}
