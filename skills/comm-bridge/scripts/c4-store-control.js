import { dataError, requireGroup, parseSessionGroup } from './c4-session-group.js';
import { normalizeTargetBinding } from './c4-target-binding.js';
import { fileURLToPath } from 'node:url';
export function controlFunctions({ read, write, get, all, run, seconds, baseline }) {
  const fenceColumns = 'session_group AS sessionGroup,reason,run_id AS runId,created_at AS createdAt';
  const unfenced = "NOT EXISTS(SELECT 1 FROM drain_fences WHERE session_group=control_queue.session_group OR session_group='*')";
  function target(value) {
    if (!value || Object.keys(value).length !== 1) throw dataError('INVALID_ARGS', 'Choose exactly one control target');
    if (value.machine === true) return { sql: 'session_group IS NULL', args: [] };
    if (value.allSessionGroups === true) return { sql: 'session_group IS NOT NULL', args: [] };
    requireGroup(value.sessionGroup); return { sql: 'session_group=?', args: [value.sessionGroup] };
  }
  return {
    insertControl: (content, { sessionGroup = null, targetBinding = null, priority = 3, requireIdle = false, bypassState = false, ackDeadlineAt = null, availableAt = null, appendAckSuffix = true } = {}) => write(c => {
      const open = get(c, "SELECT 1 FROM mode_transitions WHERE phase<>'complete'");
      if (sessionGroup === null) {
        let config; try { config = baseline(); } catch (cause) { throw dataError('CONTROL_TARGET_REQUIRED', 'A control target is required when configuration cannot be read', { cause }); }
        if (open || config.sessionMode !== 'single') throw dataError('CONTROL_TARGET_REQUIRED', 'A control target is required in multi or during transition');
      } else requireGroup(sessionGroup);
      if (sessionGroup !== null && (appendAckSuffix || / ---- ack via:/.test(content)) && ackDeadlineAt === null) throw dataError('ACK_DEADLINE_REQUIRED', 'Targeted acknowledged controls require a deadline');
      const binding = normalizeTargetBinding(targetBinding), current = seconds();
      const superseded = run(c, "UPDATE control_queue SET status='superseded',updated_at=?,last_error=NULL WHERE status='pending' AND raw_content=? AND session_group IS ? AND target_binding IS ?", current, content, sessionGroup, binding).changes;
      const id = Number(run(c, `INSERT INTO control_queue(raw_content,content,priority,require_idle,bypass_state,ack_deadline_at,status,retry_count,available_at,last_error,created_at,updated_at,session_group,target_binding) VALUES(?,?,?,?,?,?,'pending',0,?,NULL,?,?,?,?)`, content, content, priority, requireIdle ? 1 : 0, bypassState ? 1 : 0, ackDeadlineAt, availableAt, current, current, sessionGroup, binding).lastInsertRowid);
      if (appendAckSuffix) run(c, 'UPDATE control_queue SET content=? WHERE id=?', `${content} ---- ack via: node ${fileURLToPath(new URL('./c4-control.js', import.meta.url))} ack --id ${id}`, id);
      return { ...get(c, 'SELECT * FROM control_queue WHERE id=?', id), superseded_count: superseded };
    }),
    getNextPendingControl: (current = seconds(), { sessionGroups } = {}) => {
      let sql = 'session_group IS NULL', args = [];
      if (sessionGroups !== undefined) {
        if (!Array.isArray(sessionGroups)) throw dataError('INVALID_ARGS', 'sessionGroups must be an array');
        sessionGroups.forEach(g => requireGroup(g)); args = sessionGroups;
        sql = args.length ? `session_group IN (${args.map(() => '?').join(',')})` : '0';
      }
      return read(c => get(c, `SELECT * FROM control_queue WHERE status='pending' AND (available_at IS NULL OR available_at<=?) AND ${sql} AND ${unfenced} ORDER BY priority,created_at,id LIMIT 1`, current, ...args) ?? null);
    },
    claimControl: id => write(c => run(c, `UPDATE control_queue SET status='running',updated_at=? WHERE id=? AND status='pending' AND ${unfenced}`, seconds(), id).changes > 0),
    expirePendingControls: value => { const t = target(value); return write(c => all(c, `UPDATE control_queue SET status='timeout',last_error='SESSION_ENDED',updated_at=? WHERE status='pending' AND ${t.sql} RETURNING id,session_group,raw_content`, seconds(), ...t.args)); },
    expireStaleRunningControls: (value, { deliveredBefore }) => {
      if (!Number.isSafeInteger(deliveredBefore)) throw dataError('INVALID_ARGS', 'deliveredBefore must be integer Unix seconds');
      const t = target(value); return write(c => all(c, `UPDATE control_queue SET status='timeout',last_error='SESSION_ENDED',updated_at=? WHERE status='running' AND updated_at<? AND ${t.sql} RETURNING id,session_group,raw_content`, seconds(), deliveredBefore, ...t.args));
    },
    countNonTerminalControls: value => { const t = target(value); return read(c => get(c, `SELECT COALESCE(SUM(status='pending'),0) AS pending,COALESCE(SUM(status='running'),0) AS running,COALESCE(SUM(status='running' AND ack_deadline_at IS NULL),0) AS runningWithoutDeadline FROM control_queue WHERE status IN ('pending','running') AND ${t.sql}`, ...t.args)); },
    expireControlById: id => write(c => {
      const row = get(c, "UPDATE control_queue SET status='timeout',last_error='MANUAL_EXPIRED',updated_at=? WHERE id=? AND status IN ('pending','running') RETURNING *", seconds(), id);
      if (!row) throw dataError('CONTROL_NOT_ACTIVE', 'Control is absent or terminal');
      return row;
    }),
    setDrainFence: (group, { reason = null, runId = null } = {}) => write(c => {
      const hasRun = typeof runId === 'string' && runId.length > 0;
      const normal = ['ttl','evict','upgrade','auth','mode_switch','model_config'];
      const valid = group === '*' ? (reason === null && runId === null) || (reason === 'manual_restart' && hasRun) : !!parseSessionGroup(group) && hasRun && (group === 'origin' ? [...normal.filter(x => !['ttl','evict'].includes(x)), 'manual_restart'].includes(reason) : normal.includes(reason));
      if (!valid) throw dataError('FENCE_INVALID', 'Invalid fence scope, reason or run');
      run(c, 'INSERT INTO drain_fences(session_group,reason,run_id,created_at) VALUES(?,?,?,?) ON CONFLICT(session_group) DO NOTHING', group, reason, runId, seconds());
    }),
    getDrainFence: group => { requireGroup(group, { global: true }); return read(c => get(c, `SELECT ${fenceColumns} FROM drain_fences WHERE session_group=?`, group) ?? null); },
    listDrainFences: () => read(c => all(c, `SELECT ${fenceColumns} FROM drain_fences ORDER BY session_group COLLATE BINARY`)),
    clearDrainFence: (group, { expectedReason, expectedRunId } = {}) => write(c => {
      requireGroup(group, { global: true });
      const row = get(c, 'SELECT * FROM drain_fences WHERE session_group=?', group); if (!row) return;
      if (row.reason === 'manual_restart' || expectedReason === 'manual_restart') {
        if (expectedReason !== 'manual_restart' || !expectedRunId || row.reason !== expectedReason || row.run_id !== expectedRunId) throw dataError('FENCE_MISMATCH', 'Manual restart fence identity does not match');
      } else if (group === '*') throw dataError('FENCE_INVALID', 'Transition fences are removed only on completion');
      run(c, 'DELETE FROM drain_fences WHERE session_group=?', group);
    }),
  };
}
