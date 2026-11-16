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

/** Scheduler view calculations use seconds internally; only declared time fields cross this boundary. */
export function scheduleTimes(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(scheduleTimes);
  const seconds = new Set(['nextRunAt', 'lastRunAt', 'updatedAt', 'executedAt', 'completedAt']);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    seconds.has(key) && typeof child === 'string' ? instantSeconds(child)
      : ['runs', 'in24h'].includes(key) && Array.isArray(child) ? child.map(instantSeconds)
      : key === 'readAt' && typeof child === 'string' ? instantMs(child) : scheduleTimes(child)]));
}

/** Conversation activity is metadata; user-authored message/form content is never passed here. */
export function activityTimes(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(activityTimes);
  const clocks = new Set(['readAt', 'sampledAt', 'since', 'at', 'start', 'end', 'from', 'now', 'lastActivityAt', 'delivered']);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    clocks.has(key) && typeof child === 'string' ? instantMs(child) : activityTimes(child)]));
}
