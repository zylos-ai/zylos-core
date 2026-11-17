import { dataError, requireGroup } from './c4-session-group.js';
import { messageForFailureReceipt } from './failure-receipt-template.js';
import { MAX_RETRIES } from './c4-config.js';
export function deliveryFunctions({ read, write, snapshot, get, all, run, seconds, insert }) {
  const unfenced = "NOT EXISTS(SELECT 1 FROM drain_fences WHERE session_group=conversations.session_group OR session_group='*')";
  function groups(values) {
    if (values === undefined) return { sql: '', args: [] };
    if (!Array.isArray(values)) throw dataError('INVALID_ARGS', 'sessionGroups must be an array');
    values.forEach(value => requireGroup(value));
    return { sql: values.length ? ` AND session_group IN (${values.map(() => '?').join(',')})` : ' AND 0', args: values };
  }
  function enqueueReceipt(c, id, reason) {
    const row = get(c, 'SELECT id,channel,endpoint_id,session_group,delivery_action FROM conversations WHERE id=?', id);
    if (!row || row.delivery_action === 'failure_receipt' ||
        get(c, 'SELECT 1 FROM failure_receipts WHERE receipt_conversation_id=?', id) ||
        !row.endpoint_id || ['system', 'void'].includes(row.channel)) return;
    const queued = run(c, `INSERT OR IGNORE INTO failure_receipts(conversation_id,reason,state,created_at,updated_at)
      VALUES(?,?,'pending',?,?)`, id, reason, seconds(), seconds()).changes;
    if (!queued || row.channel !== 'internal') return;
    // The original sender is immutable routing metadata, never parsed from content.
    requireGroup(row.endpoint_id);
    const receipt = insert(c, 'in', 'internal', row.session_group,
      messageForFailureReceipt({ ...row, reason }), row.endpoint_id,
      { deliveryAction: 'failure_receipt' });
    run(c, "UPDATE failure_receipts SET state='queued',receipt_conversation_id=?,updated_at=? WHERE conversation_id=?",
      receipt.id, seconds(), id);
  }
  return {
    listFailureReceipts: ({ limit = 20 } = {}) => read(c => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw dataError('INVALID_ARGS', 'limit must be between 1 and 100');
      return all(c, `SELECT conversations.id,conversations.direction,conversations.channel,conversations.endpoint_id,
        conversations.session_group,failure_receipts.reason FROM failure_receipts
        JOIN conversations ON conversations.id=failure_receipts.conversation_id
        WHERE failure_receipts.state IN ('pending','queued') AND conversations.channel<>'internal' ORDER BY failure_receipts.updated_at,conversation_id LIMIT ?`, limit);
    }),
    settleFailureReceipt: (id, outcome) => write(c => {
      if (!['sent','suppressed','uncertain','failed'].includes(outcome)) throw dataError('INVALID_ARGS', 'Invalid receipt outcome');
      const terminal = outcome === 'sent' || outcome === 'suppressed';
      const changed = run(c, "UPDATE failure_receipts SET state=CASE WHEN ? THEN ? ELSE state END,updated_at=? WHERE conversation_id=? AND state IN ('pending','queued')",
        terminal ? 1 : 0, outcome, seconds(), id).changes > 0;
      return terminal && changed;
    }),
    getNextPending: ({ sessionGroups } = {}) => { const filter = groups(sessionGroups); return read(c => get(c, `SELECT * FROM conversations WHERE direction='in' AND status='pending' AND ${unfenced}${filter.sql} ORDER BY priority,id LIMIT 1`, ...filter.args) ?? null); },
    claimConversation: id => write(c => run(c, `UPDATE conversations SET status='running' WHERE id=? AND direction='in' AND status='pending' AND ${unfenced}`, id).changes > 0),
    requeueConversation: id => write(c => run(c, "UPDATE conversations SET status='pending' WHERE id=? AND direction='in' AND status='running'", id).changes > 0),
    markDelivered: (id, { sessionId } = {}) => write(c => run(c, "UPDATE conversations SET status='delivered',session_id=? WHERE id=? AND direction='in' AND status='running'", sessionId ?? null, id).changes > 0),
    expirePending: (id, maxAgeSeconds) => write(c => {
      if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) throw dataError('INVALID_ARGS', 'maxAgeSeconds must be a positive integer');
      const changed = run(c, "UPDATE conversations SET status='failed',delivery_action='pending_expired' WHERE id=? AND direction='in' AND status='pending' AND ?-unixepoch(timestamp)>?", id, seconds(), maxAgeSeconds).changes > 0;
      if (changed) enqueueReceipt(c, id, 'pending_expired');
      return changed;
    }),
    failDelivery: (id, { maxRetries = MAX_RETRIES, reason = 'delivery_failed' } = {}) => write(c => {
      if (!Number.isSafeInteger(maxRetries) || maxRetries < 1) throw dataError('INVALID_ARGS', 'maxRetries must be positive');
      if (!['delivery_failed', 'launch_failed', 'ready_timeout'].includes(reason)) throw dataError('INVALID_ARGS', 'Invalid delivery failure reason');
      const row = get(c, "UPDATE conversations SET retry_count=retry_count+1,status=CASE WHEN retry_count+1>=? THEN 'failed' ELSE 'pending' END WHERE id=? AND direction='in' AND status='running' RETURNING status,retry_count AS retryCount", maxRetries, id);
      if (row?.status === 'failed') enqueueReceipt(c, id, reason);
      if (row) return { changed: true, ...row };
      return { changed: false, status: null, retryCount: null, ...get(c, 'SELECT status,retry_count AS retryCount FROM conversations WHERE id=?', id) };
    }),
    recoverOrphanRunning: ({ maxAgeSeconds }) => write(c => {
      if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1) throw dataError('INVALID_ARGS', 'maxAgeSeconds must be positive');
      const result = { requeued: { ids: [], count: 0 }, ageExpired: { ids: [], count: 0 }, retryExhausted: { ids: [], count: 0 } };
      const rows = all(c, `UPDATE conversations SET
        status=CASE WHEN ?-unixepoch(timestamp)>? OR retry_count+1>=? THEN 'failed' ELSE 'pending' END,
        delivery_action=CASE WHEN ?-unixepoch(timestamp)>? THEN 'orphan_expired' WHEN retry_count+1>=? THEN 'orphan_retry_exhausted' ELSE delivery_action END,
        retry_count=CASE WHEN ?-unixepoch(timestamp)>? THEN retry_count ELSE retry_count+1 END
        WHERE direction='in' AND status='running' RETURNING id,status,delivery_action`, seconds(), maxAgeSeconds, MAX_RETRIES, seconds(), maxAgeSeconds, MAX_RETRIES, seconds(), maxAgeSeconds);
      for (const row of rows.sort((a,b) => a.id-b.id)) {
        const key = row.status === 'pending' ? 'requeued' : row.delivery_action === 'orphan_expired' ? 'ageExpired' : 'retryExhausted';
        result[key].ids.push(row.id); result[key].count++;
        if (row.status === 'failed') enqueueReceipt(c, row.id, row.delivery_action);
      }
      return result;
    }),
    listGroupQueues: () => snapshot(c => {
      const groups = new Map();
      const entry = sessionGroup => {
        if (!groups.has(sessionGroup)) groups.set(sessionGroup, { sessionGroup, pending: { count: 0, oldestAt: null, head: null }, running: { count: 0 }, fence: null });
        return groups.get(sessionGroup);
      };
      for (const row of all(c, "SELECT session_group,status,priority,id,timestamp FROM conversations WHERE direction='in' AND status IN ('pending','running') AND session_group<>''")) {
        const group = entry(row.session_group);
        if (row.status === 'running') { group.running.count++; continue; }
        const pending = group.pending;
        pending.count++;
        const timestamp = Date.parse(row.timestamp.includes('T') ? row.timestamp : row.timestamp.replace(' ', 'T') + 'Z');
        pending.oldestAt = pending.oldestAt === null ? timestamp : Math.min(pending.oldestAt, timestamp);
        if (!pending.head || row.priority < pending.head.priority || (row.priority === pending.head.priority && row.id < pending.head.id)) pending.head = { id: row.id, priority: row.priority };
      }
      let globalFence = null;
      for (const fence of all(c, 'SELECT session_group AS sessionGroup,reason,run_id AS runId,created_at AS createdAt FROM drain_fences')) {
        if (fence.sessionGroup === '*') globalFence = fence;
        else entry(fence.sessionGroup).fence = fence;
      }
      return { groups: [...groups.values()].sort((a, b) => Buffer.compare(Buffer.from(a.sessionGroup), Buffer.from(b.sessionGroup))), globalFence };
    }),
    listPendingSessionGroups: () => read(c => all(c, `WITH pending AS (SELECT session_group,id,priority,ROW_NUMBER() OVER(PARTITION BY session_group ORDER BY priority,id) AS rn,COUNT(*) OVER(PARTITION BY session_group) AS count FROM conversations WHERE direction='in' AND status='pending' AND session_group<>'' AND ${unfenced}) SELECT session_group AS sessionGroup,id AS headId,priority AS headPriority,count FROM pending WHERE rn=1 ORDER BY priority,id`)),
    countRunningConversations: group => { requireGroup(group); return read(c => get(c, "SELECT count(*) AS n FROM conversations WHERE session_group=? AND direction='in' AND status='running'", group).n); },
    countGlobalRunningConversations: () => read(c => get(c, "SELECT count(*) AS n FROM conversations WHERE direction='in' AND status='running'").n),
    hasOutboundAfter: (group, id) => { requireGroup(group); return read(c => !!get(c, "SELECT 1 FROM conversations WHERE session_group=? AND id>? AND direction='out' LIMIT 1", group, id)); },
    getLastActivity: group => { requireGroup(group); return read(c => { const head = get(c, 'SELECT head_id FROM group_heads WHERE session_group=?', group); return head ? get(c, 'SELECT id,timestamp AS ts FROM conversations WHERE id=?', head.head_id) ?? null : null; }); },
    markStatusNoticeSuppressed: (id, { sessionGroup, channel, endpointId, health, reason }) => write(c => {
      health = health || 'unavailable'; reason = reason || health;
      return run(c, `UPDATE conversations SET content=content||?,delivery_action='suppressed' WHERE id=? AND direction='in' AND status='failed' AND COALESCE(delivery_action,'') NOT IN ('auth_rejected','pending_expired','suppressed') AND session_group=? AND channel=? AND endpoint_id IS ?`, `\n\n[C4] Status notification suppressed by cooldown while health=${health} reason=${reason}.`, id, sessionGroup, channel, endpointId ?? null).changes > 0;
    }),
  };
}
