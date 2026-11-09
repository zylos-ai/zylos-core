import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { validName } from '../workbench/display-names.js';
import { validateGroupName, validNamespace } from '../../../../comm-bridge/scripts/c4-session-group.js';

const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const groupId = key => `g:${Buffer.from(key).toString('hex').toUpperCase()}`;

/** Check historical ownership without registering a namespace or creating a Core group. */
export function isChatLocalIdUsed(c4Reader, localId) {
  const db = c4Reader._open();
  if (!db) {
    if (fs.existsSync(c4Reader._dbPath)) throw fail('chat_history_unavailable', 502);
    return false;
  }
  return !!db.prepare(`SELECT 1 FROM conversations WHERE channel='dashboard' AND endpoint_id=@localId
    UNION ALL SELECT 1 FROM group_heads h JOIN channel_namespaces n
      ON h.session_group=n.namespace || ':' || @localId
      WHERE n.component_name='dashboard' LIMIT 1`).get({ localId });
}

/** Read the existing Core ownership proof without registering either database. */
function existingChatGroup(sessionGroup, c4Reader) {
  const colon = typeof sessionGroup === 'string' ? sessionGroup.indexOf(':') : -1;
  if (colon < 1) throw fail('chat_conversation_forbidden', 403);
  const namespace = sessionGroup.slice(0, colon), localId = sessionGroup.slice(colon + 1);
  if (!validNamespace(namespace)) throw fail('chat_conversation_forbidden', 403);
  try { validateGroupName(localId); } catch { throw fail('chat_conversation_forbidden', 403); }
  const core = c4Reader._open();
  if (!core) throw fail('chat_history_unavailable', 502);
  if (core.prepare('SELECT component_name FROM channel_namespaces WHERE namespace=?').get(namespace)?.component_name !== 'dashboard') {
    throw fail('chat_conversation_forbidden', 403);
  }
  if (core.prepare("SELECT 1 FROM drain_fences WHERE session_group=? AND reason='delete'").get(sessionGroup)) {
    throw fail('chat_conversation_deleting', 409);
  }
  const exists = core.prepare(`SELECT 1 FROM group_heads WHERE session_group=?
    UNION ALL SELECT 1 FROM conversations WHERE session_group=? AND channel='dashboard' AND endpoint_id=? LIMIT 1`)
    .get(sessionGroup, sessionGroup, localId);
  if (!exists) throw fail('chat_conversation_not_found', 404);
  return { namespace, localId };
}

/** Re-register only a proven Core group, without creating Core routing state. */
export function registerExistingChatGroup(db, sessionGroup, c4Reader, now = Date.now) {
  return db.transaction(() => {
    const { namespace, localId } = existingChatGroup(sessionGroup, c4Reader);
    const stamp = now();
    db.prepare(`INSERT INTO chat_conversations(local_id,namespace,state,created_at,updated_at)
      VALUES (?,?,'active',?,?) ON CONFLICT(local_id) DO NOTHING`).run(localId, namespace, stamp, stamp);
    const row = db.prepare('SELECT * FROM chat_conversations WHERE local_id=?').get(localId);
    if (row.namespace !== namespace || row.state !== 'active') throw fail('chat_conversation_forbidden', 403);
    return row;
  }).immediate();
}

/** Dashboard-owned registration only; creating or renaming a draft never writes C4. */
export class ChatConversations {
  constructor({ store, idGenerator = randomUUID, now = Date.now, isUsed = () => false }) {
    this.store = store;
    this.db = store.db;
    this.idGenerator = idGenerator;
    this.now = now;
    this.isUsed = isUsed;
  }

  _row(localId) {
    if (typeof localId !== 'string') throw fail('invalid_chat_conversation');
    const row = this.db.prepare('SELECT * FROM chat_conversations WHERE local_id=?').get(localId);
    if (!row) throw fail('chat_conversation_not_found', 404);
    return row;
  }

  _project(row) {
    const sessionGroup = row.namespace ? `${row.namespace}:${row.local_id}` : null;
    let lastOutcome = null;
    try { lastOutcome = row.last_outcome === null ? null : JSON.parse(row.last_outcome); }
    catch { throw fail('chat_conversation_unavailable', 502); }
    return {
      id: row.state === 'active' ? groupId(sessionGroup) : `d:${row.local_id}`,
      localId: row.local_id, channel: 'dashboard', namespace: row.namespace, sessionGroup,
      displayName: row.state === 'active'
        ? this.store.getGroupDisplayName(sessionGroup)?.display_name ?? null : row.display_name,
      state: row.state, createdAt: row.created_at, updatedAt: row.updated_at,
      firstMessageId: row.first_message_id, firstContent: row.first_content, pendingContent: row.pending_content,
      lastMessageId: row.last_message_id, lastOutcome,
    };
  }

  get(localId) { return this._project(this._row(localId)); }

  findByGroup(sessionGroup) {
    if (typeof sessionGroup !== 'string') return null;
    const colon = sessionGroup.indexOf(':');
    if (colon < 1) return null;
    const row = this.db.prepare('SELECT * FROM chat_conversations WHERE namespace=? AND local_id=?')
      .get(sessionGroup.slice(0, colon), sessionGroup.slice(colon + 1));
    return row ? this._project(row) : null;
  }

  /** A read-only projection for a recreated group; writes register after authorization. */
  existingGroup(sessionGroup, c4Reader) {
    const { namespace, localId } = existingChatGroup(sessionGroup, c4Reader);
    return this._project({ local_id: localId, namespace, state: 'active', last_outcome: null,
      created_at: null, updated_at: null, first_message_id: null, first_content: null,
      pending_content: null, last_message_id: null });
  }

  /** Re-register only an existing Core group owned by the Dashboard namespace. */
  registerExistingGroup(sessionGroup, c4Reader) {
    const row = registerExistingChatGroup(this.db, sessionGroup, c4Reader, this.now);
    return this.get(row.local_id);
  }

  create({ displayName = null } = {}) {
    const name = displayName === null ? null : validName(displayName);
    if (displayName !== null && name === null) throw fail('invalid_chat_display_name');
    const insert = this.db.prepare(`INSERT INTO chat_conversations
      (local_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(local_id) DO NOTHING`);
    for (let attempt = 0; attempt < 32; attempt++) {
      const localId = this.idGenerator();
      try { validateGroupName(localId); } catch { throw fail('invalid_chat_local_id'); }
      if (this.isUsed(localId)) continue;
      const now = this.now();
      if (insert.run(localId, name, now, now).changes) return this.get(localId);
    }
    throw fail('chat_id_unavailable', 503);
  }

  rename(localId, displayName) {
    const name = validName(displayName);
    if (name === null) throw fail('invalid_chat_display_name');
    this.db.transaction(() => {
      const row = this._row(localId);
      if (row.state === 'active') {
        this.store.writeGroupDisplayName(`${row.namespace}:${localId}`, name, 'human');
      } else this.db.prepare('UPDATE chat_conversations SET display_name=? WHERE local_id=?').run(name, localId);
      this.db.prepare('UPDATE chat_conversations SET updated_at=? WHERE local_id=?').run(this.now(), localId);
    }).immediate();
    return this.get(localId);
  }

  bind(localId, namespace) {
    if (!validNamespace(namespace)) throw fail('chat_conversation_forbidden', 403);
    const row = this._row(localId);
    if (row.namespace !== null && row.namespace !== namespace) throw fail('chat_conversation_forbidden', 403);
    this.db.prepare('UPDATE chat_conversations SET namespace=? WHERE local_id=?').run(namespace, localId);
    return this.get(localId);
  }

  markCommitted(localId, { id = null } = {}) {
    this.db.transaction(() => {
      const row = this._row(localId);
      if (!row.namespace) throw fail('chat_conversation_forbidden', 403);
      const group = `${row.namespace}:${localId}`;
      if (row.state !== 'active' && row.display_name !== null && !this.store.getGroupDisplayName(group)) {
        this.store.writeGroupDisplayName(group, row.display_name, 'human');
      }
      // Head-only recovery has no first-message ID; a later receipt cannot fill it.
      this.db.prepare(`UPDATE chat_conversations SET state='active', display_name=NULL,
        first_message_id=COALESCE(first_message_id, ?), updated_at=? WHERE local_id=?`)
        .run(row.state === 'active' ? null : id, this.now(), localId);
    }).immediate();
    return this.get(localId);
  }

  markUnknown(localId, content) {
    this._row(localId);
    this.db.prepare(`UPDATE chat_conversations SET state=CASE WHEN state='active' THEN state ELSE 'unknown' END,
      pending_content=?, updated_at=? WHERE local_id=?`).run(content, this.now(), localId);
    return this.get(localId);
  }

  beginSend(localId, { content, initial }) {
    this.db.transaction(() => {
      if (initial) this.db.prepare(`UPDATE chat_conversations SET first_content=?
        WHERE local_id=? AND state <> 'active'`).run(content, localId);
      this.markUnknown(localId, content);
      this.saveOutcome(localId, { content, outcome: { kind: 'sending', initial } });
    }).immediate();
    return this.get(localId);
  }

  markDraft(localId) {
    this._row(localId);
    this.db.prepare(`UPDATE chat_conversations SET state=CASE WHEN state='active' THEN state ELSE 'draft' END,
      updated_at=? WHERE local_id=?`).run(this.now(), localId);
    return this.get(localId);
  }

  saveOutcome(localId, { content = null, id = null, outcome } = {}) {
    this._row(localId);
    this.db.prepare(`UPDATE chat_conversations SET pending_content=?, last_message_id=?, last_outcome=?,
      updated_at=? WHERE local_id=?`).run(content, id, outcome === undefined ? null : JSON.stringify(outcome), this.now(), localId);
    return this.get(localId);
  }

  clearOutcome(localId) {
    this._row(localId);
    this.db.prepare(`UPDATE chat_conversations SET pending_content=NULL, last_outcome=NULL,
      updated_at=? WHERE local_id=?`).run(this.now(), localId);
    return this.get(localId);
  }

  /** A bounded sorted source for the history merge; no C4 lookups or writes. */
  listDrafts({ limit, position = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 101) throw fail('invalid_chat_limit');
    return this.db.prepare(`SELECT local_id, namespace, display_name, state, updated_at,
      updated_at / 86400000.0 + 2440587.5 AS stamp, 'd:' || local_id AS id
      FROM chat_conversations WHERE state <> 'active'
      AND (@stamp IS NULL OR updated_at / 86400000.0 + 2440587.5 < @stamp
        OR (updated_at / 86400000.0 + 2440587.5 = @stamp AND ('d:' || local_id) COLLATE BINARY > @id))
      ORDER BY stamp DESC, id COLLATE BINARY LIMIT @limit`)
      .all({ stamp: position?.stamp ?? null, id: position?.id ?? '', limit });
  }
}
