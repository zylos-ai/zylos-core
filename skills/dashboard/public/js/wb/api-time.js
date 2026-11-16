/** Parse wire instants without confusing durations, counters, or opaque cursors with timestamps. */
export function instantMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  return typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
}
export function instantSeconds(value) {
  return typeof value === 'number' ? value : instantMs(value) / 1000;
}
export function conversationStampMs(value) {
  return typeof value === 'number' ? value > 0 ? (value - 2440587.5) * 86400000 : NaN : instantMs(value);
}

export { scheduleTimes, activityTimes } from './wire-time.js';
