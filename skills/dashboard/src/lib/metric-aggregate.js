export function aggregateMetricValue(store, metric, bounds) {
  if (metric === 'cost') return store.aggregateCost(bounds);
  if (metric === 'cache') return store.aggregateCacheRate(bounds);
  return store.aggregateTokens(bounds);
}

export function latestCodexRolloutSessionBounds(store) {
  const sessionId = store.latestCodexRolloutPath?.('codex')?.session_id;
  return sessionId ? { sessionId, until: new Date().toISOString() } : null;
}

export function resolveAggregateValue(store, metric, bounds, { runtime = 'claude', period = 'session' } = {}) {
  let value = bounds === null ? null : aggregateMetricValue(store, metric, bounds);
  let selectedBounds = bounds;

  if (period === 'session' && runtime === 'codex' && value == null) {
    const fallbackBounds = latestCodexRolloutSessionBounds(store);
    if (fallbackBounds && fallbackBounds.sessionId !== selectedBounds?.sessionId) {
      const fallbackValue = aggregateMetricValue(store, metric, fallbackBounds);
      if (fallbackValue != null) {
        selectedBounds = fallbackBounds;
        value = fallbackValue;
      }
    }
  }

  return { value, bounds: selectedBounds };
}
