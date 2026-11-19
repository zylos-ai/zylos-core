import { OPEN_MODE_TRANSITION } from './c4-transition-state.js';
import { randomUUID } from 'node:crypto';
import { dataError } from './c4-session-group.js';
export function transitionFunctions({ read, write, snapshot, get, all, run, seconds, advanceHead }) {
  const decode = row => row ? { ...row, coverage_snapshot: row.coverage_snapshot === null ? null : JSON.parse(row.coverage_snapshot), absorbed_ids: row.absorbed_ids === null ? null : JSON.parse(row.absorbed_ids) } : null;
  const find = (c, runId) => decode(runId === undefined ? get(c, `SELECT * FROM mode_transitions WHERE ${OPEN_MODE_TRANSITION}`) : get(c, 'SELECT * FROM mode_transitions WHERE run_id=?', runId));
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
      if (get(c, "SELECT 1 FROM drain_fences WHERE reason='delete'")) throw dataError('DELETION_IN_PROGRESS', 'Group deletion must finish first');
      if (get(c, "SELECT 1 FROM drain_fences WHERE reason='manual_restart'")) throw dataError('MANUAL_RESTART_FENCE', 'Manual restart must finish first');
      const runId = randomUUID();
      run(c, "INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,created_at,updated_at) VALUES(?,?,?,'gating',?,?)", runId, source, target, seconds(), seconds());
      return { runId };
    }),
    getModeTransition: ({ runId } = {}) => read(c => find(c, runId)),
    expireLegacyRunningControls: runId => write(c => {
      const row = required(c, runId);
      if (row.phase !== 'gating' || row.source_mode !== 'single' || row.target_mode !== 'multi') throw dataError('TRANSITION_PRECONDITION', 'Legacy control cleanup requires single-to-multi gating');
      onlyGlobal(c, true);
      // The caller proves executor absence under the lifecycle queue. Recheck
      // durable ownership and row eligibility inside this write transaction.
      const predicate = "status='running' AND session_group IS NULL AND ack_deadline_at IS NULL AND created_at<? AND updated_at<?";
      const ids = all(c, `SELECT id FROM control_queue WHERE ${predicate} ORDER BY id LIMIT 20`, row.created_at, row.created_at).map(value => value.id);
      const { changes: count } = run(c, `UPDATE control_queue SET status='timeout',last_error='SESSION_ENDED',updated_at=? WHERE ${predicate}`, seconds(), row.created_at, row.created_at);
      return { count, ids };
    }),
    getLastCompletedModeTransition: (options = {}) => {
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['memoryConversion', 'targetMode'].includes(key)) || (Object.hasOwn(options, 'memoryConversion') && typeof options.memoryConversion !== 'boolean') || (Object.hasOwn(options, 'targetMode') && !['single', 'multi'].includes(options.targetMode))) throw dataError('INVALID_ARGS', 'Invalid completed transition options');
      const predicates = ["phase='complete'"];
      if (options.memoryConversion) predicates.push('cutoff IS NOT NULL');
      if (options.targetMode) predicates.push('target_mode=?');
      return read(c => decode(get(c, `SELECT * FROM mode_transitions WHERE ${predicates.join(' AND ')} ORDER BY updated_at DESC,created_at DESC,rowid DESC LIMIT 1`, ...(options.targetMode ? [options.targetMode] : []))));
    },
    listGroupHeads: () => read(c => all(c, 'SELECT session_group AS sessionGroup,head_id AS headId FROM group_heads ORDER BY session_group COLLATE BINARY')),
    voidInternalForSingle: runId => write(c => {
      const row = typeof runId === 'string' && runId ? find(c, runId) : null;
      if (!row || row.phase !== 'cutover' || row.target_mode !== 'single') throw dataError('TRANSITION_PRECONDITION', 'Internal cleanup requires native single cutover');
      return all(c, "UPDATE conversations SET status='failed',delivery_action='switch_voided' WHERE channel='internal' AND direction='in' AND status='pending' AND session_group<>'origin' RETURNING id");
    }),
    claimUngroupedPendingForOrigin: () => write(c => {
      const pending = "direction='in' AND status='pending' AND session_group=''";
      const { headId } = get(c, `SELECT MAX(id) AS headId FROM conversations WHERE ${pending}`);
      if (headId === null) return;
      run(c, `UPDATE conversations SET session_group='origin' WHERE ${pending}`);
      advanceHead(c, 'origin', headId);
    }),
    setModeTransitionPhase: (runId, phase, { reason = null } = {}) => write(c => {
      const row = required(c, runId);
      if (row.phase !== phase) {
        const next = { gating: 'cutover', converting: 'cutover', cutover: 'complete' };
        if (next[row.phase] !== phase) throw dataError('PHASE_TRANSITION_INVALID', 'Invalid transition phase change');
        onlyGlobal(c, true);
        if (row.phase === 'converting') {
          run(c, `UPDATE conversations SET status='pending'
            WHERE status='switch_absorbed' AND id IN (SELECT value FROM json_each(?))`,
            JSON.stringify(row.absorbed_ids ?? []));
        } else if (phase === 'complete') {
          run(c, "DELETE FROM drain_fences WHERE session_group='*'");
        }
      }
      run(c, 'UPDATE mode_transitions SET phase=?,reason=?,updated_at=? WHERE run_id=?', phase, reason, seconds(), runId);
      return find(c, runId);
    }),
    getAbsorbedConversations: runId => snapshot(c => absorbed(c, required(c, runId)).map(({ id, session_group, channel, endpoint_id, timestamp, content }) => ({ id, session_group, channel, endpoint_id, timestamp, content }))),
  };
  return { api, readAbsorbed: runId => snapshot(c => { const transition = required(c, runId); return { transition, rows: absorbed(c, transition) }; }) };
}
