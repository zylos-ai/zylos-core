import { dayBoundsUTC } from '../day-bounds.js';
import { costRows, resolveUsageTimezone, usageBounds, usageTokenRows } from './cost-query.js';

function emptyUsage() {
  return { tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheHitRate: null, cost: 0 };
}

function summarizePeriod(store, bounds, group) {
  const byRuntime = { claude: emptyUsage(), codex: emptyUsage() };
  for (const row of usageTokenRows(store, { ...bounds, bucket: 'total', group })) {
    const usage = byRuntime[row.runtime] ??= emptyUsage();
    usage.inputTokens += row.inputTokens;
    usage.outputTokens += row.outputTokens;
    usage.cacheReadTokens += row.cacheReadTokens;
  }
  for (const row of costRows(store, { ...bounds, bucket: 'total', group })) {
    (byRuntime[row.runtime] ??= emptyUsage()).cost += row.value;
  }
  const total = emptyUsage();
  for (const usage of Object.values(byRuntime)) {
    usage.tokens = usage.inputTokens + usage.outputTokens;
    usage.cacheHitRate = usage.inputTokens > 0 ? usage.cacheReadTokens / usage.inputTokens : null;
    for (const field of ['tokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cost']) total[field] += usage[field];
  }
  total.cacheHitRate = total.inputTokens > 0 ? total.cacheReadTokens / total.inputTokens : null;
  return { since: bounds.since, until: bounds.until, ...total, byRuntime };
}

// Summary and per-group reads share exactly the same records and calendar
// boundaries, so grouping cannot change the instance's token or cost totals.
export function usageSummary(store, { tz, now = new Date(), group } = {}) {
  const timezone = resolveUsageTimezone(tz);
  return { ...timezone, scope: group === undefined ? 'all_groups' : 'group',
    ...(group === undefined ? {} : { group }),
    today: summarizePeriod(store, dayBoundsUTC(timezone.tz, 0, now), group),
    sevenDay: summarizePeriod(store, dayBoundsUTC(timezone.tz, 6, now), group) };
}

function periodCost(store, bounds) {
  const byRuntime = { claude: 0, codex: 0 };
  for (const row of costRows(store, { ...bounds, bucket: 'total' })) {
    byRuntime[row.runtime] = (byRuntime[row.runtime] ?? 0) + row.value;
  }
  let cost = 0;
  for (const value of Object.values(byRuntime)) cost += value;
  return { since: bounds.since, until: bounds.until, cost };
}

function costSummary(store, timezone, today, sevenDay) {
  return { ...timezone, today: periodCost(store, today), sevenDay: periodCost(store, sevenDay) };
}

// Fleet records publish only the two instance cost totals. They read the same
// cost rows and add per runtime, then across runtimes, as usageSummary does.
export function usageCostSummary(store, { tz, now = new Date() } = {}) {
  const timezone = resolveUsageTimezone(tz);
  return costSummary(store, timezone, dayBoundsUTC(timezone.tz, 0, now), dayBoundsUTC(timezone.tz, 6, now));
}

// A cost summary may be reused for maxAgeMs. The key holds the resolved
// timezone and both period starts, so a new local day reads again immediately.
export function createUsageCostReader(store, { now = Date.now, maxAgeMs = 30_000 } = {}) {
  let cached = null;
  return ({ tz } = {}) => {
    const at = now(), date = new Date(at), timezone = resolveUsageTimezone(tz);
    const today = dayBoundsUTC(timezone.tz, 0, date), sevenDay = dayBoundsUTC(timezone.tz, 6, date);
    const key = [timezone.tz, timezone.tzFallback, today.since, sevenDay.since].join('\n');
    const age = at - cached?.readAt;
    if (cached?.key === key && age >= 0 && age < maxAgeMs) return cached.value;
    const value = costSummary(store, timezone, today, sevenDay);
    cached = { key, readAt: at, value };
    return value;
  };
}

export function usagePricing(store, { tz, now = new Date() } = {}) {
  const bounds = usageBounds({ range: '7d', tz, now });
  const models = costRows(store, { ...bounds, bucket: 'total', byModel: true })
    .map(({ runtime, model, value }) => ({ runtime, model, cost: value }));
  const input = `CASE WHEN metric_name = 'api_request_tokens'
    THEN COALESCE(json_extract(dimensions, '$.total_input'), metric_value, 0)
    ELSE COALESCE(json_extract(dimensions, '$.total_input'), 0) END`;
  const unmatched = store.db.prepare(`SELECT runtime, json_extract(dimensions, '$.model') AS model,
    SUM((${input})
      + COALESCE(json_extract(dimensions, '$.output'), 0)) AS tokens
    FROM metric_points WHERE metric_name IN ('usage_event', 'api_request_tokens')
      AND timestamp BETWEEN @since AND @until
      AND json_extract(dimensions, '$.cost') IS NULL
      AND ((${input}) > 0
        OR COALESCE(json_extract(dimensions, '$.output'), 0) > 0)
      AND (metric_name <> 'api_request_tokens' OR NOT EXISTS (
        SELECT 1 FROM metric_points AS costs WHERE costs.metric_name = 'api_request_cost'
          AND costs.session_id IS metric_points.session_id AND costs.runtime IS metric_points.runtime
          AND costs.timestamp = metric_points.timestamp))
    GROUP BY runtime, model ORDER BY runtime, model`).all({ since: bounds.since, until: bounds.until });
  return { ...bounds, models, unmatched };
}
