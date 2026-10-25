import { dataError, requireGroup } from './c4-session-group.js';
import { MAX_RETRIES } from './c4-config.js';
export function deliveryFunctions({ read, write, get, all, run, seconds }) {
  const unfenced = "NOT EXISTS(SELECT 1 FROM drain_fences WHERE session_group=conversations.session_group OR session_group='*')";
  function groups(values) {
    if (values === undefined) return { sql: '', args: [] };
    if (!Array.isArray(values)) throw dataError('INVALID_ARGS', 'sessionGroups must be an array');
    values.forEach(value => requireGroup(value));
    return { sql: values.length ? ` AND session_group IN (${values.map(() => '?').join(',')})` : ' AND 0', args: values };
  }
  return {
    getNextPending: ({ sessionGroups } = {}) => { const filter = groups(sessionGroups); return read(c => get(c, `SELECT * FROM conversations WHERE direction='in' AND status='pending' AND ${unfenced}${filter.sql} ORDER BY priority,id LIMIT 1`, ...filter.args) ?? null); },
    claimConversation: id => write(c => run(c, `UPDATE conversations SET status='running' WHERE id=? AND direction='in' AND status='pending' AND ${unfenced}`, id).changes > 0),
    requeueConversation: id => write(c => run(c, "UPDATE conversations SET status='pending' WHERE id=? AND direction='in' AND status='running'", id).changes > 0),
    markDelivered: (id, { sessionId } = {}) => write(c => run(c, "UPDATE conversations SET status='delivered',session_id=? WHERE id=? AND direction='in' AND status='running'", sessionId ?? null, id).changes > 0),
    expirePending: (id, maxAgeSeconds) => write(c => {
      if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) throw dataError('INVALID_ARGS', 'maxAgeSeconds must be a positive integer');
      return run(c, "UPDATE conversations SET status='failed',delivery_action='pending_expired' WHERE id=? AND direction='in' AND status='pending' AND ?-unixepoch(timestamp)>?", id, seconds(), maxAgeSeconds).changes > 0;
    }),
    failDelivery: (id, { maxRetries = MAX_RETRIES } = {}) => write(c => {
      if (!Number.isSafeInteger(maxRetries) || maxRetries < 1) throw dataError('INVALID_ARGS', 'maxRetries must be positive');
      const row = get(c, "UPDATE conversations SET retry_count=retry_count+1,status=CASE WHEN retry_count+1>=? THEN 'failed' ELSE 'pending' END WHERE id=? AND direction='in' AND status='running' RETURNING status,retry_count AS retryCount", maxRetries, id);
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
      }
      return result;
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
