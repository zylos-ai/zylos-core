import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { projectC4Content } from '../../../../comm-bridge/scripts/c4-content-projection.js';

const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const visible = `c.direction IN ('in','out') AND c.session_group NOT IN ('origin','*')
  AND c.channel <> '' AND c.channel NOT IN ('void','internal','system','scheduler','control')`;
const identity = `CASE WHEN c.session_group = '' THEN 'l:' || hex(c.channel) || ':' || hex(c.endpoint_id)
  ELSE 'g:' || hex(c.session_group) END`;

export function deliveryState(row) {
  if (row.direction === 'out') return row.status === 'delivered' ? 'stored' : 'pending_reconciliation';
  if (['pending', 'running', 'delivered', 'switch_absorbed'].includes(row.status)) return row.status;
  if (row.status === 'failed') return ['auth_rejected', 'suppressed'].includes(row.delivery_action) ? row.delivery_action : 'failed';
  return 'pending_reconciliation';
}

export class ChatHistory {
  constructor({ c4Reader, conversations = null }) {
    this.c4Reader = c4Reader;
    this.conversations = conversations;
    this.secret = randomBytes(32);
  }

  _db() {
    const db = this.c4Reader._open();
    if (!db) throw fail('chat_history_unavailable', 502);
    db.pragma('query_only = ON');
    return db;
  }

  _query(sql, parameters) {
    try { return this._db().prepare(sql).all(parameters); }
    catch { throw fail('chat_history_unavailable', 502); }
  }

  _limit(value) {
    if (value === undefined || value === null) return 50;
    if (!/^[1-9][0-9]*$/.test(String(value)) || Number(value) > 100) throw fail('invalid_chat_limit');
    return Number(value);
  }

  _token(value) {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return body + '.' + createHmac('sha256', this.secret).update(body).digest('base64url');
  }

  _cursor(token, scope) {
    if (token == null) return null;
    try {
      if (typeof token !== 'string') throw Error();
      const [body, signature, extra] = token.split('.');
      const actual = Buffer.from(signature || '', 'base64url');
      const expected = createHmac('sha256', this.secret).update(body).digest();
      if (extra !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
      const result = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (result.scope !== scope) throw Error();
      return result;
    } catch { throw fail('invalid_chat_cursor'); }
  }

  _tab(tab) {
    if (!['mine', 'external'].includes(tab)) throw fail('invalid_chat_tab');
    return tab;
  }

  _source(tab) {
    const own = `c.channel = 'dashboard' AND EXISTS (
      SELECT 1 FROM channel_namespaces n WHERE n.component_name = 'dashboard'
      AND c.session_group = n.namespace || ':' || c.endpoint_id)`;
    return `WITH allowed AS (
      SELECT c.*, ${identity} AS identity FROM conversations c
      WHERE ${visible} AND ${tab === 'mine' ? own : "c.channel <> 'dashboard'"}
    )`;
  }

  list({ tab = 'mine', limit, cursor } = {}) {
    this._tab(tab);
    limit = this._limit(limit);
    const scope = `list:${tab}`;
    const position = this._cursor(cursor, scope);
    let rows = this._query(`${this._source(tab)}, summaries AS (
      SELECT identity AS id, session_group, channel, endpoint_id,
        COALESCE(MAX(julianday(timestamp)), 0) AS stamp, COUNT(*) AS count
      FROM allowed GROUP BY identity
    ) SELECT * FROM summaries
      WHERE (@stamp IS NULL OR stamp < @stamp OR (stamp = @stamp AND id COLLATE BINARY > @id))
      ORDER BY stamp DESC, id COLLATE BINARY LIMIT @limit`, {
      stamp: position?.stamp ?? null, id: position?.id ?? '', limit: limit + 1,
    });
    if (tab === 'mine' && this.conversations) {
      rows = [...rows, ...this._drafts(limit + 1, position)]
        .sort((a, b) => b.stamp - a.stamp || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
    }
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map(row => {
      if (row.draft) return row;
      const { where, parameters } = this._scope(tab, row.session_group === ''
        ? "c.session_group='' AND c.channel=@channel AND c.endpoint_id=@endpoint"
        : 'c.session_group=@group', row.session_group === ''
        ? { channel: row.channel, endpoint: row.endpoint_id } : { group: row.session_group });
      const index = row.session_group === '' ? 'idx_conv_channel_endpoint' : 'idx_conv_group_id';
      const latest = this._query(`SELECT c.id, c.content FROM conversations c INDEXED BY ${index}
        WHERE ${visible} AND ${where}
        ORDER BY COALESCE(julianday(c.timestamp), 0) DESC, c.id DESC LIMIT 1`, parameters)[0];
      const registered = tab === 'mine' ? this.conversations?.findByGroup(row.session_group) : null;
      const name = tab === 'mine' ? this.conversations?.store.getGroupDisplayName(row.session_group)?.display_name : null;
      return { ...row, preview: projectC4Content(latest?.content ?? '', { c4Id: latest?.id }).slice(0, 160),
        display_name: name ?? registered?.displayName ?? (row.session_group === '' ? '旧历史' : tab === 'mine'
          ? row.session_group.slice(row.session_group.indexOf(':') + 1) : row.session_group),
        ...(registered ? { localId: registered.localId } : {}), draft: false };
    });
    const last = items.at(-1);
    return { items, nextCursor: more ? this._token({ scope, stamp: last.stamp, id: last.id }) : null };
  }

  _drafts(limit, position) {
    const drafts = [];
    let next = position;
    // Each source read is limited, including when stale unknown registrations
    // already have a Core head. Keep only one result page and one source batch.
    while (drafts.length < limit) {
      const batch = this.conversations.listDrafts({ limit, position: next });
      if (!batch.length) break;
      for (const row of batch) {
        const group = row.namespace ? `${row.namespace}:${row.local_id}` : null;
        const established = group && this._query(`SELECT h.session_group FROM group_heads h
          JOIN channel_namespaces n ON n.namespace=@namespace AND n.component_name='dashboard'
          WHERE h.session_group=@group LIMIT 1`, { namespace: row.namespace, group })[0];
        if (established) continue;
        drafts.push({ id: row.id, localId: row.local_id, session_group: group ?? '',
          channel: 'dashboard', endpoint_id: row.local_id, stamp: row.stamp, count: 0,
          preview: '', display_name: row.display_name, draft: true, state: row.state });
        if (drafts.length === limit) break;
      }
      if (batch.length < limit) break;
      const last = batch.at(-1);
      next = { stamp: last.stamp, id: last.id };
    }
    return drafts;
  }

  _range(tab, id) {
    this._tab(tab);
    if (typeof id !== 'string') throw fail('invalid_chat_conversation');
    const decode = value => {
      if (!/^(?:[0-9A-F]{2})+$/.test(value)) throw fail('invalid_chat_conversation');
      const text = Buffer.from(value, 'hex').toString('utf8');
      if (Buffer.from(text).toString('hex').toUpperCase() !== value) throw fail('invalid_chat_conversation');
      return text;
    };
    let where, parameters;
    if (id.startsWith('g:')) {
      parameters = { group: decode(id.slice(2)) };
      where = 'c.session_group=@group';
    } else if (/^l:[0-9A-F]+:[0-9A-F]*$/.test(id)) {
      const [, channel, endpoint] = id.split(':');
      parameters = { channel: decode(channel), endpoint: endpoint ? decode(endpoint) : '' };
      where = "c.session_group='' AND c.channel=@channel AND c.endpoint_id=@endpoint";
    } else throw fail('invalid_chat_conversation');
    return this._scope(tab, where, parameters);
  }

  _scope(tab, where, parameters) {
    where += tab === 'mine' ? ` AND c.channel='dashboard' AND EXISTS (
      SELECT 1 FROM channel_namespaces n WHERE n.component_name='dashboard'
      AND c.session_group=n.namespace || ':' || c.endpoint_id)` : " AND c.channel<>'dashboard'";
    return { where, parameters };
  }

  _conversation(tab, id) {
    const range = this._range(tab, id);
    const row = this._query(`SELECT c.id FROM conversations c WHERE ${visible} AND ${range.where} LIMIT 1`, range.parameters)[0];
    if (!row) throw fail('chat_conversation_not_found', 404);
    return range;
  }

  messages(id, { tab = 'mine', limit, cursor, direction = 'before' } = {}) {
    limit = this._limit(limit);
    if (!['before', 'after'].includes(direction)) throw fail('invalid_chat_direction');
    if (direction === 'after' && cursor == null) throw fail('invalid_chat_cursor');
    const range = this._conversation(tab, id);
    const position = this._cursor(cursor, `messages:${tab}:${id}:${direction}`);
    const rows = this._query(`SELECT c.id, c.timestamp, c.direction, c.channel,
      c.endpoint_id, c.session_group, c.content, c.status, c.delivery_action FROM conversations c
      WHERE ${visible} AND ${range.where} AND (@position IS NULL OR c.id ${direction === 'before' ? '<' : '>'} @position)
      ORDER BY c.id ${direction === 'before' ? 'DESC' : 'ASC'} LIMIT @limit`, {
      ...range.parameters, position: position?.id ?? null, limit: limit + 1,
    });
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const next = page.at(-1)?.id;
    const items = (direction === 'before' ? page.reverse() : page).map(row => ({ ...row, deliveryState: deliveryState(row) }));
    const newest = items.at(-1)?.id ?? position?.id ?? 0;
    return { items, nextCursor: more ? this._token({ scope: `messages:${tab}:${id}:${direction}`, id: next }) : null,
      afterCursor: this._token({ scope: `messages:${tab}:${id}:after`, id: newest }) };
  }

  status(id, { tab = 'mine', ids } = {}) {
    const range = this._conversation(tab, id);
    const values = typeof ids === 'string' ? ids.split(',') : ids;
    if (!Array.isArray(values) || !values.length || values.length > 100 || values.some(value => !/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(Number(value)))) {
      throw fail('invalid_chat_message_ids');
    }
    const unique = [...new Set(values.map(Number))];
    if (unique.length !== values.length) throw fail('invalid_chat_message_ids');
    const parameters = { ...range.parameters, limit: unique.length };
    unique.forEach((value, index) => { parameters[`id${index}`] = value; });
    const rows = this._query(`SELECT c.id, c.direction, c.status, c.delivery_action FROM conversations c
      WHERE ${visible} AND ${range.where} AND c.id IN (${unique.map((_, index) => `@id${index}`).join(',')}) LIMIT @limit`, parameters);
    if (rows.length !== unique.length) throw fail('chat_message_not_found', 404);
    return { items: rows.map(row => ({ ...row, deliveryState: deliveryState(row) })) };
  }
}
