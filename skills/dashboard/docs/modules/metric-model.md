# Metric Model

## Historical Usage and Resources

Collectors store usage events, system summaries, and PM2 summaries in Dashboard's database. Workbench usage readers aggregate cost, tokens, and cache usage for the requested session group and time range. Resource readers query system and PM2 summaries.

Every usage sample carries the runtime that produced it (`metric_points.runtime`), and cost and token readers group by runtime. A child runtime started inside a session is counted under its own runtime, never under the session's runtime. A child that an agent starts in the session (`claude -p`, `codex exec`) inherits the run variables and is counted under the group and run that started it: a `codex exec` in a Claude session adds Codex cost to that group. A child that zylos starts itself (for example the evaluation child of `zylos upgrade <component> --check`) has no group or run: its record goes to the legacy `activity-monitor/` directory and its samples carry no group, so it counts only in instance-wide totals and, like every usage row without a group, in Origin's group view, never in the group it was started from (see [Data Sources](data-sources.md)).

Calendar-day bounds use `src/lib/day-bounds.js` and the requested instance time zone, including daylight-saving changes. The store performs the underlying historical aggregation.

## Current State

Current Agent state, tools, session identity, context observations, and account usage come directly from Core through `CoreState` and workbench snapshots. Historical samples do not supply current state. The legacy `MetricResolver` source chains and `StatuslineCollector` have been removed.
