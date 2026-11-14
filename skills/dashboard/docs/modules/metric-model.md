# Metric Model

## Module Responsibilities

`src/lib/metric-resolver.js` selects currently available samples for collected metrics and explicitly returns their source, freshness, confidence, alternatives, and fallback reason. It handles historical metrics and aggregation; `CoreState` separately reads authoritative current Agent state and current session usage directly from Core.

## Fixed Source Chains

The resolver's source priorities are defined in `METRIC_CHAINS`, rather than dynamically discovered through adapter capabilities. Current coverage:

| Metric | Main source chain |
|---|---|
| `context_pct` | statusline summary → JSONL usage → statusline → Codex rollout → token estimate |
| `session_cost` | statusline summary → statusline → JSONL usage → token price estimate |
| `daily_cost` | JSONL usage → statusline delta → token price estimate |
| `cache_hit_rate` | statusline summary → JSONL usage → current statusline usage → JSONL usage |
| `cpu_pct`, memory, disk | system summary → system sample |
| `ttft`, `turn_duration` | Codex rollout |
| `tool_duration` | post-tool hook sample |

Rate limit metrics are read separately from Core account usage and return unknown when the reset window has expired, so an old window's percentage is not displayed as a current value.

## Runtime Filtering

- `statusline`, `statusline_delta`, and `statusline_current_usage` are Claude-only.
- `rollout` is Codex-only.
- `system` is a runtime-neutral source.
- Other records must match the current runtime, preventing samples from the previous runtime from being reused after a runtime switch.

## Selection and Freshness

The default freshness threshold is 120 seconds, configurable through `metricStalenessSeconds`. The resolver collects candidates in source-chain order:

1. Select the first source that is still fresh and has a valid value.
2. If the preferred source is unavailable or stale, select a later fresh source and set `fallback_reason`.
3. If all candidates are stale, return the first available candidate in the chain, explicitly reporting its sample age and "All sources stale".
4. Return `value: null` when there are no candidates or the metric is unknown; do not fabricate a default value.

Typical output:

```json
{
  "value": 42,
  "selected_source": "jsonl_usage",
  "freshness": 8,
  "confidence": "actual",
  "alternatives": [],
  "fallback_reason": "statusline data stale or unavailable, using jsonl_usage"
}
```

`alternatives` retains each discovered candidate's value, age, freshness, and confidence for diagnostics and UI explanations of source selection.

## Aggregation

For cost and cache hit rate, `resolveAggregated()` returns:

- The current session;
- The current calendar day (with day boundaries calculated using `TZ`);
- The last seven calendar days.

The store performs the underlying aggregation. API time-series endpoints can also query token, cost, and cache data by time range and bucket.

## Boundary with Current State

Do not infer the following data from historical metric chains:

- Current Agent state, active tools, and session identity;
- The current session's context observation;
- Core account 5-hour / 7-day usage windows.

`CoreState` and the Core session reader supply these data. Keeping the two paths separate prevents historical samples from masquerading as live state after session, runtime, or identity changes.
