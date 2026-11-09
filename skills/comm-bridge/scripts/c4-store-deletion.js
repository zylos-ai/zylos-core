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
    targetKey: row.target_key, cutoffId: row.cutoff_id, generationId: row.generation_id,
    startedAt: row.started_at, completedAt: row.completed_at, status: row.status, countsEstimated: Boolean(row.counts_estimated),
    preview: { messages: row.preview_messages, attachments: row.preview_attachments, files: row.preview_files },
    retainedMessages: row.retained_messages, groupDataRetained: row.retained_messages > 0,
    counts: { messages: row.deleted_messages, attachments: row.deleted_attachments, files: row.deleted_files } };
}

export function deletionFunctions({ read, write, snapshot, get, all, run, seconds }) {
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
  function target(value) {
    let key;
    try { key = JSON.parse(value); } catch { throw dataError('INVALID_ARGS', 'A confirmed deletion target is required'); }
    if (!Array.isArray(key) || JSON.stringify(key) !== value) throw dataError('INVALID_ARGS', 'Invalid confirmed target');
    if (key[0] === 'group' && key.length === 2) { group(key[1]); return key; }
    if (key[0] === 'draft' && key.length === 3 && typeof key[1] === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(key[1]) &&
        typeof key[2] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(key[2])) return key;
    throw dataError('INVALID_ARGS', 'Invalid confirmed target');
  }
  const generation = (c, targetKey) => get(c, "SELECT operation_id FROM group_deletion_audit WHERE target_key=? AND status='done' ORDER BY rowid DESC LIMIT 1", targetKey)?.operation_id ?? null;
  function boundary(c, targetKey, cutoffId, generationId) {
    const key = target(targetKey);
    if (!count(cutoffId) || !(generationId === null || text(generationId))) throw dataError('INVALID_ARGS', 'A confirmed deletion boundary is required');
    if (generation(c, targetKey) !== generationId) throw dataError('DELETION_PREVIEW_STALE', 'The conversation changed; preview deletion again');
    const maxId = key[0] === 'group' ? get(c, 'SELECT COALESCE(MAX(id),0) AS id FROM conversations WHERE session_group=?', key[1]).id : 0;
    if (cutoffId > maxId) throw dataError('DELETION_PREVIEW_STALE', 'The confirmed cutoff exceeds the conversation; preview deletion again');
  }
  function draft(c, localId, targetKey) {
    const key = target(targetKey);
    if (key[0] !== 'draft' || key[2] !== localId) throw dataError('DELETION_OWNERSHIP_MISMATCH', 'Draft target does not match');
    const namespace = get(c, "SELECT namespace FROM channel_namespaces WHERE component_name='dashboard'")?.namespace;
    if (namespace !== key[1]) throw dataError('DELETION_PREVIEW_STALE', 'The conversation namespace changed');
    const name = `${namespace}:${localId}`;
    if (get(c, 'SELECT 1 FROM conversations WHERE session_group=? LIMIT 1', name) || get(c, 'SELECT 1 FROM group_heads WHERE session_group=?', name)) throw dataError('DRAFT_BECAME_ACTIVE', 'The draft received a message');
  }
  return {
    getDeletionPreviewBoundary: targetKey => snapshot(c => {
      const key = target(targetKey);
      const active = get(c, "SELECT * FROM group_deletion_audit WHERE target_key=? AND status='started' ORDER BY rowid DESC LIMIT 1", targetKey);
      if (active) return { cutoffId: active.cutoff_id, generationId: active.generation_id, operationId: active.operation_id, pending: true };
      return { cutoffId: key[0] === 'group' ? get(c, 'SELECT COALESCE(MAX(id),0) AS id FROM conversations WHERE session_group=?', key[1]).id : 0,
        generationId: generation(c, targetKey), pending: false };
    }),
    getGroupDeletionAudit: operationId => read(c => decode(audit(c, operationId))),
    markDeletionCleanup: operationId => write(c => {
      const row = audit(c, operationId);
      if (!row || row.status !== 'started') throw dataError('DELETION_OWNERSHIP_MISMATCH', 'Deletion operation is not active');
      if (row.session_group !== null) owned(c, row.session_group, operationId);
      else draft(c, row.draft_local_id, row.target_key);
      run(c, 'UPDATE group_deletion_audit SET cleanup_attempts=cleanup_attempts+1 WHERE operation_id=?', operationId);
    }),
    retractDeletionCleanup: operationId => write(c => {
      const row = audit(c, operationId);
      if (!row || row.status !== 'started' || row.cleanup_attempts === 0) return;
      run(c, 'UPDATE group_deletion_audit SET cleanup_attempts=cleanup_attempts-1 WHERE operation_id=?', operationId);
    }),
    beginDraftDeletion: (localId, { operationId, actor, preview, targetKey, cutoffId, generationId } = {}) => write(c => {
      if (!text(operationId) || !text(actor)) throw dataError('INVALID_ARGS', 'Deletion identity and actor are required');
      const before = audit(c, operationId);
      if (before && (before.session_group !== null || before.draft_local_id !== localId)) throw dataError('DELETION_OWNERSHIP_MISMATCH', 'Operation belongs to another target');
      if (before?.status === 'done') return decode(before);
      if (before && (before.target_key !== targetKey || before.cutoff_id !== cutoffId || before.generation_id !== generationId)) throw dataError('DELETION_OWNERSHIP_MISMATCH', 'Confirmed deletion boundary does not match');
      draft(c, localId, targetKey);
      boundary(c, targetKey, cutoffId, generationId);
      if (cutoffId !== 0) throw dataError('INVALID_ARGS', 'Draft cutoff must be zero');
      if (get(c, "SELECT 1 FROM mode_transitions WHERE phase<>'complete'")) throw dataError('TRANSITION_OPEN', 'Mode transition is in progress');
      const active = get(c, "SELECT * FROM group_deletion_audit WHERE target_key=? AND status='started'", targetKey);
      if (active) {
        if (active.operation_id !== operationId) throw dataError('DELETION_OWNERSHIP_MISMATCH', 'Another deletion owns this target');
        return decode(active);
      }
      const n = amounts(preview);
      run(c, "INSERT INTO group_deletion_audit(operation_id,session_group,draft_local_id,actor,target_key,cutoff_id,generation_id,started_at,status,preview_messages,preview_attachments,preview_files) VALUES(?,NULL,?,?,?,?,?,?,'started',?,?,?)", operationId, localId, actor, targetKey, cutoffId, generationId, seconds(), n.messages, n.attachments, n.files);
      return decode(audit(c, operationId));
    }),
    finalizeDraftDeletion: (localId, { operationId, counts, cleanup } = {}) => write(c => {
      const row = audit(c, operationId);
      if (!row || row.session_group !== null || row.draft_local_id !== localId) throw dataError('DELETION_OWNERSHIP_MISMATCH', 'Draft operation does not match');
      if (row.status === 'done') return decode(row);
      // Another caller may have cleaned files after this caller marked its
      // attempt. Recheck durable count confidence under the final writer lock.
      const countsEstimated = row.cleanup_attempts > 1;
      draft(c, localId, row.target_key);
      if (get(c, "SELECT 1 FROM mode_transitions WHERE phase<>'complete'")) throw dataError('TRANSITION_OPEN', 'Mode transition is in progress');
      const removed = cleanupNow(cleanup, c), n = amounts({ ...counts, ...removed });
      run(c, "UPDATE group_deletion_audit SET status='done',completed_at=?,deleted_messages=0,deleted_attachments=?,deleted_files=?,counts_estimated=? WHERE operation_id=?", seconds(), n.attachments, n.files, Number(countsEstimated), operationId);
      return decode(audit(c, operationId));
    }),

    getActiveDeletion: sessionGroup => { group(sessionGroup); return read(c => decode(get(c, "SELECT a.* FROM drain_fences f JOIN group_deletion_audit a ON a.operation_id=f.operation_id WHERE f.session_group=? AND f.reason='delete' AND a.status='started'", sessionGroup))); },
    beginGroupDeletion: (sessionGroup, { operationId, actor, runId = null, preview, targetKey, cutoffId, generationId } = {}) => write(c => {
      group(sessionGroup);
      if (!text(operationId) || !text(actor) || runId !== null && !text(runId)) throw dataError('INVALID_ARGS', 'Deletion identity and actor are required');
      const before = audit(c, operationId);
      if (before && before.session_group !== sessionGroup) throw dataError('DELETION_OWNERSHIP_MISMATCH', 'Operation belongs to another group');
      if (before?.status === 'done') return decode(before);
      if (targetKey !== JSON.stringify(['group', sessionGroup])) throw dataError('DELETION_OWNERSHIP_MISMATCH', 'Confirmed group does not match');
      if (before && (before.target_key !== targetKey || before.cutoff_id !== cutoffId || before.generation_id !== generationId)) throw dataError('DELETION_OWNERSHIP_MISMATCH', 'Confirmed deletion boundary does not match');
      boundary(c, targetKey, cutoffId, generationId);
      if (get(c, "SELECT 1 FROM mode_transitions WHERE phase<>'complete'") || get(c, "SELECT 1 FROM drain_fences WHERE session_group='*'")) throw dataError('TRANSITION_OPEN', 'Mode transition or global drain is in progress');
      const fence = get(c, 'SELECT * FROM drain_fences WHERE session_group=?', sessionGroup);
      if (fence) {
        if (fence.reason !== 'delete' || !fence.operation_id) throw dataError('FENCE_MISMATCH', 'The group is owned by another operation');
        if (fence.operation_id !== operationId) throw dataError('DELETION_OWNERSHIP_MISMATCH', 'Another deletion owns this group');
        return decode(owned(c, sessionGroup, fence.operation_id).row);
      }
      if (before) throw dataError('DELETION_OWNERSHIP_MISMATCH', 'Deletion audit exists without its fence');
      const n = amounts(preview), started = seconds();
      run(c, "INSERT INTO group_deletion_audit(operation_id,session_group,actor,run_id,target_key,cutoff_id,generation_id,started_at,status,preview_messages,preview_attachments,preview_files) VALUES(?,?,?,?,?,?,?,?,'started',?,?,?)", operationId, sessionGroup, actor, runId, targetKey, cutoffId, generationId, started, n.messages, n.attachments, n.files);
      run(c, "INSERT INTO drain_fences(session_group,reason,run_id,created_at,operation_id,actor) VALUES(?,'delete',?,?,?,?)", sessionGroup, runId ?? operationId, started, operationId, actor);
      return decode(audit(c, operationId));
    }),
    listDeletionMessages: (sessionGroup, { operationId } = {}) => read(c => {
      const { row } = owned(c, sessionGroup, operationId);
      return all(c, `SELECT id,direction,status,channel,endpoint_id,session_id FROM conversations WHERE session_group=? AND id<=? AND ${terminalMessage} ORDER BY id`, sessionGroup, row.cutoff_id);
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
      const deleted = run(c, `DELETE FROM conversations WHERE session_group=? AND id<=? AND ${terminalMessage}`, sessionGroup, row.cutoff_id).changes;
      const retainedMessages = get(c, 'SELECT COUNT(*) AS n FROM conversations WHERE session_group=?', sessionGroup).n;
      if (retainedMessages === 0) {
        for (const table of ['checkpoints','origin_sync_cursors','group_runtime_overrides','group_model_overrides','run_endings','slot_occupancy']) run(c, `DELETE FROM ${table} WHERE session_group=?`, sessionGroup);
        // Bound controls are for the stopped executor; unbound pending controls
        // remain eligible for the newly created group.
        run(c, "UPDATE control_queue SET status='superseded',updated_at=? WHERE session_group=? AND status='pending' AND target_binding IS NOT NULL AND json_extract(target_binding,'$.expectedRunId')=?", seconds(), sessionGroup, fence.run_id);
        run(c, `DELETE FROM control_queue WHERE session_group=? AND ${terminalControl}`, sessionGroup);
      }
      const head = get(c, 'SELECT MAX(id) AS id FROM conversations WHERE session_group=?', sessionGroup).id;
      if (head === null) run(c, 'DELETE FROM group_heads WHERE session_group=?', sessionGroup);
      else run(c, 'INSERT INTO group_heads(session_group,head_id) VALUES(?,?) ON CONFLICT(session_group) DO UPDATE SET head_id=excluded.head_id', sessionGroup, head);
      run(c, "UPDATE group_deletion_audit SET status='done',completed_at=?,deleted_messages=?,deleted_attachments=?,deleted_files=?,counts_estimated=?,retained_messages=? WHERE operation_id=?", seconds(), deleted, n.attachments, n.files, Number(countsEstimated), retainedMessages, operationId);
      run(c, "DELETE FROM drain_fences WHERE session_group=? AND reason='delete' AND operation_id=?", sessionGroup, operationId);
      return decode(audit(c, operationId));
    }),
  };
}
