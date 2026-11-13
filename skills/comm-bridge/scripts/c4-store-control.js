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
  const endingColumns = 'session_group AS sessionGroup,run_id AS runId,reason,ended_at AS endedAt,continuation_pending AS continuationPending';
  const slotColumns = 'session_group AS sessionGroup,run_id AS runId,state,held_until AS heldUntil,created_at AS createdAt';
  function slotGroup(group) {
    requireGroup(group);
    if (group === 'origin') throw dataError('INVALID_ARGS', 'Origin does not occupy a pool slot');
  }
  function slotOptions(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw dataError('INVALID_ARGS', 'Invalid slot options');
  }
  function slotRun(runId) {
    if (typeof runId !== 'string' || !runId.trim()) throw dataError('INVALID_ARGS', 'Invalid slot run identity');
  }
  function multiSlots() {
    if (baseline().sessionMode !== 'multi') throw dataError('INVALID_ARGS', 'Pool slots require multi mode');
  }
  function insert(c, content, { sessionGroup = null, targetBinding = null, priority = 3, requireIdle = false, bypassState = false, ackDeadlineAt = null, availableAt = null, appendAckSuffix = true } = {}) {
    const current = seconds();
    const open = get(c, "SELECT 1 FROM mode_transitions WHERE phase<>'complete'");
    if (sessionGroup === null) {
      let config; try { config = baseline(); } catch (cause) { throw dataError('CONTROL_TARGET_REQUIRED', 'A control target is required when configuration cannot be read', { cause }); }
      if (open || config.sessionMode !== 'single') throw dataError('CONTROL_TARGET_REQUIRED', 'A control target is required in multi or during transition');
    } else requireGroup(sessionGroup);
    if (sessionGroup !== null && (appendAckSuffix || / ---- ack via:/.test(content)) && ackDeadlineAt === null) throw dataError('ACK_DEADLINE_REQUIRED', 'Targeted acknowledged controls require a deadline');
    const binding = normalizeTargetBinding(targetBinding);
    const superseded = run(c, "UPDATE control_queue SET status='superseded',updated_at=?,last_error=NULL WHERE status='pending' AND raw_content=? AND session_group IS ? AND target_binding IS ?", current, content, sessionGroup, binding).changes;
    const id = Number(run(c, `INSERT INTO control_queue(raw_content,content,priority,require_idle,bypass_state,ack_deadline_at,status,retry_count,available_at,last_error,created_at,updated_at,session_group,target_binding) VALUES(?,?,?,?,?,?,'pending',0,?,NULL,?,?,?,?)`, content, content, priority, requireIdle ? 1 : 0, bypassState ? 1 : 0, ackDeadlineAt, availableAt, current, current, sessionGroup, binding).lastInsertRowid);
    if (appendAckSuffix) run(c, 'UPDATE control_queue SET content=? WHERE id=?', `${content} ---- ack via: node ${fileURLToPath(new URL('./c4-control.js', import.meta.url))} ack --id ${id}`, id);
    return { ...get(c, 'SELECT * FROM control_queue WHERE id=?', id), superseded_count: superseded };
  }
  function clear(c, group, { expectedReason, expectedRunId } = {}, conditional = false) {
    requireGroup(group, { global: true });
    const row = get(c, 'SELECT * FROM drain_fences WHERE session_group=?', group);
    if (conditional && (!row || row.reason !== expectedReason || row.run_id !== expectedRunId)) throw dataError('FENCE_MISMATCH', 'Fence identity does not match');
    if (!row) return;
    if (row.reason === 'delete') throw dataError('FENCE_MISMATCH', 'Deletion fences are released only by finalization');
    if (row.reason === 'manual_restart' || expectedReason === 'manual_restart') {
      if (expectedReason !== 'manual_restart' || !expectedRunId || row.reason !== expectedReason || row.run_id !== expectedRunId) throw dataError('FENCE_MISMATCH', 'Manual restart fence identity does not match');
    } else if (group === '*') throw dataError('FENCE_INVALID', 'Transition fences are removed only on completion');
    run(c, 'DELETE FROM drain_fences WHERE session_group=?', group);
  }
  return {
    insertControl: (content, options) => write(c => insert(c, content, options)),
    recordRunEnd: (sessionGroup, options = {}) => write(c => {
      requireGroup(sessionGroup);
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['runId', 'reason', 'clearFence'].includes(key))) throw dataError('INVALID_ARGS', 'Invalid run ending options');
      const { runId, reason, clearFence = false } = options;
      if (typeof runId !== 'string' || !runId.trim() || !['ttl', 'evict', 'release', 'upgrade', 'auth', 'model_config', 'mode_switch', 'manual_restart', 'unexpected', 'delete'].includes(reason)) throw dataError('INVALID_ARGS', 'Invalid run ending identity or reason');
      if (typeof clearFence !== 'boolean' && (!clearFence || typeof clearFence !== 'object' || Array.isArray(clearFence) || Object.keys(clearFence).some(key => !['expectedReason', 'expectedRunId'].includes(key)) || typeof clearFence.expectedReason !== 'string' || typeof clearFence.expectedRunId !== 'string' || !clearFence.expectedRunId)) throw dataError('INVALID_ARGS', 'Invalid fence condition');
      if (baseline().sessionMode !== 'multi') throw dataError('INVALID_ARGS', 'Run endings require multi mode');
      const previous = get(c, 'SELECT * FROM run_endings WHERE session_group=?', sessionGroup);
      const recorded = previous?.run_id !== runId;
      if (recorded) {
        const current = seconds();
        const open = get(c, "SELECT 1 FROM mode_transitions WHERE phase<>'complete'");
        const continuationPending = !open && (['upgrade', 'auth', 'model_config', 'unexpected'].includes(reason) || (reason === 'manual_restart' && sessionGroup !== 'origin')) ? 1 : 0;
        run(c, 'INSERT INTO run_endings(session_group,run_id,reason,ended_at,continuation_pending) VALUES(?,?,?,?,?) ON CONFLICT(session_group) DO UPDATE SET run_id=excluded.run_id,reason=excluded.reason,ended_at=excluded.ended_at,continuation_pending=excluded.continuation_pending', sessionGroup, runId, reason, current, continuationPending);
        if (['ttl', 'evict', 'release'].includes(reason)) run(c, 'DELETE FROM slot_occupancy WHERE session_group=? AND run_id=?', sessionGroup, runId);
        else run(c, "UPDATE slot_occupancy SET state='held',held_until=? WHERE session_group=? AND run_id=? AND state='running'", current + 120, sessionGroup, runId);
      }
      if (clearFence && reason !== 'delete') clear(c, sessionGroup, clearFence === true ? {} : clearFence, clearFence !== true);
      return { recorded };
    }),
    takeSlot: (sessionGroup, options) => write(c => {
      slotGroup(sessionGroup); slotOptions(options, ['runId', 'k']);
      const { runId, k } = options; slotRun(runId);
      if (!Number.isSafeInteger(k) || k < 1) throw dataError('INVALID_ARGS', 'Slot capacity must be a positive integer');
      multiSlots();
      const current = seconds();
      run(c, "DELETE FROM slot_occupancy WHERE state='held' AND held_until<=?", current);
      const prior = get(c, `SELECT ${slotColumns} FROM slot_occupancy WHERE session_group=?`, sessionGroup);
      if (prior?.state === 'running') return { taken: false, reason: 'own_running' };
      if (prior) {
        run(c, "UPDATE slot_occupancy SET run_id=?,state='running',held_until=NULL,created_at=? WHERE session_group=?", runId, current, sessionGroup);
        return { taken: true, prior };
      }
      if (get(c, 'SELECT count(*) AS count FROM slot_occupancy').count >= k) return { taken: false, reason: 'full' };
      run(c, "INSERT INTO slot_occupancy(session_group,run_id,state,held_until,created_at) VALUES(?,?,'running',NULL,?)", sessionGroup, runId, current);
      return { taken: true, prior: null };
    }),
    releaseSlot: (sessionGroup, options) => write(c => {
      slotGroup(sessionGroup); slotOptions(options, ['runId', 'prior']);
      const { runId, prior } = options; slotRun(runId); multiSlots();
      if (prior !== null) {
        slotOptions(prior, ['sessionGroup', 'runId', 'state', 'heldUntil', 'createdAt']);
        slotRun(prior.runId);
        if (prior.sessionGroup !== sessionGroup || prior.state !== 'held' || !Number.isSafeInteger(prior.heldUntil) || !Number.isSafeInteger(prior.createdAt)) throw dataError('INVALID_ARGS', 'Invalid prior held slot');
        return { released: run(c, "UPDATE slot_occupancy SET run_id=?,state='held',held_until=?,created_at=? WHERE session_group=? AND run_id=? AND state='running'", prior.runId, prior.heldUntil, prior.createdAt, sessionGroup, runId).changes > 0 };
      }
      return { released: run(c, "DELETE FROM slot_occupancy WHERE session_group=? AND run_id=? AND state='running'", sessionGroup, runId).changes > 0 };
    }),
    adoptSlot: (sessionGroup, options) => write(c => {
      slotGroup(sessionGroup); slotOptions(options, ['runId']);
      const { runId } = options; slotRun(runId); multiSlots();
      if (get(c, "SELECT 1 FROM drain_fences WHERE session_group=? AND reason='delete'", sessionGroup)) return { adopted: false, reason: 'fenced' };
      // A completed deletion removes run_endings. Its audit still identifies
      // the ended run, including when an older Router observation arrives late.
      if (get(c, "SELECT 1 FROM group_deletion_audit WHERE session_group=? AND run_id=? AND status='done'", sessionGroup, runId)) return { adopted: false, reason: 'ended' };
      if (get(c, 'SELECT run_id FROM run_endings WHERE session_group=?', sessionGroup)?.run_id === runId) return { adopted: false, reason: 'ended' };
      const prior = get(c, 'SELECT run_id,state FROM slot_occupancy WHERE session_group=?', sessionGroup);
      if (prior?.run_id === runId && prior.state === 'running') return { adopted: false, reason: 'already' };
      run(c, "INSERT INTO slot_occupancy(session_group,run_id,state,held_until,created_at) VALUES(?,?,'running',NULL,?) ON CONFLICT(session_group) DO UPDATE SET run_id=excluded.run_id,state='running',held_until=NULL,created_at=excluded.created_at", sessionGroup, runId, seconds());
      return { adopted: true };
    }),
    listSlotOccupancy: () => read(c => all(c, `SELECT ${slotColumns} FROM slot_occupancy WHERE state='running' OR held_until>? ORDER BY session_group COLLATE BINARY`, seconds())),
    pruneSlots: options => write(c => {
      slotOptions(options, ['orphans', 'minAgeSeconds']);
      const { orphans, minAgeSeconds } = options;
      if (!Array.isArray(orphans) || !Number.isSafeInteger(minAgeSeconds) || minAgeSeconds < 0) throw dataError('INVALID_ARGS', 'Invalid slot pruning options');
      for (const row of orphans) { slotOptions(row, ['sessionGroup', 'runId']); slotGroup(row.sessionGroup); slotRun(row.runId); }
      multiSlots();
      const current = seconds();
      const deletedHeld = run(c, "DELETE FROM slot_occupancy WHERE state='held' AND held_until<=?", current).changes;
      const deletedOrphans = [];
      for (const { sessionGroup, runId } of orphans) {
        if (run(c, "DELETE FROM slot_occupancy WHERE session_group=? AND run_id=? AND state='running' AND created_at<=?", sessionGroup, runId, current - minAgeSeconds).changes) deletedOrphans.push({ sessionGroup, runId });
      }
      return { deletedHeld, deletedOrphans };
    }),
    listRunEndings: sessionGroups => {
      if (!Array.isArray(sessionGroups) || sessionGroups.length === 0) throw dataError('INVALID_ARGS', 'sessionGroups must be a nonempty array');
      for (const group of sessionGroups) requireGroup(group);
      return read(c => all(c, `SELECT ${endingColumns} FROM run_endings WHERE session_group IN (${sessionGroups.map(() => '?').join(',')}) ORDER BY session_group COLLATE BINARY`, ...sessionGroups));
    },
    listPendingContinuations: () => read(c => all(c, "SELECT session_group AS sessionGroup,ended_at AS endedAt FROM run_endings WHERE continuation_pending=1 AND session_group<>'origin' ORDER BY ended_at,session_group COLLATE BINARY")),
    clearContinuation: (sessionGroup, options) => write(c => {
      requireGroup(sessionGroup); slotOptions(options, ['runId']);
      const { runId } = options; slotRun(runId);
      if (baseline().sessionMode !== 'multi') throw dataError('INVALID_ARGS', 'Continuations require multi mode');
      return { cleared: run(c, 'UPDATE run_endings SET continuation_pending=0 WHERE session_group=? AND continuation_pending=1 AND run_id<>?', sessionGroup, runId).changes > 0 };
    }),
    clearAllContinuations: () => write(c => ({ cleared: run(c, 'UPDATE run_endings SET continuation_pending=0 WHERE continuation_pending=1').changes })),
    getNextPendingControl: (current = seconds(), { sessionGroups } = {}) => {
      let sql = 'session_group IS NULL', args = [];
      if (sessionGroups !== undefined) {
        if (!Array.isArray(sessionGroups)) throw dataError('INVALID_ARGS', 'sessionGroups must be an array');
        sessionGroups.forEach(g => requireGroup(g)); args = sessionGroups;
        sql = args.length ? `session_group IN (${args.map(() => '?').join(',')})` : '0';
      }
      return read(c => get(c, `SELECT * FROM control_queue WHERE status='pending' AND (available_at IS NULL OR available_at<=?) AND ${sql} AND ${unfenced} ORDER BY priority,created_at,id LIMIT 1`, current, ...args) ?? null);
    },
    getOriginNeed: (current = seconds()) => read(c => {
      const ending = get(c, "SELECT ended_at AS endedAt FROM run_endings WHERE session_group='origin' AND continuation_pending=1");
      return {
        inbound: get(c, `SELECT COUNT(*) AS count, MIN(unixepoch(timestamp)) AS oldestAt
          FROM conversations WHERE direction='in' AND status='pending' AND session_group='origin'`),
        controls: get(c, `SELECT COUNT(*) AS count, MIN(MAX(created_at, COALESCE(available_at, created_at))) AS oldestAt
          FROM control_queue WHERE status='pending' AND session_group='origin' AND target_binding IS NULL
            AND (available_at IS NULL OR available_at<=?)`, current),
        continuation: { pending: Boolean(ending), oldestAt: ending?.endedAt ?? null },
      };
    }),
    claimControl: id => write(c => run(c, `UPDATE control_queue SET status='running',updated_at=? WHERE id=? AND status='pending' AND ${unfenced}`, seconds(), id).changes > 0),
    expirePendingControls: value => {
      const t = target(value);
      return write(c => all(c, `UPDATE control_queue SET status='timeout',last_error='SESSION_ENDED',updated_at=? WHERE status='pending' AND ${t.sql} RETURNING id,session_group,raw_content`, seconds(), ...t.args));
    },
    expireStaleRunningControls: (value, { deliveredBefore }) => {
      if (!Number.isSafeInteger(deliveredBefore)) throw dataError('INVALID_ARGS', 'deliveredBefore must be integer Unix seconds');
      const t = target(value); return write(c => all(c, `UPDATE control_queue SET status='timeout',last_error='SESSION_ENDED',updated_at=? WHERE status='running' AND updated_at<? AND ${t.sql} RETURNING id,session_group,raw_content`, seconds(), deliveredBefore, ...t.args));
    },
    countNonTerminalControls: value => { const t = target(value); return read(c => get(c, `SELECT COALESCE(SUM(status='pending'),0) AS pending,COALESCE(SUM(status='running'),0) AS running,COALESCE(SUM(status='running' AND ack_deadline_at IS NULL),0) AS runningWithoutDeadline FROM control_queue WHERE status IN ('pending','running') AND ${t.sql}`, ...t.args)); },
    listRunningControlsWithoutDeadline: value => {
      const t = target(value);
      return read(c => all(c, `SELECT id FROM control_queue WHERE status='running' AND ack_deadline_at IS NULL AND ${t.sql} ORDER BY id`, ...t.args).map(row => row.id));
    },
    expireControlById: id => write(c => {
      const row = get(c, "UPDATE control_queue SET status='timeout',last_error='MANUAL_EXPIRED',updated_at=? WHERE id=? AND status IN ('pending','running') RETURNING *", seconds(), id);
      if (!row) throw dataError('CONTROL_NOT_ACTIVE', 'Control is absent or terminal');
      return row;
    }),
    failStaleTargetControl: id => write(c => get(c, "UPDATE control_queue SET status='timeout',last_error='STALE_TARGET',updated_at=? WHERE id=? AND status='running' AND target_binding IS NOT NULL RETURNING *", seconds(), id) ?? null),
    setDrainFence: (group, { reason = null, runId = null } = {}) => write(c => {
      const hasRun = typeof runId === 'string' && runId.length > 0;
      const normal = ['ttl','evict','release','upgrade','auth','mode_switch','model_config'];
      const valid = group === '*' ? (reason === null && runId === null) || (reason === 'manual_restart' && hasRun) : !!parseSessionGroup(group) && hasRun && (group === 'origin' ? [...normal.filter(x => x !== 'evict'), 'manual_restart'] : [...normal, 'manual_restart']).includes(reason);
      if (!valid) throw dataError('FENCE_INVALID', 'Invalid fence scope, reason or run');
      run(c, 'INSERT INTO drain_fences(session_group,reason,run_id,created_at) VALUES(?,?,?,?) ON CONFLICT(session_group) DO NOTHING', group, reason, runId, seconds());
    }),
    getDrainFence: group => { requireGroup(group, { global: true }); return read(c => get(c, `SELECT ${fenceColumns} FROM drain_fences WHERE session_group=?`, group) ?? null); },
    listDrainFences: () => read(c => all(c, `SELECT ${fenceColumns} FROM drain_fences ORDER BY session_group COLLATE BINARY`)),
    clearDrainFence: (group, options) => write(c => clear(c, group, options)),
  };
}
