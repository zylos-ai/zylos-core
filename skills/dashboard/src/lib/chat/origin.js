/**
 * The Origin conversation is the fixed address `dashboard origin`, recorded by
 * Core in session group `origin`. Its Dashboard record keeps the same send
 * state as any other conversation, under local ID `origin` with namespace
 * `origin`. `origin` is never a valid channel namespace, so that namespace
 * marks the fixed record and cannot belong to an ordinary conversation.
 */
export const ORIGIN = 'origin';
export const ORIGIN_CONVERSATION_ID = `g:${Buffer.from(ORIGIN).toString('hex').toUpperCase()}`;
/** Its fixed name, in the list and on the conversation page alike. */
export const ORIGIN_DISPLAY_NAME = 'Origin';

export const isOriginRecord = (namespace, localId) => namespace === ORIGIN && localId === ORIGIN;

/** Core session group of a Dashboard record. */
export const conversationGroup = (namespace, localId) =>
  isOriginRecord(namespace, localId) ? ORIGIN : `${namespace}:${localId}`;

/**
 * Session group of the Dashboard conversation at `endpointId` (its local ID),
 * independent of the group that recorded a row: in single mode rows of every
 * conversation are recorded under `origin`. The conversation record gives the
 * namespace; an existing group without a record falls back to the namespace
 * Core bound to Dashboard (`readNamespace`), the same rule Core uses to route
 * the address. Null when neither is known.
 */
export function endpointConversationGroup(db, endpointId, readNamespace = () => null) {
  if (typeof endpointId !== 'string' || !endpointId) return null;
  const record = db.prepare('SELECT namespace FROM chat_conversations WHERE local_id=?').get(endpointId);
  if (record?.namespace) return conversationGroup(record.namespace, endpointId);
  if (endpointId === ORIGIN) return ORIGIN;
  const namespace = readNamespace();
  return namespace ? `${namespace}:${endpointId}` : null;
}

/** Idempotent; called at every Dashboard start, so new installs and upgrades both have it. */
export function ensureOriginConversation(db, now = Date.now) {
  const stamp = now();
  db.prepare(`INSERT INTO chat_conversations(local_id,namespace,state,created_at,updated_at)
    VALUES (?,?,'active',?,?) ON CONFLICT(local_id) DO NOTHING`).run(ORIGIN, ORIGIN, stamp, stamp);
}
