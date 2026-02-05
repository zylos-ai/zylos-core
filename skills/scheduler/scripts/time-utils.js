/**
 * Time Utilities
 * Natural language and structured time parsing for scheduling
 */

import * as chrono from 'chrono-node';

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
 * Uses a hybrid approach for maximum robustness with LLM-generated input:
 * 1. chrono-node for natural language (e.g., "2.5 hours", "1 hour 30 minutes", "an hour")
 * 2. Regex patterns for simple formats (e.g., "2h", "30m")
 * 3. Pure numbers as seconds (e.g., "7200")
 *
 * Examples:
 *   - "30 minutes" -> 1800
 *   - "2 hours" -> 7200
 *   - "2.5 hours" -> 9000
 *   - "1 hour 30 minutes" -> 5400
 *   - "an hour" -> 3600
 *   - "2h" -> 7200
 *   - "7200" -> 7200
 *   - "1 day" -> 86400
 *
 * @param {string} durationStr - Duration string
 * @returns {number|null} Duration in seconds or null if parsing failed
 */
export function parseDuration(durationStr) {
  const str = durationStr.trim();

  // Method 1: Try chrono-node for natural language parsing
  // This handles: "2 hours", "90 minutes", "2.5 hours", "1 hour 30 minutes", "an hour", etc.
  // Prepend "in" to make it work as relative time
  try {
    const chronoResult = chrono.parseDate(`in ${str}`, new Date());
    if (chronoResult) {
      const now = Math.floor(Date.now() / 1000);
      const target = Math.floor(chronoResult.getTime() / 1000);
      const duration = target - now;
      // Only accept positive durations > 0 and < 1 year (sanity check)
      if (duration > 0 && duration < 31536000) {
        return duration;
      }
    }
  } catch (err) {
    // If chrono fails, continue to fallback methods
  }

  // Method 2: Fallback to simple regex patterns (for compatibility and short forms)
  const patterns = [
    { regex: /^(\d+(?:\.\d+)?)\s*(?:s|sec|second|seconds?)$/i, multiplier: 1 },
    { regex: /^(\d+(?:\.\d+)?)\s*(?:m|min|minute|minutes?)$/i, multiplier: 60 },
    { regex: /^(\d+(?:\.\d+)?)\s*(?:h|hr|hour|hours?)$/i, multiplier: 3600 },
    { regex: /^(\d+(?:\.\d+)?)\s*(?:d|day|days?)$/i, multiplier: 86400 },
    { regex: /^(\d+(?:\.\d+)?)\s*(?:w|week|weeks?)$/i, multiplier: 604800 }
  ];

  for (const { regex, multiplier } of patterns) {
    const match = str.match(regex);
    if (match) {
      const value = parseFloat(match[1]);
      if (!isNaN(value) && value > 0) {
        return Math.floor(value * multiplier);
      }
    }
  }

  // Method 3: Pure number = seconds
  const num = parseFloat(str);
  if (!isNaN(num) && num > 0) {
    return Math.floor(num);
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
  try {
    return date.toLocaleString('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  } catch {
    return date.toLocaleString('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }
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
