import { dataError, requireGroup } from './c4-session-group.js';
export function progressFunctions({ read, write, snapshot, get, all, run, dependencies }) {
  const loadable = "((direction='in' AND status='delivered') OR direction='out')";
  const scope = group => group === '*' ? { sql: '', args: [] } : { sql: ' AND session_group=?', args: [requireGroup(group)] };
  const baseline = c => get(c, "SELECT COALESCE(end_conversation_id,0) AS n FROM checkpoints WHERE session_group='*' ORDER BY id DESC LIMIT 1")?.n ?? 0;
  const coverage = (c, group) => Math.max(group === '*' ? 0 : baseline(c), get(c, 'SELECT COALESCE(MAX(end_conversation_id),0) AS n FROM checkpoints WHERE session_group=?', group).n);
  function originSingle(c, group) {
    if (group !== 'origin') return false;
    if (typeof dependencies.readConfig !== 'function') throw new TypeError('Origin progress requires readConfig');
    if (get(c, "SELECT 1 FROM mode_transitions WHERE phase<>'complete'")) return true;
    try {
      const result = dependencies.readConfig();
      if (result?.state === 'missing') return false;
      const config = result?.config;
      if (result?.state !== 'ok' || !config || typeof config !== 'object' || Array.isArray(config)) return true;
      return config.session_mode === undefined ? false : config.session_mode !== 'multi';
    } catch { return true; }
  }
  function frontier(c, group, start = coverage(c, group)) {
    const single = originSingle(c, group), f = scope(single ? '*' : group);
    const gap = get(c, `SELECT MIN(id) AS n FROM conversations WHERE id>?${f.sql} AND direction='in' AND status NOT IN ('delivered','failed','switch_absorbed')`, start, ...f.args).n;
    if (single) {
      const head = get(c, 'SELECT COALESCE(MAX(id),?) AS n FROM conversations WHERE id>? AND session_group=?', start, start, group).n;
      return gap === null ? head : Math.min(gap - 1, head);
    }
    return gap === null ? get(c, `SELECT COALESCE(MAX(id),?) AS n FROM conversations WHERE id>?${f.sql}`, start, start, ...f.args).n : gap - 1;
  }
  function checkpoint(c, group, end, summary, { noContent = false } = {}) {
    requireGroup(group, { global: true });
    if (!Number.isSafeInteger(end) || end < 0) throw dataError('INVALID_ARGS', 'end must be a nonnegative integer');
    const covered = coverage(c, group), f = scope(group);
    if (end < covered) throw dataError('CHECKPOINT_REGRESSION', 'Checkpoint would move coverage backwards');
    const gapScope = scope(originSingle(c, group) ? '*' : group);
    if (get(c, `SELECT 1 FROM conversations WHERE id>? AND id<=?${gapScope.sql} AND direction='in' AND status NOT IN ('delivered','failed','switch_absorbed') LIMIT 1`, covered, end, ...gapScope.args)) throw dataError('CHECKPOINT_GAP', 'Checkpoint crosses unfinished input');
    const head = get(c, `SELECT COALESCE(MAX(id),0) AS n FROM conversations WHERE 1${f.sql}`, ...f.args).n;
    if (end > head) throw dataError('CHECKPOINT_BEYOND_HEAD', 'Checkpoint exceeds message head');
    if (noContent ? summary !== null && summary !== undefined : typeof summary !== 'string' || summary.length === 0) throw dataError('SUMMARY_INVALID', 'Summary and noContent do not agree');
    const previous = get(c, 'SELECT COALESCE(end_conversation_id,0) AS n FROM checkpoints WHERE session_group=? ORDER BY id DESC LIMIT 1', group);
    const base = baseline(c);
    const start = group === '*' ? (previous?.n ?? 0) + 1 : previous && previous.n > base ? previous.n + 1 : get(c, 'SELECT MIN(id) AS n FROM conversations WHERE session_group=? AND id>?', group, base).n;
    const id = run(c, 'INSERT INTO checkpoints(summary,start_conversation_id,end_conversation_id,session_group,no_content) VALUES(?,?,?,?,?)', noContent ? null : summary, start, end, group, noContent ? 1 : 0).lastInsertRowid;
    return get(c, 'SELECT * FROM checkpoints WHERE id=?', id);
  }
  function range(c, group) {
    const covered = coverage(c, group), safeEnd = frontier(c, group, covered), f = scope(group);
    const row = get(c, `SELECT count(*) AS count,MIN(id) AS firstConversationId,MAX(id) AS lastConversationId FROM conversations WHERE id>? AND id<=? AND ${loadable}${f.sql}`, covered, safeEnd, ...f.args);
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
  function recentDelivered(c, group, { afterTimestamp, limit } = {}) {
    const f = scope(group), l = limitClause(limit, true);
    if (afterTimestamp !== undefined && (typeof afterTimestamp !== 'string' || !Number.isFinite(Date.parse(afterTimestamp)))) {
      throw dataError('INVALID_ARGS', 'afterTimestamp must be a timestamp');
    }
    // C4 stores UTC text today. Imported history can also contain Unix seconds.
    const clock = "CASE WHEN typeof(timestamp) IN ('integer','real') THEN julianday(timestamp,'unixepoch') ELSE julianday(timestamp) END";
    const after = afterTimestamp === undefined ? [] : [afterTimestamp];
    const filter = `${loadable}${f.sql}${after.length ? ` AND ${clock}>julianday(?)` : ''}`;
    const rows = all(c, `SELECT * FROM conversations WHERE ${filter} ORDER BY ${clock} DESC, id DESC${l.sql}`,
      ...f.args, ...after, ...l.args).reverse();
    // An incomplete tail needs the count and ID bounds of the older rows,
    // without loading their bodies. Use the same snapshot and timestamp/ID order.
    const older = after.length && rows.length === limit
      ? get(c, `SELECT COUNT(*) AS count, MIN(id) AS firstId, MAX(id) AS lastId FROM conversations
        WHERE ${filter} AND (${clock}, id) < (SELECT ${clock}, id FROM conversations WHERE id=?)`,
      ...f.args, ...after, rows[0].id)
      : null;
    return { rows, older };
  }
  function pendingStartupReply(c, group, { since } = {}) {
    if (typeof since !== 'string' || !Number.isFinite(Date.parse(since))) {
      throw dataError('INVALID_ARGS', 'since must be a timestamp');
    }
    const f = scope(group);
    // Checkpoints and delivery status do not decide whether a human was answered.
    // Ignore Core notices before selecting the latest id at each channel/endpoint.
    return !!get(c, `SELECT 1 FROM conversations WHERE direction='in' AND id IN (
      SELECT MAX(id) FROM conversations
      WHERE julianday(timestamp)>=julianday(?)${f.sql}
        AND NOT (direction='out' AND COALESCE(delivery_action,'')='system_notice')
      GROUP BY channel,endpoint_id
    ) LIMIT 1`, since, ...f.args);
  }
  function unsummarized(c, group, { upToConversationId, limit, afterConversationId } = {}) {
    upper(c, group, upToConversationId);
    if (afterConversationId !== undefined && (!Number.isSafeInteger(afterConversationId) || afterConversationId < 0)) throw dataError('INVALID_ARGS', 'afterConversationId must be a nonnegative integer');
    const f = scope(group), l = limitClause(limit);
    return all(c, `SELECT * FROM conversations WHERE id>? AND id<=?${f.sql} AND ${loadable} ORDER BY id${l.sql}`, Math.max(coverage(c, group), afterConversationId ?? 0), upToConversationId, ...f.args, ...l.args);
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
    hasPendingStartupReply: (group, options) => {
      requireGroup(group, { global: true });
      return read(c => pendingStartupReply(c, group, options));
    },
    getRecentDeliveredConversations: (group, options) => {
      requireGroup(group, { global: true });
      return snapshot(c => recentDelivered(c, group, options));
    },
    getDeliveredSince: (group, after, options) => groupRead(group, c => tail(c, group, after, options)),
    getGlobalDeliveredSince: (after, options) => read(c => tail(c, '*', after, options)),
    getUnsummarizedRange: group => groupRead(group, range),
    getGlobalUnsummarizedRange: () => snapshot(c => range(c, '*')),
    getUnsummarizedConversations: (group, options) => groupRead(group, c => unsummarized(c, group, options)),
    getGlobalUnsummarizedConversations: options => snapshot(c => unsummarized(c, '*', options)),
    getDreamConversations: () => snapshot(c => all(c, 'SELECT session_group FROM group_heads ORDER BY session_group')
      .map(({ session_group: group }) => {
        const after = coverage(c, group);
        const upTo = frontier(c, group, after);
        return { group, rows: all(c, `SELECT * FROM conversations WHERE session_group=? AND id>? AND id<=? AND ${loadable} ORDER BY id`, group, after, upTo) };
      }).filter(({ rows }) => rows.length)),
    getContentCheckpointsSince: (group, afterEnd) => { requireGroup(group, { global: true }); return snapshot(c => all(c, 'SELECT * FROM checkpoints WHERE session_group=? AND end_conversation_id>? AND no_content=0 ORDER BY id', group, Math.max(afterEnd, group === '*' ? 0 : baseline(c)))); },
  };
  function unsummarizedQuery({ group = '*', upToConversationId, limit, afterConversationId } = {}) {
    requireGroup(group, { global: true });
    return snapshot(c => {
      const safeEnd = frontier(c, group), requested = upToConversationId ?? safeEnd;
      const rows = unsummarized(c, group, { upToConversationId: requested, limit, afterConversationId });
      const latest = get(c, `SELECT end_conversation_id,summary FROM checkpoints WHERE session_group=? AND no_content=0${group === '*' ? '' : ' AND end_conversation_id>?'} ORDER BY id DESC LIMIT 1`, group, ...(group === '*' ? [] : [baseline(c)]));
      const f = scope(group);
      const more = rows.length && get(c, `SELECT 1 FROM conversations WHERE id>? AND id<=?${f.sql} AND ${loadable} LIMIT 1`, rows.at(-1).id, requested, ...f.args);
      return { rows, checkpointEnd: latest?.end_conversation_id ?? 0, checkpointSummary: latest?.summary ?? null, safeEnd, upTo: more ? rows.at(-1).id : requested };
    });
  }
  return { api, coverage, frontier, checkpoint, unsummarizedQuery };
}
