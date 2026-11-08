import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDataError as localDataError, parseSessionGroup, validateGroupName, validNamespace } from '../../../../comm-bridge/scripts/c4-session-group.js';
import { MAX_CONTENT_BYTES } from '../../../../comm-bridge/scripts/c4-content-schema.js';
import { deliveryState } from './history.js';
import { buildAnnotatedContent } from '../../../../comm-bridge/scripts/attachment-annotations.js';

const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const canonicalId = row => `g:${Buffer.from(`${row.namespace}:${row.localId}`).toString('hex').toUpperCase()}`;
const messageId = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const unknown = outcome => ['sending', 'unknown'].includes(outcome?.kind);

/** Shared receive facts; notification hints never establish delivery to an agent. */
export function classifyReceiveResult(result, failure, isDataError = localDataError) {
  const error = typeof failure?.code === 'string' ? failure.code : 'chat_send_unknown';
  const committed = !failure && result?.ok === true && messageId(result.id) ||
    failure && Array.isArray(failure.persisted) && failure.persisted.includes('D1');
  if (committed) return { kind: 'committed', id: messageId(failure ? failure.id : result.id),
    ...(failure ? { error } : { action: result.action }) };
  if (failure && isDataError(failure) && Array.isArray(failure.persisted) && failure.persisted.length === 0) {
    return { kind: 'not_stored', id: null, error };
  }
  return { kind: 'unknown', id: null, error };
}

/** One process-local sender; persistence records uncertainty, never a retry lease. */
export class ChatSender {
  constructor({ conversations, c4Reader, loadCore, zylosDir, attachments = null }) {
    this.conversations = conversations;
    this.c4Reader = c4Reader;
    this.zylosDir = zylosDir;
    this.attachments = attachments;
    this.inflight = new Map();
    this.loadCore = loadCore ?? (async () => {
      const scripts = path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts');
      const config = await import(pathToFileURL(path.join(scripts, 'c4-config.js')).href);
      if (path.resolve(config.DB_PATH) !== path.resolve(zylosDir, 'comm-bridge', 'c4.db')) {
        throw fail('chat_core_path_mismatch', 503);
      }
      const [{ receive }, db, contract] = await Promise.all([
        import(pathToFileURL(path.join(scripts, 'c4-receive.js')).href),
        import(pathToFileURL(path.join(scripts, 'c4-db.js')).href),
        import(pathToFileURL(path.join(scripts, 'c4-session-group.js')).href),
      ]);
      return { receive, getChannelNamespace: db.getChannelNamespace,
        ensureChannelNamespace: db.ensureChannelNamespace, isDataError: contract.isDataError };
    });
  }

  _db() {
    const db = this.c4Reader._open();
    if (!db) throw fail('chat_core_unavailable', 502);
    return db;
  }

  _binding(row) {
    const binding = this._db().prepare(`SELECT component_name FROM channel_namespaces WHERE namespace=?`).get(row.namespace);
    if (binding?.component_name !== 'dashboard') throw fail('chat_conversation_forbidden', 403);
  }

  _record(id, { reconcile = false } = {}) {
    if (typeof id !== 'string') throw fail('invalid_chat_conversation');
    let localId, namespace = null;
    if (id.startsWith('d:')) localId = id.slice(2);
    else if (/^g:(?:[0-9A-F]{2})+$/.test(id)) {
      const group = Buffer.from(id.slice(2), 'hex').toString('utf8');
      if (`g:${Buffer.from(group).toString('hex').toUpperCase()}` !== id) throw fail('invalid_chat_conversation');
      const parsed = parseSessionGroup(group);
      if (!parsed?.groupName) throw fail('invalid_chat_conversation');
      ({ namespace, groupName: localId } = parsed);
    } else throw fail('invalid_chat_conversation');
    try { validateGroupName(localId); } catch { throw fail('invalid_chat_conversation'); }
    const row = this.conversations.get(localId);
    if (row.channel !== 'dashboard' || row.localId !== localId || (namespace &&
        (row.namespace !== namespace || (row.state !== 'active' && !(reconcile && unknown(row.lastOutcome)))))) {
      throw fail('chat_conversation_forbidden', 403);
    }
    if (row.namespace !== null) {
      if (!validNamespace(row.namespace)) throw fail('chat_conversation_forbidden', 403);
    }
    return row;
  }

  async resolve(id) {
    const row = this._record(id);
    if (row.namespace) this._binding(row);
    return row;
  }

  async prepareAttachmentConversation(row, { authorize } = {}) {
    const core = await this.loadCore();
    const denied = await authorize?.(row);
    if (denied) throw fail(denied.error || 'chat_conversation_forbidden', denied.status || 403);
    const binding = await core.ensureChannelNamespace('dashboard');
    if (binding?.componentName !== 'dashboard' || !validNamespace(binding.namespace)
        || (row.namespace && row.namespace !== binding.namespace)) throw fail('chat_conversation_forbidden', 403);
    return row;
  }

  _head(row) {
    this._binding(row);
    return this._db().prepare('SELECT head_id FROM group_heads WHERE session_group=?').get(`${row.namespace}:${row.localId}`) ?? null;
  }

  _status(row, id) {
    try {
      this._binding(row);
      const result = this._db().prepare(`SELECT direction,status,delivery_action FROM conversations
        WHERE id=? AND direction='in' AND channel='dashboard' AND endpoint_id=? AND session_group=?`)
        .get(id, row.localId, `${row.namespace}:${row.localId}`);
      return result ? deliveryState(result) : 'pending_reconciliation';
    } catch { return 'pending_reconciliation'; }
  }

  _receipt(row, { initial = false, headMissing = false, headFailed = false } = {}) {
    const lastOutcome = row.lastOutcome;
    // Activation proves the initial insert committed, even when its receipt
    // was lost. That evidence belongs to the send, not the ID used to open it.
    const first = row.state === 'active' && (initial ||
      (lastOutcome?.initial === true && unknown(lastOutcome)));
    const outcome = first && lastOutcome?.initial === false ? null : lastOutcome;
    const id = messageId(first ? row.firstMessageId : row.lastMessageId);
    const uncertain = unknown(outcome) && !first;
    const stored = first || outcome?.kind === 'committed' ? true : uncertain ? null : false;
    const state = stored ? (id ? this._status(row, id) : 'pending_reconciliation')
      : uncertain ? 'pending_reconciliation' : null;
    return { conversationId: row.state === 'active' ? canonicalId(row) : `d:${row.localId}`,
      localId: row.localId, channel: row.channel, namespace: row.namespace,
      draft: row.state !== 'active', stored, messageId: id,
      deliveryState: state,
      needsReconciliation: headFailed || (!headMissing && (uncertain || state === 'pending_reconciliation')),
      retryAllowed: !first && !headFailed && stored !== true && !(outcome?.kind === 'sending' && this.inflight.has(row.localId)),
      preserveInput: !first && (uncertain || outcome?.kind === 'not_stored'),
      ...(outcome?.action ? { action: outcome.action } : {}),
      ...(outcome?.error ? { error: outcome.error } : {}) };
  }

  async _reconcile(row, initial) {
    if (row.state !== 'active' && row.namespace && unknown(row.lastOutcome)) {
      try {
        if (this._head(row)) {
          row = this.conversations.markCommitted(row.localId);
          return this._receipt(row, { initial });
        }
        row = this.conversations.markDraft(row.localId);
        return this._receipt(row, { initial, headMissing: true });
      } catch (error) {
        if (error.code === 'chat_conversation_forbidden') throw error;
        return this._receipt(row, { initial, headFailed: true });
      }
    }
    return this._receipt(row, { initial });
  }

  async reconcile(id) {
    const row = this._record(id, { reconcile: true });
    if (row.namespace) {
      try { this._binding(row); }
      catch (error) {
        if (error.code === 'chat_conversation_forbidden') throw error;
        return this._receipt(row, { initial: id.startsWith('d:'), headFailed: true });
      }
    }
    return this._reconcile(row, id.startsWith('d:'));
  }

  _initialReceipt(row, content) {
    if (row.firstContent !== content) {
      throw Object.assign(fail('chat_conversation_started', 409), {
        conversationId: canonicalId(row), preserveInput: true,
      });
    }
    return this._receipt(row, { initial: true });
  }

  async send(id, { content = '', retry = false, attachments = [] } = {}, { authorize, principal } = {}) {
    if (typeof content !== 'string' || typeof retry !== 'boolean' || !Array.isArray(attachments)
        || (attachments.length && !this.attachments)) {
      throw fail('invalid_chat_content');
    }
    let row = await this.resolve(id);
    const records = this.attachments?.prepareSend(row, attachments, principal) ?? [];
    if (records.length) content = buildAnnotatedContent(content, records);
    if (!content.trim() || Buffer.byteLength(content) > MAX_CONTENT_BYTES) throw fail('invalid_chat_content');
    const initial = id.startsWith('d:');
    if (initial && row.state === 'active') return this._initialReceipt(row, content);
    if (this.inflight.has(row.localId)) return { ...this._receipt(row, { initial }), retryAllowed: false, preserveInput: true };
    this.inflight.set(row.localId, true);
    try {
      if (unknown(row.lastOutcome)) {
        const receipt = await this._reconcile(row, initial);
        row = this.conversations.get(row.localId);
        if (initial && row.state === 'active') return this._initialReceipt(row, content);
        if (row.state === 'active' && row.lastOutcome?.initial === true) {
          // A recovered first insert cannot be retried through the canonical
          // entry. Different text is a normal subsequent send.
          if (content === row.firstContent) return this._receipt(row, { initial: true });
        } else if (!retry || (row.state !== 'active' && receipt.needsReconciliation)) return receipt;
      }
      if (row.lastOutcome?.kind === 'committed' && row.pendingContent === content &&
          (row.lastOutcome.error || row.lastOutcome.action === 'suppressed')) return this._receipt(row, { initial });
      const core = await this.loadCore();
      const check = async record => {
        const denied = await authorize?.(record);
        if (denied) throw fail(denied.error || 'chat_conversation_forbidden', denied.status || 403);
      };
      await check(row);
      const binding = await core.ensureChannelNamespace('dashboard');
      if (binding?.componentName !== 'dashboard' || !validNamespace(binding.namespace)) throw fail('chat_conversation_forbidden', 403);
      if (row.namespace && row.namespace !== binding.namespace) throw fail('chat_conversation_forbidden', 403);
      await check({ ...row, namespace: binding.namespace, sessionGroup: `${binding.namespace}:${row.localId}` });
      row = this.conversations.bind(row.localId, binding.namespace);
      this._binding(row);
      // Persist before entering Core. A restart must recover uncertainty instead
      // of treating an interrupted call as a fresh first send.
      this.conversations.beginSend(row.localId, { content, initial });
      let result, failure;
      try {
        result = await core.receive(['--channel', 'dashboard', '--endpoint', row.localId,
          '--session-group', row.localId, '--content', content]);
      } catch (error) { failure = error; }
      const { id: savedId, ...outcome } = classifyReceiveResult(result, failure, core.isDataError ?? localDataError);
      if (savedId && records.length) {
        try {
          const saved = this._db().prepare('SELECT * FROM conversations WHERE id=?').get(savedId);
          if (saved) this.attachments.linkRow(saved);
        } catch { /* Historical reads and bounded collection repair late links. */ }
      }
      if (outcome.kind === 'committed') {
        this.conversations.markCommitted(row.localId, { id: savedId });
        row = this.conversations.saveOutcome(row.localId, { content: failure || outcome.action === 'suppressed' ? content : null,
          id: savedId, outcome: { ...outcome, initial } });
        return this._receipt(row, { initial });
      }
      if (outcome.kind === 'not_stored') {
        this.conversations.markDraft(row.localId);
        row = this.conversations.saveOutcome(row.localId, { content, outcome: { ...outcome, initial } });
        return this._receipt(row, { initial });
      }
      row = this.conversations.saveOutcome(row.localId, { content, outcome: { ...outcome, initial } });
      return this._reconcile(row, initial);
    } finally { this.inflight.delete(row.localId); }
  }
}
