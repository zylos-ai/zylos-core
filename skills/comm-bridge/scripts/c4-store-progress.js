import { dataError, requireGroup } from './c4-session-group.js';
export function progressFunctions({ read, write, snapshot, get, all, run, seconds }) {
  const loadable = "((direction='in' AND status='delivered') OR direction='out')";
  const scope = group => group === '*' ? { sql: '', args: [] } : { sql: ' AND session_group=?', args: [requireGroup(group)] };
  const baseline = c => get(c, "SELECT COALESCE(end_conversation_id,0) AS n FROM checkpoints WHERE session_group='*' ORDER BY id DESC LIMIT 1")?.n ?? 0;
  const coverage = (c, group) => Math.max(group === '*' ? 0 : baseline(c), get(c, 'SELECT COALESCE(MAX(end_conversation_id),0) AS n FROM checkpoints WHERE session_group=?', group).n);
  function frontier(c, group, start = coverage(c, group)) {
    const f = scope(group);
    const gap = get(c, `SELECT MIN(id) AS n FROM conversations WHERE id>?${f.sql} AND direction='in' AND status NOT IN ('delivered','failed','switch_absorbed')`, start, ...f.args).n;
    return gap === null ? get(c, `SELECT COALESCE(MAX(id),?) AS n FROM conversations WHERE id>?${f.sql}`, start, start, ...f.args).n : gap - 1;
  }
  function checkpoint(c, group, end, summary, { noContent = false, cutover = false } = {}) {
    requireGroup(group, { global: true });
    if (!Number.isSafeInteger(end) || end < 0) throw dataError('INVALID_ARGS', 'end must be a nonnegative integer');
    const covered = coverage(c, group), f = scope(group);
    if (end < covered) throw dataError('CHECKPOINT_REGRESSION', 'Checkpoint would move coverage backwards');
    if (get(c, `SELECT 1 FROM conversations WHERE id>? AND id<=?${f.sql} AND direction='in' AND status NOT IN ('delivered','failed','switch_absorbed') LIMIT 1`, covered, end, ...f.args)) throw dataError('CHECKPOINT_GAP', 'Checkpoint crosses unfinished input');
    const head = get(c, `SELECT COALESCE(MAX(id),0) AS n FROM conversations WHERE 1${f.sql}`, ...f.args).n;
    if (end > head) throw dataError('CHECKPOINT_BEYOND_HEAD', 'Checkpoint exceeds message head');
    if (noContent ? summary !== null && summary !== undefined : typeof summary !== 'string' || (!cutover && summary.length === 0)) throw dataError('SUMMARY_INVALID', 'Summary and noContent do not agree');
    const previous = get(c, 'SELECT COALESCE(end_conversation_id,0) AS n FROM checkpoints WHERE session_group=? ORDER BY id DESC LIMIT 1', group);
    const base = baseline(c);
    const start = group === '*' ? (previous?.n ?? 0) + 1 : previous && previous.n > base ? previous.n + 1 : get(c, 'SELECT MIN(id) AS n FROM conversations WHERE session_group=? AND id>?', group, base).n;
    const id = run(c, 'INSERT INTO checkpoints(summary,start_conversation_id,end_conversation_id,session_group,no_content) VALUES(?,?,?,?,?)', noContent ? null : summary, start, end, group, noContent ? 1 : 0).lastInsertRowid;
    return get(c, 'SELECT * FROM checkpoints WHERE id=?', id);
  }
  function range(c, group) {
    const covered = coverage(c, group), safeEnd = frontier(c, group, covered), f = scope(group);
    const row = get(c, `SELECT count(*) AS count,MIN(id) AS firstConversationId,MAX(id) AS lastConversationId FROM conversations WHERE id>? AND id<=? AND status='delivered'${f.sql}`, covered, safeEnd, ...f.args);
    return { ...row, firstAt: row.count ? get(c, 'SELECT timestamp FROM conversations WHERE id=?', row.firstConversationId).timestamp : null, safeEnd };
  }
  function limitClause(limit, required = false) {
    if (limit === undefined && !required) return { sql: '', args: [] };
    if (!Number.isSafeInteger(limit) || limit < 1) throw dataError('INVALID_ARGS', 'limit must be a positive integer');
    return { sql: ' LIMIT ?', args: [limit] };
  }
  function upper(c, group, value) {
    if (!Number.isSafeInteger(value) || value < 0) throw dataError('INVALID_ARGS', 'upToConversationId is required');
    if (value > frontier(c, group)) throw dataError('UPTO_BEYOND_FRONTIER', 'Read exceeds the delivered frontier');
  }
  function tail(c, group, after, { limit } = {}) {
    const f = scope(group), l = limitClause(limit, true);
    return all(c, `SELECT * FROM conversations WHERE id>?${f.sql} AND ${loadable} ORDER BY id DESC${l.sql}`, after, ...f.args, ...l.args).reverse();
  }
  function unsummarized(c, group, { upToConversationId, limit } = {}) {
    upper(c, group, upToConversationId);
    const f = scope(group), l = limitClause(limit);
    return all(c, `SELECT * FROM conversations WHERE id>? AND id<=?${f.sql} AND status='delivered' ORDER BY id${l.sql}`, coverage(c, group), upToConversationId, ...f.args, ...l.args);
  }
  const groupRead = (group, operation) => { requireGroup(group); return snapshot(c => operation(c, group)); };
  const api = {
    legacyBaselineEnd: () => read(baseline),
    getCoverageEnd: group => groupRead(group, coverage),
    getGlobalCoverageEnd: () => read(c => coverage(c, '*')),
    getDeliveredFrontier: group => groupRead(group, frontier),
    getGlobalDeliveredFrontier: () => snapshot(c => frontier(c, '*')),
    createCheckpoint: (group, end, summary, options) => write(c => checkpoint(c, group, end, summary, { noContent: options?.noContent })),
    getLatestContentCheckpoint: group => { requireGroup(group, { global: true }); return snapshot(c => get(c, `SELECT * FROM checkpoints WHERE session_group=? AND no_content=0${group === '*' ? '' : ' AND end_conversation_id>?'} ORDER BY id DESC LIMIT 1`, group, ...(group === '*' ? [] : [baseline(c)])) ?? null); },
    getDeliveredSince: (group, after, options) => groupRead(group, c => tail(c, group, after, options)),
    getGlobalDeliveredSince: (after, options) => read(c => tail(c, '*', after, options)),
    getUnsummarizedRange: group => groupRead(group, range),
    getGlobalUnsummarizedRange: () => snapshot(c => range(c, '*')),
    getUnsummarizedConversations: (group, options) => groupRead(group, c => unsummarized(c, group, options)),
    getGlobalUnsummarizedConversations: options => snapshot(c => unsummarized(c, '*', options)),
    getContentCheckpointsSince: (group, afterEnd) => { requireGroup(group, { global: true }); return snapshot(c => all(c, 'SELECT * FROM checkpoints WHERE session_group=? AND end_conversation_id>? AND no_content=0 ORDER BY id', group, Math.max(afterEnd, group === '*' ? 0 : baseline(c)))); },
    getOriginSyncConversations: (group, { afterConversationId, rawAfter, upToConversationId, limit }) => groupRead(group, c => {
      if (![afterConversationId, rawAfter].every(n => Number.isSafeInteger(n) && n >= 0)) throw dataError('INVALID_ARGS', 'Both fixed read boundaries are required');
      upper(c, group, upToConversationId); const l = limitClause(limit, true);
      return all(c, `SELECT * FROM conversations WHERE session_group=? AND id>? AND id<=? AND ${loadable} ORDER BY id${l.sql}`, group, Math.max(afterConversationId, rawAfter), upToConversationId, ...l.args);
    }),
    advanceOriginSyncCursor: (group, { syncedId, checkpointId }) => write(c => {
      requireGroup(group);
      const old = get(c, 'SELECT * FROM origin_sync_cursors WHERE session_group=?', group);
      const maxCheckpoint = get(c, 'SELECT COALESCE(MAX(id),0) AS n FROM checkpoints WHERE session_group=?', group).n;
      if (![syncedId, checkpointId].every(n => Number.isSafeInteger(n) && n >= 0) || syncedId < (old?.synced_id ?? 0) || syncedId > frontier(c, group) || checkpointId < (old?.checkpoint_id ?? 0) || checkpointId > maxCheckpoint) throw dataError('CURSOR_INVALID', 'Cursor would regress or exceed its source');
      run(c, 'INSERT INTO origin_sync_cursors(session_group,synced_id,checkpoint_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(session_group) DO UPDATE SET synced_id=excluded.synced_id,checkpoint_id=excluded.checkpoint_id,updated_at=excluded.updated_at', group, syncedId, checkpointId, seconds());
    }),
    getOriginSyncBacklog: () => snapshot(c => {
      const base = baseline(c), groups = [];
      for (const head of all(c, `SELECT h.*,s.synced_id,s.checkpoint_id,s.updated_at
        FROM group_heads h LEFT JOIN origin_sync_cursors s USING(session_group)
        WHERE h.head_id > MAX(COALESCE(s.synced_id,0),?) OR EXISTS(
          SELECT 1 FROM checkpoints p WHERE p.session_group=h.session_group
          AND p.id>COALESCE(s.checkpoint_id,0) AND p.end_conversation_id>? AND p.no_content=0)
        ORDER BY h.session_group COLLATE BINARY`, base, base)) {
        const group = head.session_group, cursorFrom = Math.max(head.synced_id ?? 0, base), checkpointFrom = head.checkpoint_id ?? 0;
        const summaries = get(c, 'SELECT COUNT(*) AS n,MIN(id) AS first FROM checkpoints WHERE session_group=? AND id>? AND end_conversation_id>? AND no_content=0', group, checkpointFrom, base);
        if (head.head_id <= cursorFrom && !summaries.n) continue;
        const upTo = frontier(c, group);
        if (upTo <= cursorFrom && !summaries.n) continue;
        const rows = get(c, `SELECT COUNT(*) AS n,MIN(id) AS first FROM conversations WHERE session_group=? AND id>? AND id<=? AND ${loadable}`, group, cursorFrom, upTo);
        groups.push({ sessionGroup: group, cursorFrom, checkpointFrom, rawFrom: Math.max(cursorFrom, coverage(c, group)), upTo, count: rows.n, firstAt: rows.n ? get(c, 'SELECT timestamp FROM conversations WHERE id=?', rows.first).timestamp : null, pendingCheckpoints: summaries.n, firstCheckpointAt: summaries.n ? get(c, 'SELECT timestamp FROM checkpoints WHERE id=?', summaries.first).timestamp : null, cursorUpdatedAt: head.updated_at ?? null });
      }
      return { total: groups.reduce((n, g) => n + g.count, 0), groups };
    }),
    auditCheckpoints: () => snapshot(c => {
      const max = get(c, 'SELECT COALESCE(MAX(id),0) AS n FROM conversations').n;
      return all(c, 'SELECT id,end_conversation_id FROM checkpoints WHERE end_conversation_id>? ORDER BY id', max).map(row => ({ checkpointId: row.id, end: row.end_conversation_id, maxConversationId: max, affected: { B: baseline(c), coverageAll: coverage(c, '*') }, repairRequired: true }));
    }),
  };
  function originSummaries(group, afterCheckpointId) {
    requireGroup(group);
    return snapshot(c => {
      const cursor = afterCheckpointId ?? get(c, 'SELECT checkpoint_id FROM origin_sync_cursors WHERE session_group=?', group)?.checkpoint_id ?? 0;
      const rows = all(c, 'SELECT * FROM checkpoints WHERE session_group=? AND id>? AND end_conversation_id>? AND no_content=0 ORDER BY id', group, cursor, baseline(c));
      return { rows, coverageEnd: coverage(c, group), checkpointId: rows.at(-1)?.id ?? cursor };
    });
  }
  function unsummarizedQuery({ group = '*', upToConversationId, limit } = {}) {
    requireGroup(group, { global: true });
    return snapshot(c => {
      const safeEnd = frontier(c, group), requested = upToConversationId ?? safeEnd;
      const rows = unsummarized(c, group, { upToConversationId: requested, limit });
      const latest = get(c, `SELECT end_conversation_id FROM checkpoints WHERE session_group=? AND no_content=0${group === '*' ? '' : ' AND end_conversation_id>?'} ORDER BY id DESC LIMIT 1`, group, ...(group === '*' ? [] : [baseline(c)]));
      const f = scope(group);
      const more = rows.length && get(c, `SELECT 1 FROM conversations WHERE id>? AND id<=?${f.sql} AND status='delivered' LIMIT 1`, rows.at(-1).id, requested, ...f.args);
      return { rows, checkpointEnd: latest?.end_conversation_id ?? 0, safeEnd, upTo: more ? rows.at(-1).id : requested };
    });
  }
  return { api, coverage, frontier, checkpoint, originSummaries, unsummarizedQuery };
}
