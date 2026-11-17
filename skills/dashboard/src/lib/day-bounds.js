import { cachedDateTimeFormat } from './date-format-cache.js';

export function dayBoundsUTC(tz, daysBack = 0, now = new Date()) {
  const fmt = cachedDateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric'
  });
  const parts = (date) => Object.fromEntries(fmt.formatToParts(date)
    .filter(({ type }) => type !== 'literal')
    .map(({ type, value }) => [type, Number(value)]));
  const p = parts(now);
  const targetDate = Date.UTC(p.year, p.month - 1, p.day - daysBack);
  // Find the first existing instant of the local date. Midnight can be skipped
  // by a DST change; solving its offset directly can oscillate between dates.
  let low = targetDate - 36 * 3600000, high = targetDate + 36 * 3600000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2), local = parts(new Date(middle));
    if (Date.UTC(local.year, local.month - 1, local.day) < targetDate) low = middle + 1;
    else high = middle;
  }
  return { since: new Date(low).toISOString(), until: now.toISOString() };
}
