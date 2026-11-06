import { costRows, summarizeCosts, usageIntervals, usageBounds, usageBucketSql } from './cost-query.js';

export { usageBounds } from './cost-query.js';

export function usageSeries(store, c4Reader, options = {}) {
  const now = options.now ?? new Date();
  const bounds = usageBounds({ ...options, now });
  const { since, until } = bounds;
  const intervals = usageIntervals(bounds), groups = usageBucketSql(intervals);
  const parameters = { since, until, ...groups.params };
  const costs = costRows(store, { ...bounds, intervals });
  const tokens = store.db.prepare(`
    SELECT runtime, ${groups.sql} AS at,
      SUM(COALESCE(json_extract(dimensions, '$.total_input'), 0) + COALESCE(json_extract(dimensions, '$.output'), 0)) AS value
    FROM metric_points WHERE metric_name = 'usage_event' AND timestamp BETWEEN @since AND @until
    GROUP BY runtime, at ORDER BY at, runtime
  `).all(parameters);
  // Runtime events are retained for seven rolling days. A wider selection
  // cannot prove zero rotations/tools, so report the whole item as unknown.
  const runtimeEventsUnknown = new Date(since).getTime() < now.getTime() - 7 * 86400000;
  const rotations = runtimeEventsUnknown ? null : store.db.prepare(`
    SELECT ${groups.sql} AS at, COUNT(*) AS value
    FROM runtime_events WHERE event_type = 'rotate_done' AND timestamp BETWEEN @since AND @until
    GROUP BY at ORDER BY at
  `).all(parameters);
  const tools = runtimeEventsUnknown ? null : store.db.prepare(`
    SELECT COALESCE(json_extract(metadata, '$.tool_name'), 'unknown') AS name, COUNT(*) AS count
    FROM runtime_events WHERE event_type = 'post_tool_use' AND timestamp BETWEEN @since AND @until
    GROUP BY name ORDER BY count DESC, name ASC LIMIT 10
  `).all({ since, until });
  const toolTotal = runtimeEventsUnknown ? null : store.db.prepare(`SELECT COUNT(*) AS count FROM runtime_events
    WHERE event_type = 'post_tool_use' AND timestamp BETWEEN ? AND ?`).get(since, until).count;
  const messageSeries = c4Reader.getMessageSeries({ since, until, intervals });
  const messages = messageSeries.points;
  const messageTotal = messageSeries.total;
  const costTotals = summarizeCosts(costs);
  return { ...bounds, buckets: intervals.map(({ at }) => at), scope: 'all_groups',
    totals: { tokens: tokens.reduce((total, row) => total + row.value, 0), cost: costTotals.total,
      costByRuntime: costTotals.byRuntime, messages: messageTotal,
      rotations: rotations === null ? null : rotations.reduce((total, row) => total + row.value, 0), tools: toolTotal },
    costByRuntime: costs, tokensByRuntime: tokens, messages,
    messagesReason: messageSeries.reason ?? null, messagesSampledAt: messageSeries.sampledAt ?? null,
    rotations, tools,
    runtimeEventsUnknown, projects: store.getProjectDistribution({ since, until }) };
}
