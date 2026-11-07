import { CONTENT_PREFIX, parseC4Content, validateAnswer, validateFormFields } from '../../../../comm-bridge/scripts/c4-content-schema.js';

const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const canonicalId = group => `g:${Buffer.from(group).toString('hex').toUpperCase()}`;
const stable = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});
const storedAction = value => {
  try {
    const action = JSON.parse(value);
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('Invalid saved action');
    return { action };
  } catch {
    return { actionError: 'chat_answer_action_invalid' };
  }
};
const projectAnswer = row => ({ answerId: row.answer_id, questionC4Id: row.question_c4_id,
  sessionGroup: row.session_group, endpointId: row.endpoint_id, content: row.content,
  ...storedAction(row.action), createdAt: row.created_at });

const questionSelect = `SELECT q.c4_id, q.session_group, q.endpoint_id, q.message_id,
  q.interrupt_id, q.question_summary, q.constraints, q.status, q.created_at,
  a.answer_id, c.operation AS control_operation, c.replacement_interrupt_id,
  c.control_message_id FROM chat_questions q
  LEFT JOIN chat_answers a ON a.question_c4_id=q.c4_id
  LEFT JOIN chat_question_controls c ON c.question_c4_id=q.c4_id`;
const questionPageSelect = `SELECT CAST(q.c4_id AS TEXT) AS c4Id,
  q.message_id AS messageId, q.interrupt_id AS interruptId,
  q.question_summary AS questionSummary, q.constraints, q.status,
  a.answer_id AS answerId FROM chat_questions q
  LEFT JOIN chat_answers a ON a.question_c4_id=q.c4_id`;

/** The question-page contract is independent of storage and delivery columns. */
export function projectQuestion(item, { action = null, actionError = null, delivery = null } = {}) {
  let constraints, questionError;
  try {
    constraints = typeof item.constraints === 'string' ? JSON.parse(item.constraints) : item.constraints;
    if (!constraints || typeof constraints !== 'object' || Array.isArray(constraints)) throw new Error('Invalid constraints');
  } catch {
    constraints = null;
    questionError = 'chat_question_unavailable';
  }
  return { c4Id: String(item.c4Id), messageId: item.messageId, interruptId: item.interruptId,
    questionSummary: item.questionSummary, constraints, status: item.status, answerId: item.answerId ?? null,
    action, actionError, delivery, ...(questionError ? { questionError } : {}) };
}

function savedEnvelope(question) {
  let constraints;
  try { constraints = JSON.parse(question.constraints); } catch { throw fail('chat_question_unavailable', 409); }
  const envelope = { version: 1, kind: 'message', messageId: question.message_id,
    fallbackText: question.question_summary, blocks: [constraints?.block],
    interruptId: question.interrupt_id, questionSummary: question.question_summary,
    interrupt: constraints?.interrupt };
  if (parseC4Content(CONTENT_PREFIX + JSON.stringify(envelope)).kind !== 'envelope') {
    throw fail('chat_question_unavailable', 409);
  }
  return envelope;
}

function answerEnvelope(question, action, fallbackText) {
  return { version: 1, kind: 'answer', messageId: action.id, fallbackText,
    interruptId: question.interrupt_id, questionSummary: question.question_summary, action,
    metadata: { zylos: { answerId: action.id } } };
}

function fieldErrors(question, envelope, action) {
  const block = envelope.blocks[0], data = block.data;
  if (question.status !== 'paused' || block.type !== 'form_intent' || block.schemaVersion !== 2
      || (data.state?.status ?? 'open') !== 'open' || !action || typeof action !== 'object') return null;
  // Validate the original closed Action shape through the existing parser.
  // The provisional fallback uses only the authoritative saved summary.
  let parsed;
  try { parsed = parseC4Content(CONTENT_PREFIX + JSON.stringify(answerEnvelope(question, action, question.question_summary))); }
  catch { return null; }
  if (parsed.kind !== 'envelope'
      || action.context.messageId !== envelope.messageId || action.context.blockId !== block.id
      || action.type !== data.action.type || action.target !== data.action.target
      || (action.context.conversationId !== undefined && action.context.conversationId !== canonicalId(question.session_group))
      || !Object.hasOwn(action.payload, 'values')) return null;
  const result = validateFormFields(data.fields, action.payload.values);
  return !result.formError && result.errors.length ? result.errors : null;
}

function readableAnswer(action, block) {
  const payload = action.payload, data = block.data;
  if (Object.hasOwn(payload, 'freeText')) return payload.freeText;
  if (block.type === 'choice') {
    return payload.selected.map(selected => data.options.find(option => option.id === selected).label).join('、');
  }
  if (block.type === 'confirmation') {
    return payload.outcome === 'confirm' ? data.confirmLabel || '确认' : data.cancelLabel || '取消';
  }
  return data.fields.filter(field => Object.hasOwn(payload.values, field.key)).map(field => {
    const value = payload.values[field.key];
    const label = selected => field.options.find(option => option.id === selected).label;
    const rendered = value == null ? '未填写' : field.type === 'single_select' ? label(value)
      : field.type === 'multi_select' ? value.map(label).join('、')
        : field.type === 'boolean' ? value ? '是' : '否' : String(value);
    return `${field.label}：${rendered}`;
  }).join('；') || '未填写可选字段';
}

/** Conditional answer acceptance and its unfinished delivery commit together. */
export class ChatAnswers {
  constructor({ store, now = Date.now }) {
    this.store = store;
    this.db = store.db;
    this.now = now;
  }

  get(answerId) {
    const row = this.db.prepare('SELECT * FROM chat_answers WHERE answer_id=?').get(answerId);
    if (!row) throw fail('chat_answer_not_found', 404);
    return projectAnswer(row);
  }

  question(sessionGroup, interruptId) {
    const row = this.db.prepare(`${questionSelect} WHERE q.session_group=? AND q.interrupt_id=?`).get(sessionGroup, interruptId);
    if (!row) throw fail('chat_question_not_found', 404);
    return row;
  }

  listQuestions(sessionGroup, { limit = 50, cursor = null } = {}) {
    if (typeof limit === 'string' && /^[1-9][0-9]{0,2}$/.test(limit)) limit = Number(limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor !== null && (typeof cursor !== 'string' || cursor.length > 128))) {
      throw fail('invalid_chat_question_page');
    }
    const rows = this.db.prepare(`${questionPageSelect}
      WHERE q.session_group=@sessionGroup AND (@cursor IS NULL OR q.interrupt_id > @cursor)
      ORDER BY q.interrupt_id LIMIT @limit`).all({ sessionGroup, cursor, limit: limit + 1 });
    const items = rows.slice(0, limit).map(item => projectQuestion(item));
    return { items, nextCursor: rows.length > limit ? items.at(-1).interruptId : null };
  }

  accept({ sessionGroup, endpointId, interruptId, action }) {
    return this.db.transaction(() => {
      const question = this.question(sessionGroup, interruptId);
      if (question.endpoint_id !== endpointId) throw fail('chat_question_forbidden', 403);
      const envelope = savedEnvelope(question);
      if (!validateAnswer(action, envelope) || (action.context.conversationId !== undefined
          && action.context.conversationId !== canonicalId(sessionGroup))) {
        const error = fail('invalid_chat_answer'), fields = fieldErrors(question, envelope, action);
        if (fields) error.fields = fields;
        throw error;
      }
      const previous = this.db.prepare('SELECT * FROM chat_answers WHERE answer_id=?').get(action.id);
      if (previous) {
        if (previous.question_c4_id !== question.c4_id || previous.session_group !== sessionGroup
            || previous.endpoint_id !== endpointId || previous.action !== stable(action)) {
          throw fail('chat_answer_conflict', 409);
        }
        return { answer: projectAnswer(previous), created: false };
      }
      if (question.status !== 'paused') throw fail('chat_question_not_paused', 409);
      const content = CONTENT_PREFIX + JSON.stringify(answerEnvelope(question, action,
        `回答了 interruptId=${question.interrupt_id}（问题：${question.question_summary}）：${readableAnswer(action, envelope.blocks[0])}`));
      if (parseC4Content(content).kind !== 'envelope') throw fail('invalid_chat_answer');
      const changed = this.db.prepare("UPDATE chat_questions SET status='answered' WHERE c4_id=? AND status='paused'").run(question.c4_id);
      if (changed.changes !== 1) throw fail('chat_question_not_paused', 409);
      const now = this.now();
      this.db.prepare(`INSERT INTO chat_answers
        (answer_id,question_c4_id,session_group,endpoint_id,content,action,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(action.id, question.c4_id, sessionGroup, endpointId, content, stable(action), now);
      this.db.prepare('INSERT INTO chat_answer_deliveries(answer_id,state,updated_at) VALUES(?,?,?)')
        .run(action.id, 'pending', now);
      return { answer: this.get(action.id), created: true };
    }).immediate();
  }

  /** Apply only explicit, validated lifecycle metadata to a registered question. */
  control({ sessionGroup, endpointId, envelope }) {
    const parsed = parseC4Content(CONTENT_PREFIX + JSON.stringify(envelope));
    if (parsed.kind !== 'envelope' || parsed.envelope.kind !== 'control') throw fail('invalid_chat_control');
    return this.db.transaction(() => {
      const question = this.question(sessionGroup, envelope.interruptId), control = envelope.control;
      if (question.endpoint_id !== endpointId || question.message_id !== control.messageId) {
        throw fail('chat_question_forbidden', 403);
      }
      savedEnvelope(question);
      if (question.control_operation) {
        if (question.control_operation !== control.operation
            || question.replacement_interrupt_id !== (control.replacementInterruptId ?? null)) {
          throw fail('chat_question_not_paused', 409);
        }
        return question;
      }
      if (question.status !== 'paused') throw fail('chat_question_not_paused', 409);
      if (control.operation === 'replace') {
        if (control.replacementInterruptId === question.interrupt_id) throw fail('invalid_chat_control');
        const replacement = this.question(sessionGroup, control.replacementInterruptId);
        if (replacement.endpoint_id !== endpointId || replacement.status !== 'paused') throw fail('chat_question_not_paused', 409);
        savedEnvelope(replacement);
      }
      const status = control.operation === 'stop' ? 'stopped' : 'superseded';
      const changed = this.db.prepare("UPDATE chat_questions SET status=? WHERE c4_id=? AND status='paused'").run(status, question.c4_id);
      if (changed.changes !== 1) throw fail('chat_question_not_paused', 409);
      this.db.prepare(`INSERT INTO chat_question_controls
        (question_c4_id,operation,replacement_interrupt_id,control_message_id,created_at) VALUES(?,?,?,?,?)`)
        .run(question.c4_id, control.operation, control.replacementInterruptId ?? null, envelope.messageId, this.now());
      return this.question(sessionGroup, envelope.interruptId);
    }).immediate();
  }
}
