import { eventTypesFor } from '../../../public/js/wb/timeline-rows.js';
import { listFailure, parseListQuery } from '../list-query.js';
import { isRestartExit } from './restart-effects.js';
import { levels } from './timeline-page.js';

/** Read run segments from imported events without changing their attribution. */
export function createRuns({ store, getSnapshot = async () => ({ rows: [] }) } = {}) {
  // `types` narrows what is counted (n, totalEvents, unattributed), not which runs exist or when they
  // start and end: a run whose events are all of other types is still listed, with n 0. Counts cover the events the
  // timeline shows: an automatic restart's crash report is not one.
  function readRuns(key, query, snapshot) {
    const group = key === 'origin' && snapshot.view === 'single' ? null : key;
    const currentRunId = snapshot.rows?.find(row => row.sessionGroup === group)?.live?.runId ?? null;
    const params = { key: group, limit: query.limit + 1 };
    if (query.after !== null) [params.before, params.runId] = query.after;
    const counted = eventTypesFor('all', query.filters.level);
    const typeParams = Object.fromEntries((counted ?? []).map((type, i) => [`type${i}`, type]));
    const countedType = counted ? `event_type IN (${counted.map((_, i) => `@type${i}`).join(',')}) AND ` : '';
    const counts = `SUM(CASE WHEN ${countedType}NOT ${isRestartExit()} THEN 1 ELSE 0 END)`;
    const rows = store.db.prepare(`SELECT run_id AS runId, MIN(timestamp) AS startAt,
      MAX(timestamp) AS endAt, ${counts} AS n FROM runtime_events event
      WHERE session_group IS @key AND run_id IS NOT NULL GROUP BY run_id
      ${query.after === null ? '' : 'HAVING MIN(timestamp) < @before OR (MIN(timestamp) = @before AND run_id > @runId)'}
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
      COALESCE(${counts}, 0) AS totalEvents FROM runtime_events event
      WHERE session_group IS @key AND run_id IS NOT NULL`).get({ key: group, ...typeParams });
    const { unattributed } = store.db.prepare(`SELECT COALESCE(${counts}, 0) AS unattributed FROM runtime_events event
      WHERE session_group IS @key AND run_id IS NULL`).get({ key: group, ...typeParams });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return { items: page.map(run => ({ ...run, endReason: endReason(run) })),
      nextCursor: rows.length > query.limit ? query.nextCursor([last.startAt, last.runId]) : null,
      ...totals, unattributed };
  }
  return async function runs(key, search = new URLSearchParams()) {
    const query = parseListQuery(`group-runs:${key}`, search, { filters: { level: levels } });
    try { return readRuns(key, query, await getSnapshot() ?? { rows: [] }); }
    catch { throw listFailure(503, 'unavailable', 'Group runs unavailable'); }
  };
}
