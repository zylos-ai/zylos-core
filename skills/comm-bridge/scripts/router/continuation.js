/** Restart pacing belongs to the Router process; continuation controls stay in C4. */
export function createContinuationRestarts({ now, deps, diagnostic }) {
  const groups = new Map();
  function entry(group) {
    if (!groups.has(group)) groups.set(group, { attempts: 0, failures: 0, absentSince: null, readySince: null, readyRunId: null, lastAlertAt: -Infinity });
    return groups.get(group);
  }
  function observe(group, live) {
    const state = groups.get(group);
    if (!state) return;
    if (live.present) state.absentSince = null;
    else state.absentSince ??= now();
    if (live.ready && live.runId) {
      if (state.readyRunId !== live.runId) { state.readyRunId = live.runId; state.readySince = now(); }
      if (now() - state.readySince >= 60000) state.attempts = 0;
    } else { state.readySince = null; state.readyRunId = null; }
  }
  return {
    observe,
    canStart(group) {
      const state = entry(group);
      state.absentSince ??= now();
      return now() - state.absentSince >= Math.min(5 * 2 ** Math.min(state.attempts, 4), 60) * 1000;
    },
    started(group) {
      const state = entry(group);
      state.attempts++; state.absentSince = null; state.readySince = null; state.readyRunId = null;
    },
    ready(group) { entry(group).failures = 0; },
    failed(group, runId) {
      const state = entry(group);
      state.failures++; state.absentSince = now(); state.readySince = null; state.readyRunId = null;
      if (state.failures >= 5 && now() - state.lastAlertAt >= 1800000) {
        state.lastAlertAt = now();
        const fields = { sessionGroup: group, runId, failures: state.failures };
        diagnostic('continuation_start_failed', { session_group: group, runId, failures: state.failures });
        deps.alert?.('continuation_start_failed', fields);
      }
    },
  };
}
