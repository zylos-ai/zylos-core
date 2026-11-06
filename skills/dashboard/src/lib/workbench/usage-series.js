import { costRows, costSummary, prepareUsageBuckets, summarizeCosts, usageIntervals, usageBounds } from './cost-query.js';

export { usageBounds } from './cost-query.js';

export function usageSeries(store, c4Reader, options = {}) {
  const now = options.now ?? new Date();
  const bounds = usageBounds({ ...options, now });
  const { since, until, bucket, tz } = bounds;
  prepareUsageBuckets(store);
  const costs = costRows(store, bounds);
  const tokens = store.db.prepare(`
    SELECT runtime, workbench_usage_bucket(timestamp, @bucket, @tz) AS at,
      SUM(COALESCE(json_extract(dimensions, '$.total_input'), 0) + COALESCE(json_extract(dimensions, '$.output'), 0)) AS value
    FROM metric_points WHERE metric_name = 'usage_event' AND timestamp BETWEEN @since AND @until
    GROUP BY runtime, at ORDER BY at, runtime
  `).all({ since, until, bucket, tz });
  const rotations = store.db.prepare(`
    SELECT workbench_usage_bucket(timestamp, @bucket, @tz) AS at, COUNT(*) AS value
    FROM runtime_events WHERE event_type = 'rotate_done' AND timestamp BETWEEN @since AND @until
    GROUP BY at ORDER BY at
  `).all({ since, until, bucket, tz });
  const tools = store.db.prepare(`
    SELECT COALESCE(json_extract(metadata, '$.tool_name'), 'unknown') AS name, COUNT(*) AS count
    FROM runtime_events WHERE event_type = 'post_tool_use' AND timestamp BETWEEN @since AND @until
    GROUP BY name ORDER BY count DESC, name ASC LIMIT 10
  `).all({ since, until });
  const toolTotal = store.db.prepare(`SELECT COUNT(*) AS count FROM runtime_events
    WHERE event_type = 'post_tool_use' AND timestamp BETWEEN ? AND ?`).get(since, until).count;
  const intervals = usageIntervals(bounds);
  // The existing reader's epoch buckets cannot express local calendar days.
  // Read each interval's totals with hour buckets, keeping intermediate output
  // bounded by hours in that day rather than seconds containing traffic.
  const messages = intervals.map(({ at, since: from, until: to }) => ({ at,
    ...c4Reader.getMessageSeries({ since: from, until: to, bucketSeconds: 3600 }).total }));
  const messageTotal = messages.reduce((total, point) =>
    ({ in: total.in + point.in, out: total.out + point.out }), { in: 0, out: 0 });
  const costTotals = summarizeCosts(costs);
  return { ...bounds, buckets: intervals.map(({ at }) => at), scope: 'all_groups',
    totals: { tokens: tokens.reduce((total, row) => total + row.value, 0), cost: costTotals.total,
      costByRuntime: costTotals.byRuntime, messages: messageTotal,
      rotations: rotations.reduce((total, row) => total + row.value, 0), tools: toolTotal },
    costByRuntime: costs, tokensByRuntime: tokens, messages, rotations, tools,
    projects: store.getProjectDistribution({ since, until }), costSummary: costSummary(store, { tz: options.tz, now }) };
}
