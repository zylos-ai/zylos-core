import { parseC4Content } from '../../../../comm-bridge/scripts/c4-content-schema.js';
import { parseSessionGroup, isDataError } from '../../../../comm-bridge/scripts/c4-session-group.js';
import { classifyReceiveResult } from './send.js';
import { ORIGIN, isOriginRecord } from './origin.js';

const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const validId = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const ambiguous = error => ['chat_answer_lookup_failed', 'chat_answer_duplicate'].includes(error);
// One predicate governs startup and question-page recovery. Confirmed receipts
// with a row ID need only their indexed status read, not another group scan.
const unresolved = `(d.state IN ('pending','sending','unknown') OR (d.state='committed' AND
  (d.c4_id IS NULL OR d.error IN ('chat_answer_lookup_failed','chat_answer_duplicate'))))`;

/** Durable answer delivery, with no polling, leases or automatic resends. */
export class ChatAnswerDelivery {
  constructor({ answers, sender, c4Reader, now = Date.now }) {
    this.answers = answers;
    this.db = answers.db;
    this.sender = sender;
    this.c4Reader = c4Reader;
    this.now = now;
    this.inflight = new Map();
  }

  _delivery(answerId) {
    const row = this.db.prepare('SELECT * FROM chat_answer_deliveries WHERE answer_id=?').get(answerId);
    if (!row) throw fail('chat_answer_delivery_missing', 502);
    return row;
  }

  _save(answerId, { state, id = null, error = null }) {
    const result = this.db.prepare(`UPDATE chat_answer_deliveries SET state=?,c4_id=?,error=?,updated_at=?
      WHERE answer_id=?`).run(state, id, error, this.now(), answerId);
    if (result.changes !== 1) throw fail('chat_answer_delivery_missing', 502);
    return this._delivery(answerId);
  }

  _group(answer) {
    if (answer.sessionGroup === ORIGIN && answer.endpointId === ORIGIN) return { namespace: ORIGIN, localId: ORIGIN };
    const parsed = parseSessionGroup(answer.sessionGroup);
    if (!parsed?.groupName || parsed.groupName !== answer.endpointId) throw fail('chat_answer_forbidden', 403);
    return { namespace: parsed.namespace, localId: parsed.groupName };
  }

  _receipt(answer, row) {
    const stored = row.state === 'committed' ? true : ['unknown', 'sending'].includes(row.state) ? null : false;
    const duplicate = ambiguous(row.error);
    const deliveryState = stored && validId(row.c4_id) && !duplicate
      ? this.sender._status(this._group(answer), row.c4_id)
      : stored || row.state === 'unknown' || row.state === 'sending' ? 'pending_reconciliation' : null;
    return { answerId: answer.answerId, questionC4Id: answer.questionC4Id,
      sessionGroup: answer.sessionGroup, channel: 'dashboard', endpointId: answer.endpointId,
      accepted: true, stored, messageId: validId(row.c4_id), deliveryState,
      needsReconciliation: duplicate || row.state === 'unknown' || row.state === 'sending' || deliveryState === 'pending_reconciliation',
      retryAllowed: row.state === 'not_stored' && !this.inflight.has(answer.answerId),
      ...(row.error ? { error: row.error } : {}) };
  }

  /** Snapshot only; opens/refreshes use reconcile rather than inferring no-store. */
  receipt(answerId) {
    return this._receipt(this.answers.get(answerId), this._delivery(answerId));
  }

  _scan(answer) {
    const db = this.c4Reader._open();
    if (!db) throw fail('chat_core_unavailable', 502);
    this.sender._binding(this._group(answer));
    const query = db.prepare(`SELECT id,direction,status,delivery_action,content FROM conversations INDEXED BY idx_conv_group_id
      WHERE session_group=@group AND channel='dashboard' AND direction='in' AND endpoint_id=@endpoint
      AND id>@after ORDER BY id LIMIT 100`);
    let after = 0, match = null;
    // Memory stays bounded to one indexed group page and one candidate. Stop
    // immediately at the second exact match; duplicate evidence is not hidden.
    while (true) {
      const rows = query.all({ group: answer.sessionGroup, endpoint: answer.endpointId, after });
      for (const row of rows) {
        const parsed = parseC4Content(row.content);
        if (parsed.kind !== 'envelope' || parsed.envelope.kind !== 'answer'
          || parsed.envelope.metadata.zylos.answerId !== answer.answerId) continue;
        if (match) return { duplicate: true };
        match = row;
      }
      if (rows.length < 100) return { match };
      after = rows.at(-1).id;
    }
  }

  _reconcile(answer, { owned = false } = {}) {
    let row = this._delivery(answer.answerId);
    if ((!owned && this.inflight.has(answer.answerId)) ||
        (row.state === 'committed' && validId(row.c4_id) && !ambiguous(row.error))) return this._receipt(answer, row);
    try {
      const found = this._scan(answer);
      if (found.duplicate) {
        row = this._save(answer.answerId, { state: row.state === 'committed' ? 'committed' : 'unknown',
          id: row.c4_id, error: 'chat_answer_duplicate' });
      } else if (found.match) {
        row = this._save(answer.answerId, { state: 'committed', id: validId(found.match.id) });
      } else if (row.state !== 'committed') {
        row = this._save(answer.answerId, { state: 'not_stored', error: ambiguous(row.error) ? null : row.error });
      }
    } catch (error) {
      // Lookup failure cannot prove absence, including after a service restart.
      row = this._save(answer.answerId, { state: row.state === 'committed' ? 'committed' : 'unknown',
        id: row.c4_id, error: 'chat_answer_lookup_failed' });
    }
    return this._receipt(answer, row);
  }

  async reconcile(answerId) {
    return this._reconcile(this.answers.get(answerId));
  }

  async deliver(answerId, { initial = false, retry = false, authorize } = {}) {
    if (typeof initial !== 'boolean' || typeof retry !== 'boolean') throw fail('invalid_chat_answer_retry');
    const answer = this.answers.get(answerId), before = this._delivery(answerId);
    if (this.inflight.has(answerId)) return this._receipt(answer, before);
    // Only the newly accepted pending record is eligible for its first call.
    const first = initial && before.state === 'pending';
    this.inflight.set(answerId, true);
    try {
      const checked = this._reconcile(answer, { owned: true });
      if (checked.stored === true || checked.needsReconciliation || (!first && !retry)) return checked;
      const core = await this.sender.loadCore();
      const denied = await authorize?.(answer);
      if (denied) throw fail(denied.error || 'chat_answer_forbidden', denied.status || 403);
      const group = this._group(answer);
      this.sender._binding(group);
      this._save(answerId, { state: 'sending' });
      let result, failure;
      try {
        // The fixed address is never sent with a session group; Core refuses one.
        result = await core.receive(['--channel', 'dashboard', '--endpoint', answer.endpointId,
          ...(isOriginRecord(group.namespace, group.localId) ? [] : ['--session-group', group.localId]),
          '--content', answer.content]);
      } catch (error) { failure = error; }
      finally { this.inflight.delete(answerId); }
      const outcome = classifyReceiveResult(result, failure, core.isDataError ?? isDataError);
      this._save(answerId, { state: outcome.kind, id: outcome.id, error: outcome.error });
      return outcome.kind === 'unknown' || (outcome.kind === 'committed' && outcome.id === null)
        ? this._reconcile(answer) : this.receipt(answerId);
    } finally { this.inflight.delete(answerId); }
  }

  async reconcileGroup(sessionGroup, { limit = 100, afterAnswerId = '' } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || typeof afterAnswerId !== 'string') throw fail('invalid_chat_limit');
    const rows = this.db.prepare(`SELECT d.answer_id FROM chat_answer_deliveries d
      JOIN chat_answers a ON a.answer_id=d.answer_id WHERE a.session_group=? AND ${unresolved}
      AND d.answer_id>? ORDER BY d.answer_id LIMIT ?`).all(sessionGroup, afterAnswerId, limit + 1);
    const page = rows.slice(0, limit), items = [];
    for (const row of page) items.push(await this.reconcile(row.answer_id));
    return { items, nextCursor: rows.length > limit ? page.at(-1).answer_id : null };
  }

  async recover() {
    let after = '', checked = 0, pending = 0;
    while (true) {
      const rows = this.db.prepare(`SELECT d.answer_id FROM chat_answer_deliveries d WHERE ${unresolved}
        AND d.answer_id>? ORDER BY d.answer_id LIMIT 100`).all(after);
      for (const row of rows) {
        if (this.inflight.has(row.answer_id)) { pending++; continue; }
        const receipt = await this.reconcile(row.answer_id);
        checked++;
        if (receipt.needsReconciliation) pending++;
      }
      if (rows.length < 100) return { checked, pending };
      after = rows.at(-1).answer_id;
    }
  }
}
