/** The public machine contract projects existing Dashboard observations only. */
export function buildAgentStatus({ state, readiness, sampledAt = new Date().toISOString() }) {
  const multi = state.session_mode === 'multi';
  const summary = state.group_summary;
  const runtime = state.runtime_info;
  const metrics = state.system_metrics;
  return {
    schema_version: 1,
    session_mode: multi ? 'multi' : 'single',
    sampled_at: sampledAt,
    state: multi ? (summary?.counts?.busy > 0 ? 'BUSY' : summary?.listKnown === true ? 'IDLE' : 'UNKNOWN') : state.state,
    groups: multi ? { running: summary?.running ?? 0,
      ...Object.fromEntries(['busy', 'idle', 'waiting', 'unknown', 'error', 'no_response'].map(key => [key, summary?.counts?.[key] ?? 0])) } : null,
    readiness,
    runtime: Object.fromEntries(['runtime', 'model', 'model_id', 'effort'].map(key => [key, runtime?.[key] ?? null])),
    context_pct: multi ? null : state.context_pct ?? null,
    cost: { session: multi ? null : state.session_cost ?? null, daily: state.daily_cost ?? null, weekly: state.weekly_cost ?? null },
    rate_limit_7d_pct: state.rate_limit_7d_pct ?? null,
    resources: { scope: metrics?.scope ?? 'host',
      ...Object.fromEntries(['cpu_pct', 'mem_pct', 'mem_used_bytes', 'mem_total_bytes', 'disk_pct', 'disk_free_bytes'].map(key => [key, metrics?.[key] ?? null])) },
  };
}
