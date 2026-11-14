import { restartEffect } from '../../../public/js/wb/timeline-rows.js';

/** Read run segments from imported events without changing their attribution. */
export function createRuns({ store, getSnapshot = async () => ({ rows: [] }) } = {}) {
  // `types` narrows what is counted (n, totalEvents, unattributed), not which runs exist or when they
  // start and end: a run whose events are all of other types is still listed, with n 0. Counts cover the events the
  // timeline shows: an automatic restart's crash report is not one.
  return async function runs(key, { before, limit = 3, types } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw Object.assign(new Error('Invalid run page size'), { code: 'INVALID_ARGUMENT', statusCode: 400 });
    }
    if (before !== undefined && !Number.isFinite(Date.parse(before))) {
      throw Object.assign(new Error('Invalid run page boundary'), { code: 'INVALID_ARGUMENT', statusCode: 400 });
    }
    const snapshot = await getSnapshot() ?? { rows: [] };
    const group = key === 'origin' && snapshot.view === 'single' ? null : key;
    const currentRunId = snapshot.rows?.find(row => row.sessionGroup === group)?.live?.runId ?? null;
    const params = { key: group, limit, ...(before === undefined ? {} : { before }) };
    const counted = Array.isArray(types) && types.length ? types.slice(0, 100) : null;
    const typeParams = Object.fromEntries((counted ?? []).map((type, i) => [`type${i}`, type]));
    const counts = counted ? `SUM(CASE WHEN event_type IN (${counted.map((_, i) => `@type${i}`).join(',')}) THEN 1 ELSE 0 END)` : 'COUNT(*)';
    const rows = store.db.prepare(`SELECT run_id AS runId, MIN(timestamp) AS startAt,
      MAX(timestamp) AS endAt, ${counts} AS n FROM runtime_events
      WHERE session_group IS @key AND run_id IS NOT NULL GROUP BY run_id
      ${before === undefined ? '' : 'HAVING MIN(timestamp) < @before'}
      ORDER BY startAt DESC, run_id LIMIT @limit`).all({ ...params, ...typeParams });
    const endings = store.db.prepare(`SELECT event_type, runtime, metadata FROM runtime_events
      WHERE session_group IS ? AND run_id = ?
        AND event_type IN ('reclaim_done','crash_detected','rotate_done','manual_restart_done')
      ORDER BY event_seq DESC`);
    // The supervisor's own restart of a run that stopped responding or whose tool ran too long: the exit it causes is
    // also reported as a crash a moment later, so the restart decides the run's end.
    const restart = store.db.prepare(`SELECT event_type FROM runtime_events
      WHERE session_group IS ? AND run_id = ? AND event_type IN ('no_response_restart','tool_timeout_restart')
      ORDER BY event_seq DESC LIMIT 1`);
    const endReason = run => {
      if (run.runId === currentRunId) return 'running';
      const automatic = restart.get(group, run.runId)?.event_type;
      if (automatic) return automatic === 'no_response_restart' ? 'auto_restart_no_response' : 'auto_restart_tool_timeout';
      for (const event of endings.iterate(group, run.runId)) {
        let metadata;
        try { metadata = JSON.parse(event.metadata ?? '{}'); } catch { metadata = {}; }
        if (event.event_type === 'reclaim_done') return metadata?.reason ?? 'reclaim';
        if (event.event_type === 'crash_detected') return 'crash';
        if (event.event_type === 'manual_restart_done') return 'manual_restart';
        if (event.runtime === 'codex' && !metadata?.oldSessionId) return 'rotate';
      }
      return 'unknown';
    };
    const totals = store.db.prepare(`SELECT COUNT(DISTINCT run_id) AS totalRuns,
      COALESCE(${counts}, 0) AS totalEvents FROM runtime_events
      WHERE session_group IS @key AND run_id IS NOT NULL`).get({ key: group, ...typeParams });
    const { unattributed } = store.db.prepare(`SELECT COALESCE(${counts}, 0) AS unattributed FROM runtime_events
      WHERE session_group IS @key AND run_id IS NULL`).get({ key: group, ...typeParams });
    // The crash report of an exit an automatic restart caused is not shown on the timeline (restartEffect), so the
    // counts leave it out too, run by run, in runs that had such a restart.
    const hidden = new Map();
    if (!counted || counted.includes('crash_detected')) {
      const runsWithRestart = new Map();
      for (const event of store.db.prepare(`SELECT run_id, event_type, timestamp FROM runtime_events
        WHERE session_group IS @key AND event_type IN ('no_response_restart','tool_timeout_restart','crash_detected')
          AND run_id IN (SELECT run_id FROM runtime_events WHERE session_group IS @key
            AND event_type IN ('no_response_restart','tool_timeout_restart'))`).iterate({ key: group })) {
        if (!runsWithRestart.has(event.run_id)) runsWithRestart.set(event.run_id, []);
        runsWithRestart.get(event.run_id).push(event);
      }
      for (const [runId, events] of runsWithRestart) {
        const effect = restartEffect(events), exits = events.filter(event => effect(event) === 'exit').length;
        if (exits) hidden.set(runId, exits);
      }
    }
    const hiddenTotal = [...hidden.values()].reduce((sum, count) => sum + count, 0);
    return { runs: rows.map(run => ({ ...run, n: run.n - (hidden.get(run.runId) ?? 0), endReason: endReason(run) })),
      ...totals, totalEvents: totals.totalEvents - hiddenTotal, unattributed };
  };
}
