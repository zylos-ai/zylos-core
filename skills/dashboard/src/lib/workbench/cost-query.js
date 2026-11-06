import { dayBoundsUTC } from '../metric-resolver.js';

export function resolveUsageTimezone(tz) {
  try {
    const value = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC' }).resolvedOptions().timeZone;
    return { tz: value, tzFallback: !tz };
  } catch {
    return { tz: 'UTC', tzFallback: true };
  }
}

function invalidRange() {
  return Object.assign(new Error('invalid_range'), { statusCode: 400, code: 'invalid_range' });
}

export function usageBounds({ range = '7d', since, until, tz, now = new Date() } = {}) {
  const timezone = resolveUsageTimezone(tz);
  let bounds;
  if (['24h', '7d', '30d'].includes(range)) {
    bounds = range === '24h'
      ? { since: new Date(Math.floor(now.getTime() / 3600000) * 3600000 - 23 * 3600000).toISOString(), until: now.toISOString() }
      : dayBoundsUTC(timezone.tz, range === '7d' ? 6 : 29, now);
  } else if (range === 'month') {
    const day = Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone.tz, day: 'numeric' }).format(now));
    bounds = dayBoundsUTC(timezone.tz, day - 1, now);
  } else if (range === 'custom') {
    const start = new Date(since), end = new Date(until);
    if (!since || !until || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw invalidRange();
    bounds = { since: start.toISOString(), until: end.toISOString() };
  } else throw invalidRange();
  return { range, ...bounds, ...timezone, bucket: range === '24h' ? 'hour' : 'day' };
}

export function usageBucket(timestamp, bucket, tz) {
  if (bucket === 'total') return null;
  const date = new Date(timestamp);
  if (bucket === 'hour') return new Date(Math.floor(date.getTime() / 3600000) * 3600000).toISOString();
  return dayBoundsUTC(tz, 0, date).since;
}

// Keep bucket identities and reader bounds together. Calendar days can span
// 23 or 25 hours; epoch-hour buckets remain fixed-width.
export function usageIntervals({ since, until, bucket = 'day', tz = 'UTC' }) {
  const start = new Date(since).getTime(), end = new Date(until).getTime();
  const intervals = [];
  for (let cursor = start; cursor <= end;) {
    const at = usageBucket(cursor, bucket, tz);
    const next = bucket === 'hour' ? new Date(at).getTime() + 3600000
      : new Date(dayBoundsUTC(tz, -1, new Date(cursor)).since).getTime();
    intervals.push({ at, since: new Date(cursor).toISOString(),
      until: new Date(Math.min(end, next - 1)).toISOString() });
    cursor = next;
  }
  return intervals;
}

// SQLite does not implement IANA calendar-day buckets. Keep the timezone-aware
// scalar stateless, so every query still aggregates in SQL without reading all
// metric rows into application memory.
export function prepareUsageBuckets(store) {
  store.db.function('workbench_usage_bucket', { deterministic: true }, usageBucket);
}

export function costRows(store, { since, until, bucket = 'day', tz = 'UTC', byModel = false }) {
  prepareUsageBuckets(store);
  return store.db.prepare(`
    SELECT runtime, workbench_usage_bucket(timestamp, @bucket, @tz) AS at,
      ${byModel ? 'model,' : ''} SUM(cost) AS value
    FROM (
      SELECT runtime, timestamp, json_extract(dimensions, '$.model') AS model, metric_value AS cost FROM metric_points
      WHERE metric_name = 'api_request_cost' AND timestamp BETWEEN @since AND @until
      UNION ALL
      SELECT runtime, timestamp, json_extract(dimensions, '$.model') AS model, json_extract(dimensions, '$.cost') AS cost FROM metric_points
      WHERE metric_name = 'usage_event' AND json_extract(dimensions, '$.cost') IS NOT NULL
        AND timestamp BETWEEN @since AND @until
    ) GROUP BY runtime, at${byModel ? ', model' : ''} ORDER BY at, runtime${byModel ? ', model' : ''}
  `).all({ since, until, bucket, tz });
}

export function summarizeCosts(rows) {
  const byRuntime = { claude: 0, codex: 0 };
  let total = 0;
  for (const row of rows) {
    total += row.value;
    byRuntime[row.runtime] = (byRuntime[row.runtime] || 0) + row.value;
  }
  return { total, byRuntime };
}

export function costSummary(store, { tz, now = new Date() } = {}) {
  const timezone = resolveUsageTimezone(tz);
  tz = timezone.tz;
  const today = costRows(store, { ...dayBoundsUTC(tz, 0, now), tz });
  const weekBounds = usageBounds({ range: '7d', tz, now });
  const week = costRows(store, weekBounds);
  const days = new Map(usageIntervals(weekBounds).map(({ at }) =>
    [at, { at, claude: 0, codex: 0, total: 0 }]));
  for (const row of week) {
    if (!days.has(row.at)) days.set(row.at, { at: row.at, claude: 0, codex: 0, total: 0 });
    const day = days.get(row.at);
    day[row.runtime] = (day[row.runtime] || 0) + row.value;
    day.total += row.value;
  }
  return { ...timezone, today: summarizeCosts(today), sevenDay: summarizeCosts(week), daily: [...days.values()] };
}
