# Metric Model

## Historical Usage and Resources

Collectors store usage events, system summaries, and PM2 summaries in Dashboard's database. Workbench usage readers aggregate cost, tokens, and cache usage for the requested session group and time range. Resource readers query system and PM2 summaries.

Every usage sample carries the runtime that produced it (`metric_points.runtime`), and cost and token readers group by runtime. A child runtime started inside a session is counted under its own runtime, never under the session's runtime. A child that an agent starts in the session (`claude -p`, `codex exec`) inherits the run variables and is counted under the group and run that started it: a `codex exec` in a Claude session adds Codex cost to that group. A child that zylos starts itself (the evaluation child of `zylos upgrade <component> --check`, the fixer of `zylos doctor`, the account checks of `zylos init` and login) has no group or run, whoever ran the command: its record goes to the legacy `activity-monitor/` directory and its samples carry no group. Collectors mark every child sample (`dimensions.child = true`) when they write it, so the sample stays recognizable after its transcript registration is pruned. A sample with no group, no run (`dimensions.run_id`) and the child mark is **Other**: it counts in instance-wide totals and in no group's view, not Origin's and not the group it was started from. The usage page shows it under the instance total as "Including Other $X" (shown at $0 too; `totals.otherCost` of `/api/usage/series`), so the instance total equals the sum of every group's view plus Other. A child that carries a run stays with that run's group; in single-session mode it has a run and no group and stays in Origin. Usage rows without a group that are not Other, including samples written before child records existed, still belong to Origin (see [Data Sources](data-sources.md)).

Calendar-day bounds use `src/lib/day-bounds.js` and the requested instance time zone, including daylight-saving changes. The store performs the underlying historical aggregation.

## Current State

Current Agent state, tools, session identity, context observations, and account usage come directly from Core through `CoreState` and workbench snapshots. Historical samples do not supply current state. The legacy `MetricResolver` source chains and `StatuslineCollector` have been removed.
