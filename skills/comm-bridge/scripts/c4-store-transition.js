import { randomUUID } from 'node:crypto';
import { dataError } from './c4-session-group.js';
export function transitionFunctions({ read, write, snapshot, get, all, run, seconds, coverage, checkpoint }) {
  const decode = row => row ? { ...row, coverage_snapshot: row.coverage_snapshot === null ? null : JSON.parse(row.coverage_snapshot), absorbed_ids: row.absorbed_ids === null ? null : JSON.parse(row.absorbed_ids) } : null;
  const find = (c, runId) => decode(runId === undefined ? get(c, "SELECT * FROM mode_transitions WHERE phase<>'complete'") : get(c, 'SELECT * FROM mode_transitions WHERE run_id=?', runId));
  function required(c, id) { const row = find(c, id); if (!row) throw dataError('RUN_NOT_FOUND', 'Mode transition does not exist'); return row; }
  function onlyGlobal(c, completion = false) {
    const rows = all(c, 'SELECT * FROM drain_fences');
    if (rows.length !== 1 || rows[0].session_group !== '*' || (completion && (rows[0].reason !== null || rows[0].run_id !== null))) throw dataError('TRANSITION_PRECONDITION', 'Only the transition global fence may remain');
  }
  function absorbed(c, row) {
    if (row.phase === 'gating') return [];
    const rows = (row.absorbed_ids ?? []).map(id => get(c, 'SELECT * FROM conversations WHERE id=?', id));
    const bad = (row.absorbed_ids ?? []).filter((id, i) => !rows[i] || rows[i].status !== 'switch_absorbed');
    if (bad.length) throw dataError('ABSORBED_MISMATCH', 'Absorbed messages are missing or have changed state', { ids: bad.slice(0, 20), count: bad.length });
    return rows.sort((a,b) => a.id-b.id);
  }
  const api = {
    beginModeTransition: (source, target) => write(c => {
      if (!['single','multi'].includes(source) || !['single','multi'].includes(target)) throw dataError('INVALID_ARGS', 'Invalid transition mode');
      if (source === target) throw dataError('TRANSITION_SAME_MODE', 'Source and target are equal');
      if (find(c)) throw dataError('TRANSITION_OPEN', 'A transition is already open');
      if (get(c, "SELECT 1 FROM drain_fences WHERE reason='manual_restart'")) throw dataError('MANUAL_RESTART_FENCE', 'Manual restart must finish first');
      const runId = randomUUID();
      run(c, "INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,created_at,updated_at) VALUES(?,?,?,'gating',?,?)", runId, source, target, seconds(), seconds());
      return { runId };
    }),
    getModeTransition: ({ runId } = {}) => read(c => find(c, runId)),
    getLastCompletedModeTransition: () => read(c => decode(get(c, "SELECT * FROM mode_transitions WHERE phase='complete' ORDER BY updated_at DESC,created_at DESC,rowid DESC LIMIT 1"))),
    listGroupHeads: () => read(c => all(c, 'SELECT session_group AS sessionGroup,head_id AS headId FROM group_heads ORDER BY session_group COLLATE BINARY')),
    absorbForTransition: runId => write(c => {
      const row = required(c, runId);
      if (row.phase !== 'gating' && row.cutoff !== null) return { cutoff: row.cutoff, coverageSnapshot: row.coverage_snapshot, absorbedIds: row.absorbed_ids };
      if (row.phase !== 'gating') throw dataError('PHASE_TRANSITION_INVALID', 'Transition is not gating');
      onlyGlobal(c);
      if (get(c, "SELECT 1 FROM conversations WHERE direction='in' AND status='running' LIMIT 1")) throw dataError('TRANSITION_PRECONDITION', 'Running input has not drained');
      const cutoff = get(c, 'SELECT COALESCE(MAX(id),0) AS n FROM conversations').n;
      const coverageSnapshot = {};
      if (row.source_mode === 'single') coverageSnapshot['*'] = coverage(c, '*');
      else for (const head of all(c, 'SELECT * FROM group_heads ORDER BY session_group COLLATE BINARY')) { const end = coverage(c, head.session_group); if (head.head_id > end) coverageSnapshot[head.session_group] = end; }
      const absorbedIds = all(c, "UPDATE conversations SET status='switch_absorbed' WHERE direction='in' AND status='pending' AND id<=? RETURNING id", cutoff).map(r => r.id).sort((a,b) => a-b);
      run(c, "UPDATE mode_transitions SET cutoff=?,coverage_snapshot=?,absorbed_ids=?,phase='converting',updated_at=? WHERE run_id=?", cutoff, JSON.stringify(coverageSnapshot), JSON.stringify(absorbedIds), seconds(), runId);
      return { cutoff, coverageSnapshot, absorbedIds };
    }),
    setModeTransitionPhase: (runId, phase, { reason = null } = {}) => write(c => {
      const row = required(c, runId);
      if (row.phase !== phase && !((row.phase === 'converting' && phase === 'cutover') || (row.phase === 'cutover' && phase === 'complete'))) throw dataError('PHASE_TRANSITION_INVALID', 'Invalid transition phase change');
      if (row.phase !== phase && phase === 'cutover' && row.source_mode === 'multi') checkpoint(c, '*', row.cutoff, '', { cutover: true });
      if (row.phase !== phase && phase === 'complete') { onlyGlobal(c, true); run(c, "DELETE FROM drain_fences WHERE session_group='*'"); }
      run(c, 'UPDATE mode_transitions SET phase=?,reason=?,updated_at=? WHERE run_id=?', phase, reason, seconds(), runId);
      return find(c, runId);
    }),
    getAbsorbedConversations: runId => snapshot(c => absorbed(c, required(c, runId)).map(({ id, session_group, channel, endpoint_id, timestamp, content }) => ({ id, session_group, channel, endpoint_id, timestamp, content }))),
  };
  return { api, readAbsorbed: runId => snapshot(c => { const transition = required(c, runId); return { transition, rows: absorbed(c, transition) }; }) };
}
