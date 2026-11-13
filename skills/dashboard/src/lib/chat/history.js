import { markdownPreview } from './markdown-preview.js';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseC4Content } from '../../../../comm-bridge/scripts/c4-content-schema.js';
import { splitContentAndAttachments, sanitizeDisplayName } from '../../../../comm-bridge/scripts/attachment-annotations.js';
import { answerDisplay } from '../../../public/js/wb/chat-answer.js';
import { parseChatQuote, stripChatQuote } from '../../../../comm-bridge/scripts/chat-quote.js';
import { ORIGIN, ORIGIN_CONVERSATION_ID, ORIGIN_DISPLAY_NAME } from './origin.js';

const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const shown = (groups, channels) => `c.direction IN ('in','out') AND c.session_group NOT IN (${groups})
  AND c.channel <> '' AND c.channel NOT IN (${channels})`;
// Lists and summaries never include internal messages; message pages do.
// The `origin` group is shown only through the Origin conversation's range.
const visible = shown("'origin','*'", "'void','internal','system','scheduler','control'");
const messageVisible = shown("'origin','*'", "'void','system','scheduler','control'");
const originVisible = shown("'*'", "'void','internal','system','scheduler','control'");
const originMessageVisible = shown("'*'", "'void','system','scheduler','control'");
const visibleIn = (range, messages = false) => range?.origin
  ? messages ? originMessageVisible : originVisible
  : messages ? messageVisible : visible;
// The Origin conversation: the fixed address `dashboard origin`, recorded in group `origin`.
const originWhere = "c.session_group=@group AND c.channel='dashboard' AND c.endpoint_id='origin'";
const identity = `CASE WHEN c.session_group = '' THEN 'l:' || hex(c.channel) || ':' || hex(c.endpoint_id)
  ELSE 'g:' || hex(c.session_group) END`;

const previewLabels = locale => locale === 'en'
  ? { image: '[Image]', file: '[File]', chart: '[Chart]', component: '[Component]', media: '[Media] Original-channel attachment', invalid: 'Unable to display message' }
  : { image: '[图片]', file: '[文件]', chart: '[图表]', component: '[组件]', media: '[媒体] 原渠道附件', invalid: '无法显示的消息' };
const readableAttachment = (attachment, locale = 'zh', quote = false) => quote
  ? `（附件：${sanitizeDisplayName(attachment.name)}）`
  : `${previewLabels(locale)[attachment.kind === 'image' ? 'image' : 'file']} ${sanitizeDisplayName(attachment.name)}`;

/**
 * Browser summaries of valid content contain attachment names, never
 * storage/model references. An invalid message's qualified whole-message
 * fallbackText is shown as written, so it may contain attachment IDs the
 * agent put there; IDs are not credentials and cannot fetch an attachment.
 */
export function chatAttachmentPreview(content, { external = false, locale = 'zh' } = {}) {
  return attachmentPreview(content, { external, locale });
}

function attachmentPreview(content, { external = false, locale = 'zh', quote = false } = {}, format = null) {
  const parsed = parseC4Content(content);
  const labels = previewLabels(locale);
  const body = (text, literal = false) => {
    if (!format || literal) return external ? text.replace(/^\[MEDIA:[^\r\n]*$/gm, labels.media) : text;
    if (!external) return format(text);
    // Channel media notices, like attachment names, are plain text outside Markdown.
    return text.split(/(^\[MEDIA:[^\r\n]*$)/gm)
      .map(part => /^\[MEDIA:[^\r\n]*$/.test(part) ? labels.media : format(part))
      .filter(Boolean).join('\n');
  };
  if (parsed.kind === 'invalid') return body(parsed.fallbackText ?? labels.invalid, true);
  if (parsed.kind === 'envelope') {
    if (parsed.envelope.kind === 'answer') {
      const display = answerDisplay(parsed.envelope);
      return body(display.answer, display.matchedPrefix);
    }
    const blocks = parsed.envelope.blocks ?? [];
    if (!blocks.some(block => block.type !== 'markdown')) {
      return body(parsed.envelope.fallbackText);
    }
    return blocks.map(block => ['x-zylos.image', 'x-zylos.file'].includes(block.type)
      ? readableAttachment({ kind: block.type === 'x-zylos.image' ? 'image' : 'file', name: block.data.nameSnapshot }, locale, quote)
      : block.type === 'markdown' ? body(block.fallbackText ?? block.data.text)
        : ['time_series', 'breakdown', 'category_series'].includes(block.type) ? labels.chart : labels.component).filter(Boolean).join('\n');
  }
  const split = splitContentAndAttachments(content);
  if (!split.attachments.length) {
    return body(content);
  }
  return [body(split.content), ...split.attachments.map(attachment => readableAttachment(attachment, locale, quote))].filter(Boolean).join('\n');
}

/** The same bounded human summary is used by lists and incremental message reads. */
export function conversationPreview(content, options = {}) {
  return Array.from(attachmentPreview(content, options, text => markdownPreview(text, options))).slice(0, 160).join('');
}

/** One quote projection for the history API and Core's text history reader. */
export function quotePreview(row, { singleLine = false, ...options } = {}) {
  const content = stripChatQuote(row.channel === 'internal' ? internalContent(row) : row.content);
  const preview = conversationPreview(content, { ...options, quote: singleLine });
  return singleLine ? preview.replace(/\s+/g, ' ') : preview;
}

function rowQuote(row) {
  if (row?.channel !== 'dashboard' || row.direction !== 'in') return null;
  const quote = parseChatQuote(row.content);
  return quote && quote.id < row.id ? quote : null;
}

const previewContent = row => rowQuote(row)?.content ?? row?.content ?? '';

function internalContent(row) {
  const prefixes = [
    `[internal] Yourself, from your "${row.endpoint_id}" session group, said: `,
    `[internal] ${row.endpoint_id} said: `,
  ];
  const prefix = row.direction === 'in' && prefixes.find(value => row.content.startsWith(value));
  return prefix ? row.content.slice(prefix.length) : row.content;
}

export function deliveryState(row) {
  if (row.direction === 'out') return row.status === 'delivered' ? 'stored' : 'pending_reconciliation';
  if (['pending', 'running', 'delivered', 'switch_absorbed'].includes(row.status)) return row.status;
  if (row.status === 'failed') return ['auth_rejected', 'suppressed'].includes(row.delivery_action) ? row.delivery_action : 'failed';
  return 'pending_reconciliation';
}

export class ChatHistory {
  constructor({ c4Reader, conversations = null, attachments = null }) {
    this.c4Reader = c4Reader;
    this.conversations = conversations;
    this.attachments = attachments;
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

  list({ tab = 'mine', limit, cursor, locale = 'zh' } = {}) {
    this._tab(tab);
    limit = this._limit(limit);
    const scope = `list:${tab}`;
    const position = this._cursor(cursor, scope);
    // The Origin conversation is pinned first on the first page of "mine",
    // with or without messages, outside the activity order. It takes one of
    // the page's slots; later pages continue the ordinary conversations.
    const pinned = tab === 'mine' && !position;
    limit = pinned ? limit - 1 : limit;
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
      const latest = this._query(`SELECT c.id, c.content, c.direction, c.channel FROM conversations c INDEXED BY ${index}
        WHERE ${visible} AND ${where}
        ORDER BY COALESCE(julianday(c.timestamp), 0) DESC, c.id DESC LIMIT 1`, parameters)[0];
      const registered = tab === 'mine' ? this.conversations?.findByGroup(row.session_group) : null;
      // A stored group display name wins in both tabs; without one, an external
      // conversation keeps its session group name and legacy rows stay unnamed history.
      const name = row.session_group === '' ? null : this.conversations?.store.getGroupDisplayName(row.session_group)?.display_name;
      return { ...row, previewDirection: latest?.direction ?? null, preview: conversationPreview(previewContent(latest), { external: tab === 'external', locale }),
        display_name: registered ? name ?? registered.displayName : name ?? (row.session_group === '' ? '旧历史' : tab === 'mine'
          ? row.session_group.slice(row.session_group.indexOf(':') + 1) : row.session_group),
        ...(registered ? { localId: registered.localId } : {}), draft: false };
    });
    const last = items.at(-1);
    if (pinned) items.unshift(this._originItem(locale));
    // A one-item first page holds only Origin; the next page starts at the beginning.
    const next = last ? { stamp: last.stamp, id: last.id } : { stamp: null, id: '' };
    return { items, nextCursor: more ? this._token({ scope, ...next }) : null };
  }

  _originItem(locale) {
    const parameters = { group: ORIGIN };
    const summary = this._query(`SELECT COALESCE(MAX(julianday(c.timestamp)), 0) AS stamp, COUNT(*) AS count
      FROM conversations c INDEXED BY idx_conv_group_id WHERE ${originVisible} AND ${originWhere} LIMIT 1`, parameters)[0];
    const latest = this._query(`SELECT c.id, c.content, c.direction, c.channel FROM conversations c INDEXED BY idx_conv_group_id
      WHERE ${originVisible} AND ${originWhere}
      ORDER BY COALESCE(julianday(c.timestamp), 0) DESC, c.id DESC LIMIT 1`, parameters)[0];
    return { id: ORIGIN_CONVERSATION_ID, session_group: ORIGIN, channel: 'dashboard', endpoint_id: ORIGIN,
      stamp: summary?.stamp ?? 0, count: summary?.count ?? 0, previewDirection: latest?.direction ?? null,
      preview: latest ? conversationPreview(previewContent(latest), { locale }) : '',
      display_name: ORIGIN_DISPLAY_NAME, localId: ORIGIN, origin: true, draft: false };
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
    if (tab === 'mine' && id === ORIGIN_CONVERSATION_ID) {
      return { where: originWhere, parameters: { group: ORIGIN }, origin: true };
    }
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
    // The Origin conversation exists without messages; it is empty, not missing.
    if (range.origin) return range;
    const row = this._query(`SELECT c.id FROM conversations c WHERE ${visible} AND ${range.where} LIMIT 1`, range.parameters)[0];
    if (!row) throw fail('chat_conversation_not_found', 404);
    return range;
  }

  _messageRange(tab, id, range = this._conversation(tab, id)) {
    if (!range.parameters.group) return range;
    return { ...range, where: `(${range.where} OR (c.session_group=@group AND c.channel='internal'))` };
  }

  _internalPeer(group) {
    const own = this._scope('mine', 'c.session_group=@group', { group });
    const external = this._scope('external', 'c.session_group=@group', { group });
    const row = this._query(`SELECT c.channel FROM conversations c
      WHERE ${visible} AND ((${own.where}) OR (${external.where}))
      ORDER BY c.id DESC LIMIT 1`, { group })[0];
    const registered = this.conversations?.findByGroup(group);
    return {
      peerSessionGroup: group,
      peerDisplayName: this.conversations?.store.getGroupDisplayName(group)?.display_name ?? registered?.displayName ?? group,
      peerExists: !!row,
      peerChannel: row?.channel ?? null,
    };
  }

  messages(id, { tab = 'mine', limit, cursor, direction = 'before', recheckIds, locale = 'zh' } = {}) {
    limit = this._limit(limit);
    if (!['before', 'after'].includes(direction)) throw fail('invalid_chat_direction');
    if (direction === 'after' && cursor == null) throw fail('invalid_chat_cursor');
    const range = this._messageRange(tab, id);
    const recheck = recheckIds === undefined ? [] : this._messageIds(recheckIds);
    const position = this._cursor(cursor, `messages:${tab}:${id}:${direction}`);
    const rows = this._query(`SELECT c.id, c.timestamp, c.direction, c.channel,
      c.endpoint_id, c.session_group, c.content, c.status, c.delivery_action FROM conversations c
      WHERE ${visibleIn(range, true)} AND ${range.where} AND (@position IS NULL OR c.id ${direction === 'before' ? '<' : '>'} @position)
      ORDER BY c.id ${direction === 'before' ? 'DESC' : 'ASC'} LIMIT @limit`, {
      ...range.parameters, position: position?.id ?? null, limit: limit + 1,
    });
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const next = page.at(-1)?.id;
    const rechecked = recheck.length ? this._rowsByIds(range, recheck,
      'c.id,c.direction,c.channel,c.endpoint_id,c.session_group,c.content', visibleIn(range, true)) : [];
    const batch = [...new Map([...page, ...rechecked].map(row => [row.id, row])).values()];
    const quoteIds = [...new Set(page.map(row => rowQuote(row)?.id).filter(Boolean))];
    const quoted = new Map((quoteIds.length ? this._rowsByIds(range, quoteIds,
      'c.id,c.direction,c.timestamp,c.channel,c.endpoint_id,c.content', visibleIn(range, true), false) : [])
      .map(row => [row.id, row]));
    const metadata = new Map();
    if (tab === 'mine' && this.attachments) {
      const externalRows = batch.filter(row => row.channel !== 'internal');
      for (let offset = 0; offset < externalRows.length; offset += 100) {
        for (const [rowId, values] of this.attachments.metadata(externalRows.slice(offset, offset + 100))) {
          metadata.set(rowId, values);
        }
      }
    }
    const rowAttachments = row => row.channel === 'internal' ? [] : tab === 'external'
      ? splitContentAndAttachments(row.content).attachments.map(attachment => ({
        name: attachment.name, kind: attachment.kind, sizeLabel: attachment.sizeLabel,
        available: false, external: true,
      })) : metadata.get(row.id) ?? [];
    const peers = new Map();
    const items = (direction === 'before' ? page.reverse() : page).map(row => {
      const marker = rowQuote(row);
      if (marker) {
        const target = quoted.get(marker.id);
        row = { ...row, quote: { id: marker.id, direction: target?.direction ?? null,
          internal: target?.channel === 'internal',
          timestamp: target?.timestamp ?? null, preview: target ? quotePreview(target, { external: tab === 'external', locale }) : '', available: !!target } };
      }
      if (row.channel === 'internal') {
        if (!peers.has(row.endpoint_id)) peers.set(row.endpoint_id, this._internalPeer(row.endpoint_id));
        return { ...row, internal: { ...peers.get(row.endpoint_id), content: internalContent(row) }, attachments: [] };
      }
      return { ...row, deliveryState: deliveryState(row),
        preview: conversationPreview(previewContent(row), { external: tab === 'external', locale }), attachments: rowAttachments(row) };
    });
    const newest = items.at(-1)?.id ?? position?.id ?? 0;
    return { items, nextCursor: more ? this._token({ scope: `messages:${tab}:${id}:${direction}`, id: next }) : null,
      afterCursor: this._token({ scope: `messages:${tab}:${id}:after`, id: newest }),
      ...(recheckIds !== undefined ? { attachmentUpdates: rechecked.map(row => ({ id: row.id, attachments: rowAttachments(row) })) } : {}) };
  }

  _messageIds(ids) {
    const values = typeof ids === 'string' ? ids.split(',') : ids;
    if (!Array.isArray(values) || !values.length || values.length > 100 || values.some(value => !/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(Number(value)))) {
      throw fail('invalid_chat_message_ids');
    }
    const unique = [...new Set(values.map(Number))];
    if (unique.length !== values.length) throw fail('invalid_chat_message_ids');
    return unique;
  }

  _rowsByIds(range, unique, columns, visibility = visibleIn(range), strict = true) {
    const parameters = { ...range.parameters, limit: unique.length };
    unique.forEach((value, index) => { parameters[`id${index}`] = value; });
    const rows = this._query(`SELECT ${columns} FROM conversations c
      WHERE ${visibility} AND ${range.where} AND c.id IN (${unique.map((_, index) => `@id${index}`).join(',')}) LIMIT @limit`, parameters);
    if (strict && rows.length !== unique.length) throw fail('chat_message_not_found', 404);
    return rows;
  }

  /** Metadata-only invalidation baseline; no previews, body or attachments. */
  chatChangeSnapshot({ tab = 'mine', conversationId = null } = {}, { afterId = null } = {}) {
    this._tab(tab);
    if (afterId !== null && (!Number.isSafeInteger(afterId) || afterId < 0)) throw fail('invalid_chat_cursor');
    return this._db().transaction(() => {
      const range = conversationId ? this._conversation(tab, conversationId) : null;
      // Core inserts allocate AUTOINCREMENT IDs. A primary-key frontier avoids
      // rescanning old conversations, including excluded-channel traffic.
      const highwater = this._query('SELECT COALESCE(MAX(id),0) AS id FROM conversations', {})[0].id;
      if (afterId !== null && afterId > highwater) throw fail('chat_history_unavailable', 502);
      const listScope = this._scope(tab, '1=1', {});
      // "Mine" also changes with the pinned Origin conversation.
      const listed = tab === 'mine' ? `((${visible} AND ${listScope.where}) OR (${originVisible} AND ${originWhere}))`
        : `${visible} AND ${listScope.where}`;
      const inserted = this._query(`SELECT c.id FROM conversations c NOT INDEXED
        WHERE c.id>@afterId AND c.id<=@highwater AND ${listed}
        ORDER BY c.id LIMIT 1`, { afterId: afterId ?? highwater, highwater, group: ORIGIN });
      let latestId = null, delivery = [];
      if (range) {
        const messages = this._messageRange(tab, conversationId, range);
        latestId = this._query(`SELECT c.id FROM conversations c
          WHERE ${visibleIn(range, true)} AND ${messages.where} ORDER BY c.id DESC LIMIT 1`, messages.parameters)[0]?.id ?? null;
        if (tab === 'mine') {
          // Each fixed-status seek returns at most 100 rows from the existing
          // group/direction/status index, then keep the newest 100 overall.
          // A row leaving this set also invalidates delivery truth when it
          // reaches a terminal state, without retaining terminal history.
          const pending = ['pending', 'running'].flatMap(status => this._query(`SELECT c.id,c.direction,c.status,c.delivery_action
            FROM conversations c INDEXED BY idx_conv_group_status
            WHERE ${visibleIn(range)} AND ${range.where} AND c.direction='in' AND c.status=@status
            ORDER BY c.id DESC LIMIT 100`, { ...range.parameters, status }));
          delivery = pending.sort((a, b) => b.id - a.id).slice(0, 100).reverse();
        }
      }
      return { highwater, listChanged: inserted.length > 0, latestId, delivery };
    })();
  }

  status(id, { tab = 'mine', ids } = {}) {
    const range = this._conversation(tab, id);
    const rows = this._rowsByIds(range, this._messageIds(ids), 'c.id,c.direction,c.status,c.delivery_action');
    return { items: rows.map(row => ({ ...row, deliveryState: deliveryState(row) })) };
  }
}
