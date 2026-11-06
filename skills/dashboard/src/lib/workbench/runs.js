/** Read run segments from imported events without changing their attribution. */
export function createRuns({ store, getSnapshot = async () => ({ rows: [] }) } = {}) {
  return async function runs(key, { before, limit = 3 } = {}) {
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
    const rows = store.db.prepare(`SELECT run_id AS runId, MIN(timestamp) AS startAt,
      MAX(timestamp) AS endAt, COUNT(*) AS n FROM runtime_events
      WHERE session_group IS @key AND run_id IS NOT NULL GROUP BY run_id
      ${before === undefined ? '' : 'HAVING MIN(timestamp) < @before'}
      ORDER BY startAt DESC, run_id LIMIT @limit`).all(params);
    const endings = store.db.prepare(`SELECT event_type, runtime, metadata FROM runtime_events
      WHERE session_group IS ? AND run_id = ?
        AND event_type IN ('reclaim_done','crash_detected','rotate_done')
      ORDER BY event_seq DESC`);
    const endReason = run => {
      if (run.runId === currentRunId) return 'running';
      for (const event of endings.iterate(group, run.runId)) {
        let metadata;
        try { metadata = JSON.parse(event.metadata ?? '{}'); } catch { metadata = {}; }
        if (event.event_type === 'reclaim_done') return metadata?.reason ?? 'reclaim';
        if (event.event_type === 'crash_detected') return 'crash';
        if (event.runtime === 'codex' && !metadata?.oldSessionId) return 'rotate';
      }
      return 'unknown';
    };
    const totals = store.db.prepare(`SELECT COUNT(DISTINCT run_id) AS totalRuns,
      COUNT(*) AS totalEvents FROM runtime_events
      WHERE session_group IS ? AND run_id IS NOT NULL`).get(group);
    const { unattributed } = store.db.prepare(`SELECT COUNT(*) AS unattributed FROM runtime_events
      WHERE session_group IS ? AND run_id IS NULL`).get(group);
    return { runs: rows.map(run => ({ ...run, endReason: endReason(run) })), ...totals, unattributed };
  };
}
