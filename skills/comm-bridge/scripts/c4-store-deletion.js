import { dataError, requireGroup } from './c4-session-group.js';

const terminalMessage = "(direction='out' OR direction='in' AND status NOT IN ('pending','running'))";
const terminalControl = "status IN ('done','timeout','superseded','failed','cancelled')";
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
function amounts(value = {}) {
  const result = { messages: value.messages ?? 0, attachments: value.attachments ?? 0, files: value.files ?? 0 };
  if (!Object.values(result).every(count)) throw dataError('INVALID_ARGS', 'Deletion counts must be nonnegative integers');
  return result;
}
function decode(row) {
  if (!row) return null;
  return { operationId: row.operation_id, sessionGroup: row.session_group, draftLocalId: row.draft_local_id, actor: row.actor, runId: row.run_id,
    startedAt: row.started_at, completedAt: row.completed_at, status: row.status, countsEstimated: Boolean(row.counts_estimated),
    preview: { messages: row.preview_messages, attachments: row.preview_attachments, files: row.preview_files },
    counts: { messages: row.deleted_messages, attachments: row.deleted_attachments, files: row.deleted_files } };
}

export function deletionFunctions({ read, write, get, all, run, seconds }) {
  function group(value) {
    requireGroup(value);
    if (value === 'origin') throw dataError('ORIGIN_DELETE_FORBIDDEN', 'Origin cannot be deleted');
  }
  const audit = (c, operationId) => get(c, 'SELECT * FROM group_deletion_audit WHERE operation_id=?', operationId);
  function owned(c, sessionGroup, operationId) {
    group(sessionGroup);
    const row = audit(c, operationId), fence = get(c, 'SELECT * FROM drain_fences WHERE session_group=?', sessionGroup);
    if (!row || row.session_group !== sessionGroup || row.status !== 'started' || fence?.reason !== 'delete' || fence.operation_id !== operationId) throw dataError('DELETION_OWNERSHIP_MISMATCH', 'Deletion ownership does not match');
    return { row, fence };
  }
  function drained(c, sessionGroup) {
    if (get(c, "SELECT 1 FROM conversations WHERE session_group=? AND direction='in' AND status='running' LIMIT 1", sessionGroup) ||
        get(c, "SELECT 1 FROM control_queue WHERE session_group=? AND status='running' LIMIT 1", sessionGroup)) throw dataError('DELETION_INFLIGHT', 'The group still has in-flight work');
  }
  function cleanupNow(cleanup, c) {
    if (cleanup === undefined) return {};
    if (typeof cleanup !== 'function') throw dataError('INVALID_ARGS', 'Cleanup must be synchronous');
    const result = cleanup(c);
    if (result && typeof result.then === 'function') throw dataError('INVALID_ARGS', 'Cleanup must be synchronous');
    return result ?? {};
  }
  function draft(c, localId) {
    if (typeof localId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(localId)) throw dataError('INVALID_ARGS', 'Invalid draft identity');
    const namespace = get(c, "SELECT namespace FROM channel_namespaces WHERE component_name='dashboard'")?.namespace;
    if (!namespace) return;
    const name = `${namespace}:${localId}`;
    if (get(c, 'SELECT 1 FROM conversations WHERE session_group=? LIMIT 1', name) || get(c, 'SELECT 1 FROM group_heads WHERE session_group=?', name)) throw dataError('DRAFT_BECAME_ACTIVE', 'The draft received a message');
  }
  return {
    getGroupDeletionAudit: operationId => read(c => decode(audit(c, operationId))),
    markDeletionCleanup: operationId => write(c => {
      const row = audit(c, operationId);
      if (!row || row.status !== 'started') throw dataError('DELETION_OWNERSHIP_MISMATCH', 'Deletion operation is not active');
      if (row.session_group !== null) owned(c, row.session_group, operationId);
      else draft(c, row.draft_local_id);
      run(c, 'UPDATE group_deletion_audit SET cleanup_attempts=cleanup_attempts+1 WHERE operation_id=?', operationId);
    }),
    retractDeletionCleanup: operationId => write(c => {
      const row = audit(c, operationId);
      if (!row || row.status !== 'started' || row.cleanup_attempts === 0) return;
      run(c, 'UPDATE group_deletion_audit SET cleanup_attempts=cleanup_attempts-1 WHERE operation_id=?', operationId);
    }),
    beginDraftDeletion: (localId, { operationId, actor, preview } = {}) => write(c => {
      if (!text(operationId) || !text(actor)) throw dataError('INVALID_ARGS', 'Deletion identity and actor are required');
      const before = audit(c, operationId);
      if (before && (before.session_group !== null || before.draft_local_id !== localId)) throw dataError('DELETION_OWNERSHIP_MISMATCH', 'Operation belongs to another target');
      if (before?.status === 'done') return decode(before);
      draft(c, localId);
      if (get(c, "SELECT 1 FROM mode_transitions WHERE phase<>'complete'")) throw dataError('TRANSITION_OPEN', 'Mode transition is in progress');
      const active = get(c, "SELECT * FROM group_deletion_audit WHERE draft_local_id=? AND session_group IS NULL AND status='started'", localId);
      if (active) return decode(active);
      const n = amounts(preview);
      run(c, "INSERT INTO group_deletion_audit(operation_id,session_group,draft_local_id,actor,started_at,status,preview_messages,preview_attachments,preview_files) VALUES(?,NULL,?,?,?,'started',?,?,?)", operationId, localId, actor, seconds(), n.messages, n.attachments, n.files);
      return decode(audit(c, operationId));
    }),
    finalizeDraftDeletion: (localId, { operationId, counts, cleanup } = {}) => write(c => {
      const row = audit(c, operationId);
      if (!row || row.session_group !== null || row.draft_local_id !== localId) throw dataError('DELETION_OWNERSHIP_MISMATCH', 'Draft operation does not match');
      if (row.status === 'done') return decode(row);
      // Another caller may have cleaned files after this caller marked its
      // attempt. Recheck durable count confidence under the final writer lock.
      const countsEstimated = row.cleanup_attempts > 1;
      draft(c, localId);
      if (get(c, "SELECT 1 FROM mode_transitions WHERE phase<>'complete'")) throw dataError('TRANSITION_OPEN', 'Mode transition is in progress');
      const removed = cleanupNow(cleanup, c), n = amounts({ ...counts, ...removed });
      run(c, "UPDATE group_deletion_audit SET status='done',completed_at=?,deleted_messages=0,deleted_attachments=?,deleted_files=?,counts_estimated=? WHERE operation_id=?", seconds(), n.attachments, n.files, Number(countsEstimated), operationId);
      return decode(audit(c, operationId));
    }),

    getActiveDeletion: sessionGroup => { group(sessionGroup); return read(c => decode(get(c, "SELECT a.* FROM drain_fences f JOIN group_deletion_audit a ON a.operation_id=f.operation_id WHERE f.session_group=? AND f.reason='delete' AND a.status='started'", sessionGroup))); },
    beginGroupDeletion: (sessionGroup, { operationId, actor, runId = null, preview } = {}) => write(c => {
      group(sessionGroup);
      if (!text(operationId) || !text(actor) || runId !== null && !text(runId)) throw dataError('INVALID_ARGS', 'Deletion identity and actor are required');
      const before = audit(c, operationId);
      if (before && before.session_group !== sessionGroup) throw dataError('DELETION_OWNERSHIP_MISMATCH', 'Operation belongs to another group');
      if (before?.status === 'done') return decode(before);
      if (get(c, "SELECT 1 FROM mode_transitions WHERE phase<>'complete'") || get(c, "SELECT 1 FROM drain_fences WHERE session_group='*'")) throw dataError('TRANSITION_OPEN', 'Mode transition or global drain is in progress');
      const fence = get(c, 'SELECT * FROM drain_fences WHERE session_group=?', sessionGroup);
      if (fence) {
        if (fence.reason !== 'delete' || !fence.operation_id) throw dataError('FENCE_MISMATCH', 'The group is owned by another operation');
        return decode(owned(c, sessionGroup, fence.operation_id).row);
      }
      if (before) throw dataError('DELETION_OWNERSHIP_MISMATCH', 'Deletion audit exists without its fence');
      const n = amounts(preview), started = seconds();
      run(c, "INSERT INTO group_deletion_audit(operation_id,session_group,actor,run_id,started_at,status,preview_messages,preview_attachments,preview_files) VALUES(?,?,?,?,?,'started',?,?,?)", operationId, sessionGroup, actor, runId, started, n.messages, n.attachments, n.files);
      run(c, "INSERT INTO drain_fences(session_group,reason,run_id,created_at,operation_id,actor) VALUES(?,'delete',?,?,?,?)", sessionGroup, runId ?? operationId, started, operationId, actor);
      return decode(audit(c, operationId));
    }),
    listDeletionMessages: (sessionGroup, { operationId } = {}) => read(c => {
      owned(c, sessionGroup, operationId);
      return all(c, `SELECT id,direction,status,channel,endpoint_id,session_id FROM conversations WHERE session_group=? AND ${terminalMessage} ORDER BY id`, sessionGroup);
    }),
    finalizeGroupDeletion: (sessionGroup, { operationId, counts, cleanup } = {}) => write(c => {
      group(sessionGroup);
      const previous = audit(c, operationId);
      if (previous?.session_group === sessionGroup && previous.status === 'done') return decode(previous);
      const { row, fence } = owned(c, sessionGroup, operationId);
      const countsEstimated = row.cleanup_attempts > 1;
      if (get(c, "SELECT 1 FROM mode_transitions WHERE phase<>'complete'")) throw dataError('TRANSITION_OPEN', 'Mode transition is in progress');
      drained(c, sessionGroup);
      const removed = cleanupNow(cleanup, c), n = amounts({ ...counts, ...removed });
      const deleted = run(c, `DELETE FROM conversations WHERE session_group=? AND ${terminalMessage}`, sessionGroup).changes;
      for (const table of ['checkpoints','origin_sync_cursors','group_runtime_overrides','group_model_overrides','run_endings','slot_occupancy']) run(c, `DELETE FROM ${table} WHERE session_group=?`, sessionGroup);
      // Bound controls are for the stopped executor; unbound pending controls
      // remain eligible for the newly created group.
      run(c, "UPDATE control_queue SET status='superseded',updated_at=? WHERE session_group=? AND status='pending' AND target_binding IS NOT NULL AND json_extract(target_binding,'$.expectedRunId')=?", seconds(), sessionGroup, fence.run_id);
      run(c, `DELETE FROM control_queue WHERE session_group=? AND ${terminalControl}`, sessionGroup);
      const head = get(c, 'SELECT MAX(id) AS id FROM conversations WHERE session_group=?', sessionGroup).id;
      if (head === null) run(c, 'DELETE FROM group_heads WHERE session_group=?', sessionGroup);
      else run(c, 'INSERT INTO group_heads(session_group,head_id) VALUES(?,?) ON CONFLICT(session_group) DO UPDATE SET head_id=excluded.head_id', sessionGroup, head);
      run(c, "UPDATE group_deletion_audit SET status='done',completed_at=?,deleted_messages=?,deleted_attachments=?,deleted_files=?,counts_estimated=? WHERE operation_id=?", seconds(), deleted, n.attachments, n.files, Number(countsEstimated), operationId);
      run(c, "DELETE FROM drain_fences WHERE session_group=? AND reason='delete' AND operation_id=?", sessionGroup, operationId);
      return decode(audit(c, operationId));
    }),
  };
}
