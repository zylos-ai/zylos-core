import { markdownPreview } from './markdown-preview.js';
import { createHash } from 'node:crypto';
import { parseC4Content } from '../../../../comm-bridge/scripts/c4-content-schema.js';
import { splitContentAndAttachments, sanitizeDisplayName } from '../../../../comm-bridge/scripts/attachment-annotations.js';
import { answerDisplay } from '../../../public/js/wb/chat-answer.js';
import { dashboardConversationId, dashboardConversationIdSql } from '../../../../comm-bridge/scripts/dashboard-endpoint.js';
import { dashboardReplyQuotes } from '../../../../comm-bridge/scripts/dashboard-reply-quotes.js';
import { parseChatQuote, stripChatQuote } from '../../../../comm-bridge/scripts/chat-quote.js';
import { ORIGIN, ORIGIN_CONVERSATION_ID, ORIGIN_DISPLAY_NAME } from './origin.js';
import { groupId } from './conversations.js';
import { listFailure, parseListQuery } from '../list-query.js';
import { prepareLatestReceived, receivedMessage } from '../c4-reader.js';
import { isoTimestamp } from '../wire-time.js';
import { messageVisible, originMessageVisible, originVisible, visible } from './visibility.js';

const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const visibleIn = (range, messages = false) => range?.origin
  ? messages ? originMessageVisible : originVisible
  : messages ? messageVisible : visible;
// The Origin conversation shows every row recorded under group `origin`: its
// own address `dashboard origin`, and in single mode every conversation and
// external chat, whose rows are recorded under `origin` at delivery.
const originWhere = 'c.session_group=@group';
const tabs = ['mine', 'external'];
const UNREAD_COUNT_LIMIT = 100;
// A long legacy conversation ID still produces a bounded cursor scope.
export const chatCollection = (id, kind) => kind ? `conversations:${kind}:${createHash('sha256').update(id).digest('base64url')}` : 'conversations';

export function chatQuery(tabParams, collection, options) {
  const params = new URLSearchParams(tabParams);
  if (!params.has('tab')) params.set('tab', 'mine');
  return parseListQuery(collection, params, { ...options, filters: { tab: tabs } });
}

function tabGroupScope(tab, group = 'c.session_group') {
  const dashboard = `EXISTS (SELECT 1 FROM channel_namespaces n WHERE n.component_name='dashboard'
    AND substr(${group}, 1, length(n.namespace)+1)=n.namespace || ':')`;
  return tab === 'mine' ? dashboard : `NOT ${dashboard}`;
}

// Timeline rows still use their established channel and endpoint checks.
const listScope = tab => tab === 'mine'
  ? `c.channel='dashboard' AND EXISTS (
    SELECT 1 FROM channel_namespaces n WHERE n.component_name='dashboard'
    AND c.session_group=n.namespace || ':' || ${dashboardConversationIdSql('c.endpoint_id')})`
  : "c.channel<>'dashboard'";

const grouped = "c.session_group NOT IN ('', 'origin', '*')";
const compareRows = (a, b) => b.stamp - a.stamp || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
const matchesSearch = (row, search) => [row.display_name, row.session_group]
  .some(value => typeof value === 'string' && value.toLowerCase().includes(search));
const groupIndex = 'conversations c INDEXED BY idx_conv_group_id';

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

  _tab(tab) {
    if (!['mine', 'external'].includes(tab)) throw fail('invalid_chat_tab');
    return tab;
  }

  pinIds(tab = 'mine') {
    this._tab(tab);
    return this.conversations?.db.prepare('SELECT conversation_id FROM chat_pins WHERE tab=? ORDER BY position').pluck().all(tab) ?? [];
  }

  replacePins(ids, tab = 'mine') {
    this._tab(tab);
    if (!Array.isArray(ids)) throw fail('invalid_chat_parameters');
    if (ids.some(id => typeof id !== 'string' || !id.startsWith('g:') || id === ORIGIN_CONVERSATION_ID)
        || new Set(ids).size !== ids.length) throw fail('invalid_chat_pin');
    const db = this.conversations.db;
    return db.transaction(() => {
      for (const id of ids) {
        const { where, parameters } = this._range(tab, id);
        // The committed fence remains visible until Core finishes deletion.
        // Check it together with existence while holding the Dashboard writer lock.
        const eligible = this._query(`SELECT 1 FROM ${groupIndex} WHERE ${grouped} AND ${tabGroupScope(tab)} AND ${visible} AND ${where}
          AND NOT EXISTS (SELECT 1 FROM drain_fences f WHERE f.session_group=c.session_group AND f.reason='delete')
          LIMIT 1`, parameters)[0];
        if (!eligible) throw fail('invalid_chat_pin');
      }
      db.prepare('DELETE FROM chat_pins WHERE tab=?').run(tab);
      const insert = db.prepare('INSERT INTO chat_pins(tab, conversation_id, position) VALUES (?, ?, ?)');
      ids.forEach((id, position) => insert.run(tab, id, position));
      return ids;
    }).immediate();
  }

  mineSummary(locale = 'zh') {
    return this.list({ locale, summaryOnly: true }).summary;
  }

  list({ tab = 'mine', limit, cursor, q, locale = 'zh', page, includeSummary = false, summaryOnly = false } = {}) {
    if (!page) {
      const parameters = new URLSearchParams({ tab });
      for (const [key, value] of Object.entries({ limit, cursor, q })) {
        if (value != null) parameters.set(key, value);
      }
      page = chatQuery(parameters, 'conversations', { q: true });
    }
    tab = page.filters.tab;
    const search = page.q?.toLowerCase();
    const unnamed = locale === 'en' ? 'Untitled conversation' : '未命名对话';
    const after = page.after && { stamp: page.after[0], id: page.after[1] };
    const pins = summaryOnly ? [] : this.pinIds(tab);
    const pinOrders = new Map(pins.map((id, index) => [id, index]));
    try {
      const db = this._db();
      return db.transaction(() => {
        const latestReceived = !summaryOnly && prepareLatestReceived(db);
        const stamp = db.prepare('SELECT COALESCE(julianday(?), 0)').pluck();
        const nextGroup = db.prepare(`SELECT c.session_group FROM ${groupIndex}
          WHERE c.session_group>? ORDER BY c.session_group LIMIT 1`).pluck();
        const memberOfTab = `c.session_group=? AND ${visible} AND ${listScope(tab)}`;
        const member = db.prepare(`SELECT c.channel, c.endpoint_id, c.id, c.timestamp FROM ${groupIndex}
          WHERE ${memberOfTab} ORDER BY c.id DESC LIMIT 1`);
        const first = db.prepare(`SELECT c.timestamp FROM ${groupIndex} WHERE ${memberOfTab} ORDER BY c.id LIMIT 1`);
        const belongsToTab = db.prepare(`SELECT ${tabGroupScope(tab, '@group')}`).pluck();
        const latest = db.prepare(`SELECT c.id,c.content,c.direction,c.channel FROM ${groupIndex}
          WHERE ${memberOfTab} ORDER BY c.id DESC LIMIT 1`);
        const originLatest = tab === 'mine' && db.prepare(`SELECT c.id,c.content,c.direction,c.channel FROM ${groupIndex}
          WHERE c.session_group=? AND ${originVisible} ORDER BY c.id DESC LIMIT 1`);
        const originHead = tab === 'mine' && (includeSummary || summaryOnly) && db.prepare(`SELECT c.id,c.timestamp FROM ${groupIndex}
          WHERE c.session_group=? AND ${originVisible} ORDER BY c.id DESC LIMIT 1`);
        const originFirst = tab === 'mine' && db.prepare(`SELECT c.timestamp FROM ${groupIndex}
          WHERE c.session_group=? AND ${originVisible} ORDER BY c.id LIMIT 1`);
        const rows = [], pinned = [];
        const summary = tab === 'mine' && (includeSummary || summaryOnly)
          ? { latest: null, unread_conversations: 0 } : null;
        let newest = null;
        const readMessage = row => (row.origin ? originLatest : latest).get(row.session_group);
        const unreadRange = row => this._messageRange(tab, row.id, this._range(tab, row.id));
        const preview = (row, message) => conversationPreview(previewContent(message), {
          external: tab === 'external' || row.origin && message?.channel !== 'dashboard', locale,
        });

        const append = (row, head) => {
          if (summary) {
            summary.unread_conversations += Number(this.hasUnread(row.id, unreadRange(row)));
            const at = isoTimestamp(head?.timestamp);
            if (at && (!newest || at > newest.at || at === newest.at && head.id > newest.id)) {
              newest = { row, id: head.id, at };
            }
            if (summaryOnly) return;
          }
          if (search && !matchesSearch({ ...row, display_name: row.display_name ?? unnamed }, search)) return;
          const isPinned = pinOrders.has(row.id);
          if (isPinned) row.pinOrder = pinOrders.get(row.id);
          if (!search && (isPinned || row.origin)) {
            if (!after) pinned.push(row);
          } else if (!after || compareRows(row, after) > 0) {
            rows.push(row);
          }
        };
        if (tab === 'mine') append({
          id: ORIGIN_CONVERSATION_ID, session_group: ORIGIN, channel: 'dashboard', endpoint_id: ORIGIN,
          stamp: !summaryOnly && stamp.get((latestReceived.get(ORIGIN) ?? originFirst.get(ORIGIN))?.timestamp ?? null),
          display_name: ORIGIN_DISPLAY_NAME, localId: ORIGIN, origin: true, draft: false,
        }, originHead && originHead.get(ORIGIN));
        // Jump from one index prefix to the next, including groups without a head.
        for (let group = nextGroup.get(''); group !== undefined; group = nextGroup.get(group)) {
          if (group === ORIGIN || group === '*' || !belongsToTab.get({ group })) continue;
          const route = member.get(group);
          if (!route) continue;
          const registered = tab === 'mine' ? this.conversations?.findByGroup(group) : null;
          const name = this.conversations?.store.getGroupDisplayName(group)?.display_name;
          append({ id: groupId(group), session_group: group, channel: route.channel,
            endpoint_id: route.channel === 'dashboard' ? dashboardConversationId(route.endpoint_id) : route.endpoint_id,
            stamp: !summaryOnly && stamp.get((latestReceived.get(group) ?? first.get(group))?.timestamp ?? null),
            display_name: registered ? name ?? registered.displayName : name ?? (tab === 'mine' ? group.slice(group.indexOf(':') + 1) : group),
            ...(registered ? { localId: registered.localId } : {}), draft: false }, route);
        }
        if (newest) {
          summary.latest = { at: newest.at, title: newest.row.display_name ?? unnamed, preview: preview(newest.row, readMessage(newest.row)) };
        }
        if (summaryOnly) return { summary };
        // The existing draft source pages its own timestamp index.
        const slots = page.limit;
        if (tab === 'mine' && this.conversations) rows.push(...this._drafts(slots + 1, after, search, unnamed));
        pinned.sort((a, b) => (a.pinOrder ?? -1) - (b.pinOrder ?? -1));
        rows.sort(compareRows);
        const items = [...pinned, ...rows.slice(0, slots)].map(row => {
          if (row.draft) return { ...row, unreadCount: 0 };
          const message = readMessage(row);
          const item = { ...row, previewDirection: message?.direction ?? null, preview: preview(row, message) };
          if (tab === 'mine') {
            item.unreadCount = this._unread(unreadRange(row), this.readPosition(row.id), UNREAD_COUNT_LIMIT);
            item.unread = item.unreadCount > 0;
          }
          return item;
        });
        const last = rows[slots - 1];
        return { items, nextCursor: rows.length > slots ? page.nextCursor([last.stamp, last.id]) : null,
          ...(summary ? { summary } : {}) };
      })();
    } catch (error) {
      if (error.code === 'chat_history_unavailable') throw error;
      throw fail('chat_history_unavailable', 502);
    }
  }

  _drafts(limit, position, search, unnamed) {
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
        const draft = { id: row.id, localId: row.local_id, session_group: group ?? '',
          channel: 'dashboard', endpoint_id: row.local_id, stamp: row.stamp,
          preview: '', display_name: row.display_name, draft: true, state: row.state, unread: false };
        if (search && !matchesSearch({ ...draft, display_name: draft.display_name ?? unnamed }, search)) continue;
        drafts.push(draft);
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
    where += ` AND ${listScope(tab)}`;
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

  readPosition(id) {
    return this.conversations?.db.prepare("SELECT COALESCE(MAX(last_read),0) FROM chat_read_positions WHERE conversation_id IN ('',?)")
      .pluck().get(id) ?? 0;
  }

  readPositions() {
    return this.conversations?.db.prepare("SELECT conversation_id,last_read FROM chat_read_positions WHERE conversation_id <> '' ORDER BY conversation_id").all() ?? [];
  }

  _unread(range, readUpTo, limit) {
    return this._query(`SELECT c.id FROM conversations c INDEXED BY idx_conv_group_id
      WHERE ${range.where} AND ${visibleIn(range, true)} AND c.id>@readUpTo
        AND NOT (c.direction='in' AND c.channel='dashboard')
      ORDER BY c.id DESC LIMIT @limit`, {
      ...range.parameters, readUpTo, limit,
    }).length;
  }

  hasUnread(id, range = this._messageRange('mine', id)) {
    return this._unread(range, this.readPosition(id), 1) > 0;
  }

  /** The Dashboard database is the only writer of read positions. */
  _advanceRead(id, upTo) {
    const db = this.conversations.db;
    db.prepare(`INSERT INTO chat_read_positions (conversation_id,last_read)
      SELECT ?,? WHERE ?>COALESCE((SELECT last_read FROM chat_read_positions WHERE conversation_id=''),0)
      ON CONFLICT(conversation_id) DO UPDATE SET last_read=excluded.last_read
      WHERE chat_read_positions.last_read < excluded.last_read`).run(id, upTo, upTo);
    return this.readPosition(id);
  }

  markRead(id, upTo) {
    if (!Number.isSafeInteger(upTo) || upTo <= 0) {
      throw listFailure(400, 'invalid_parameter', 'Invalid upTo', 'upTo');
    }
    const db = this.conversations.db;
    return db.transaction(() => {
      let range;
      try { range = this._messageRange('mine', id); }
      catch (error) {
        if (['chat_conversation_not_found', 'invalid_chat_conversation'].includes(error.code)) {
          throw listFailure(404, 'not_found', 'The requested conversation does not exist');
        }
        throw error;
      }
      // Serialize with Dashboard deletion cleanup. A committed Core deletion
      // fence prevents a stale read request from recreating the removed row.
      const row = this._query(`SELECT c.id FROM conversations c
        WHERE ${range.where} AND ${visibleIn(range, true)} AND c.id=@upTo
          AND NOT EXISTS (
            SELECT 1 FROM drain_fences f WHERE f.session_group=c.session_group AND f.reason='delete'
          )`, { ...range.parameters, upTo })[0];
      if (!row) throw listFailure(400, 'invalid_parameter', 'The message is outside this conversation', 'upTo');
      return this._advanceRead(id, upTo);
    }).immediate();
  }

  messages(id, { tab = 'mine', limit, cursor, direction = 'before', anchor, recheckIds, locale = 'zh', page: query } = {}) {
    if (!query) {
      const parameters = new URLSearchParams({ tab, direction });
      if (limit != null) parameters.set('limit', limit);
      if (cursor != null) parameters.set('cursor', cursor);
      if (anchor != null) parameters.set('anchor', anchor);
      query = chatQuery(parameters, chatCollection(id, 'messages'), { extras: { direction: ['before', 'after'], anchor: ['read'] } });
    }
    limit = query.limit;
    const position = query.after;
    if (anchor && (tab !== 'mine' || position !== null || direction === 'after')) {
      throw listFailure(400, 'invalid_parameter', 'The read anchor is only available on the first Mine page', 'anchor');
    }
    if (direction === 'after' && position === null) throw fail('invalid_chat_cursor');
    const range = this._messageRange(tab, id);
    const recheck = recheckIds === undefined ? [] : this._messageIds(recheckIds);
    const readRows = (operator, order, boundary, count) => this._query(`SELECT c.id, c.timestamp, c.direction, c.channel,
      c.endpoint_id, c.session_group, c.content, c.status, c.delivery_action FROM conversations c
      WHERE ${visibleIn(range, true)} AND ${range.where}${boundary === null ? '' : ` AND c.id ${operator} @position`}
      ORDER BY c.id ${order} LIMIT @limit`, {
      ...range.parameters, ...(boundary === null ? {} : { position: boundary }), limit: count,
    });
    let page, more, next, readUpTo, unreadCount;
    if (anchor) {
      readUpTo = this.readPosition(id);
      unreadCount = this._unread(range, readUpTo, UNREAD_COUNT_LIMIT);
      const newer = readRows('>', 'ASC', readUpTo, Math.ceil(limit / 2));
      const olderCount = limit - newer.length;
      const older = readRows('<=', 'DESC', readUpTo, olderCount + 1);
      more = older.length > olderCount;
      page = [...older.slice(0, olderCount).reverse(), ...newer];
      next = page[0]?.id;
    } else {
      const before = direction === 'before';
      const rows = readRows(before ? '<' : '>', before ? 'DESC' : 'ASC', position, limit + 1);
      more = rows.length > limit;
      page = rows.slice(0, limit);
      next = page.at(-1)?.id;
      if (before) page.reverse();
    }
    const rechecked = recheck.length ? this._rowsByIds(range, recheck,
      'c.id,c.direction,c.channel,c.endpoint_id,c.session_group,c.content', visibleIn(range, true)) : [];
    const batch = [...new Map([...page, ...rechecked].map(row => [row.id, row])).values()];
    const outboundQuotes = dashboardReplyQuotes(page, () => this._db());
    const quoteId = row => rowQuote(row)?.id ?? outboundQuotes.get(row.id);
    const quoteIds = [...new Set(page.map(quoteId).filter(Boolean))];
    const quoted = new Map((quoteIds.length ? this._rowsByIds(range, quoteIds,
      'c.id,c.direction,c.timestamp,c.channel,c.endpoint_id,c.content', visibleIn(range, true), false) : [])
      .map(row => [row.id, row]));
    // The Origin conversation also shows external chats' rows; each row is
    // presented as its own channel's page would present it.
    const externalRow = row => tab === 'external' || !['dashboard', 'internal'].includes(row.channel);
    const metadata = new Map();
    if (tab === 'mine' && this.attachments) {
      const ownRows = batch.filter(row => row.channel === 'dashboard');
      for (let offset = 0; offset < ownRows.length; offset += 100) {
        for (const [rowId, values] of this.attachments.metadata(ownRows.slice(offset, offset + 100))) {
          metadata.set(rowId, values);
        }
      }
    }
    const rowAttachments = row => row.channel === 'internal' ? [] : externalRow(row)
      ? splitContentAndAttachments(row.content).attachments.map(attachment => ({
        name: attachment.name, kind: attachment.kind, sizeLabel: attachment.sizeLabel,
        available: false, external: true,
      })) : metadata.get(row.id) ?? [];
    const peers = new Map(), named = new Map();
    const names = localId => {
      if (!named.has(localId)) named.set(localId, this._conversationName(localId));
      return named.get(localId);
    };
    const items = page.map(row => {
      const id = quoteId(row);
      if (id) {
        let target = quoted.get(id);
        if (row.direction === 'out' && target && (target.direction !== 'in' || target.channel !== 'dashboard'
          || target.endpoint_id !== dashboardConversationId(row.endpoint_id))) target = undefined;
        row = { ...row, quote: { id, direction: target?.direction ?? null,
          internal: target?.channel === 'internal',
          timestamp: target?.timestamp ?? null, preview: target ? quotePreview(target, { external: externalRow(target), locale }) : '', available: !!target } };
      }
      if (row.channel === 'internal') {
        if (!peers.has(row.endpoint_id)) peers.set(row.endpoint_id, this._internalPeer(row.endpoint_id));
        return { ...row, internal: { ...peers.get(row.endpoint_id), content: internalContent(row) }, attachments: [] };
      }
      return { ...row, deliveryState: deliveryState(row),
        preview: conversationPreview(previewContent(row), { external: externalRow(row), locale }), attachments: rowAttachments(row),
        ...(range.origin && row.channel === 'dashboard' ? { conversationName: names(dashboardConversationId(row.endpoint_id)) } : {}) };
    });
    const newest = items.at(-1)?.id ?? position ?? readUpTo ?? 0;
    return { items, nextCursor: more ? query.nextCursor(next) : null, afterCursor: query.nextCursor(newest),
      ...(anchor ? { readUpTo, unreadCount } : {}),
      ...(recheckIds !== undefined ? { attachmentUpdates: rechecked.map(row => ({ id: row.id, attachments: rowAttachments(row) })) } : {}) };
  }

  /** Name of the Dashboard conversation at a local ID, as the "mine" list names it. */
  _conversationName(localId) {
    if (localId === ORIGIN) return ORIGIN_DISPLAY_NAME;
    try { return this.conversations?.get(localId).displayName ?? null; }
    catch { /* A group without a Dashboard record is named like the list names it. */ }
    const namespace = this._query("SELECT namespace FROM channel_namespaces WHERE component_name='dashboard' LIMIT 1", {})[0]?.namespace;
    return (namespace && this.conversations?.store.getGroupDisplayName(`${namespace}:${localId}`)?.display_name) || localId;
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
      const groupedChange = `(${grouped} AND ${tabGroupScope(tab)} AND
        ((${visible} AND ${listScope(tab)}) OR (${receivedMessage})))`;
      // A system message in Origin changes its time without changing its preview.
      const listed = tab === 'mine'
        ? `(${groupedChange} OR ((${originVisible} OR ${receivedMessage}) AND ${originWhere}))` : groupedChange;
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
