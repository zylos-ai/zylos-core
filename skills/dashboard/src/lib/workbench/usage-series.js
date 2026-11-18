import { costRows, summarizeCosts, usageIntervals, usageBounds, usageBucketSql, usageTokenRows } from './cost-query.js';

export { usageBounds } from './cost-query.js';

export function usageSeries(store, c4Reader, options = {}) {
  const now = options.now ?? new Date();
  const bounds = usageBounds({ ...options, now });
  const { since, until } = bounds;
  const intervals = usageIntervals(bounds), groups = usageBucketSql(intervals);
  const parameters = { since, until, ...groups.params };
  const costs = costRows(store, { ...bounds, intervals });
  const tokenRows = usageTokenRows(store, { ...bounds, intervals });
  const tokens = tokenRows.map(row => ({ runtime: row.runtime, at: row.at, value: row.inputTokens + row.outputTokens }));
  const cacheBuckets = new Map(intervals.map(({ at }) => [at, { at, inputTokens: 0, cacheReadTokens: 0 }]));
  for (const row of tokenRows) {
    const value = cacheBuckets.get(row.at);
    value.inputTokens += row.inputTokens;
    value.cacheReadTokens += row.cacheReadTokens;
  }
  const cache = [...cacheBuckets.values()].map(row => ({ ...row,
    value: row.inputTokens > 0 ? row.cacheReadTokens / row.inputTokens : null }));
  const inputTokens = tokenRows.reduce((total, row) => total + row.inputTokens, 0);
  const cacheReadTokens = tokenRows.reduce((total, row) => total + row.cacheReadTokens, 0);
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
  // Part of the instance total that no group owns; see costRows.
  const otherCost = summarizeCosts(costRows(store, { ...bounds, bucket: 'total', other: true })).total;
  return { ...bounds, buckets: intervals.map(({ at }) => at), scope: 'all_groups',
    cache,
    totals: { inputTokens, cacheReadTokens, cacheHitRate: inputTokens > 0 ? cacheReadTokens / inputTokens : null, tokens: tokens.reduce((total, row) => total + row.value, 0), cost: costTotals.total,
      costByRuntime: costTotals.byRuntime, otherCost, messages: messageTotal,
      rotations: rotations === null ? null : rotations.reduce((total, row) => total + row.value, 0), tools: toolTotal },
    costByRuntime: costs, tokensByRuntime: tokens, messages,
    messagesReason: messageSeries.reason ?? null, messagesSampledAt: messageSeries.sampledAt ?? null,
    rotations, tools,
    runtimeEventsUnknown, projects: store.getProjectDistribution({ since, until }) };
}
