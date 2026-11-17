# Metric Model

## Historical Usage and Resources

Collectors store usage events, system summaries, and PM2 summaries in Dashboard's database. Workbench usage readers aggregate cost, tokens, and cache usage for the requested session group and time range. Resource readers query system and PM2 summaries.

Calendar-day bounds use `src/lib/day-bounds.js` and the requested instance time zone, including daylight-saving changes. The store performs the underlying historical aggregation.

## Current State

Current Agent state, tools, session identity, context observations, and account usage come directly from Core through `CoreState` and workbench snapshots. Historical samples do not supply current state. The legacy `MetricResolver` source chains and `StatuslineCollector` have been removed.
