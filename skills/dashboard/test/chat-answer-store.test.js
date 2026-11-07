import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/lib/store.js';
import { ChatAnswers } from '../src/lib/chat/answers.js';
import { dashboardSchemaOwner as owner } from '../src/lib/schema-owner.js';
import { TARGET_SCHEMA_VERSION } from '../src/lib/schema.js';
import { CONTENT_PREFIX, parseC4Content } from '../../comm-bridge/scripts/c4-content-schema.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const example = name => structuredClone(fixtures.valid.find(item => item.name === name).envelope);
const questionKeys = ['c4Id', 'messageId', 'interruptId', 'questionSummary', 'constraints', 'status', 'answerId', 'action', 'actionError', 'delivery'].sort();
const canonical = group => `g:${Buffer.from(group).toString('hex').toUpperCase()}`;

// Real Dashboard Store + U validation, private fixture database only. Run for
// answer acceptance, conditional transaction, lifecycle or migration changes;
// unrelated UI changes may skip. No C4, child, listener, PM2, tmux or network.
// Every connection closes before this case's own directory is removed.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-answer-store-'));
  const file = path.join(root, 'dashboard.db');
  const store = new Store(file), answers = new ChatAnswers({ store, now: () => 1000 });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let nextId = 1;
  function question(name = 'single', { group = 'dashboard:mine', endpoint = 'mine', interruptId } = {}) {
    const envelope = example(name);
    if (interruptId) envelope.interruptId = interruptId;
    const id = String(nextId++), block = envelope.blocks.find(item => item.id === envelope.interrupt.blockId);
    store.db.prepare(`INSERT INTO chat_questions
      (c4_id,session_group,endpoint_id,message_id,interrupt_id,question_summary,constraints)
      VALUES(?,?,?,?,?,?,?)`).run(id, group, endpoint, envelope.messageId, envelope.interruptId,
      envelope.questionSummary, JSON.stringify({ block, interrupt: envelope.interrupt }));
    return { envelope, id, group, endpoint };
  }
  function action(q, payload, id = 'answer_action_01') {
    const block = q.envelope.blocks.find(item => item.id === q.envelope.interrupt.blockId);
    return { id, protocolVersion: '0.1', type: block.data.action.type, target: block.data.action.target,
      context: { messageId: q.envelope.messageId, blockId: block.id, conversationId: canonical(q.group) }, payload };
  }
  const accept = (q, request) => answers.accept({ sessionGroup: q.group, endpointId: q.endpoint,
    interruptId: q.envelope.interruptId, action: request });
  const count = table => store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  return { store, answers, file, question, action, accept, count };
}

for (const name of ['single', 'multiple', 'confirmation', 'form']) {
  test(`accepting a ${name} answer saves the host summary and unfinished delivery atomically`, t => {
    const f = fixture(t), q = f.question(name), block = q.envelope.blocks.find(item => item.id === q.envelope.interrupt.blockId);
    const payload = name === 'single' ? { selected: [block.data.options[0].id] }
      : name === 'multiple' ? { selected: block.data.options.slice(0, 2).map(option => option.id) }
        : name === 'confirmation' ? { outcome: 'cancel' }
          : { values: Object.fromEntries(block.data.fields.map(field => [field.key, field.defaultValue ??
            (field.type === 'integer' || field.type === 'number' ? field.min ?? 1 : field.type === 'boolean' ? true
              : field.type === 'single_select' ? field.options[0].id : field.type === 'multi_select' ? [field.options[0].id]
                : field.type === 'date' ? '2026-01-01' : field.type === 'datetime' ? '2026-01-01T00:00:00Z' : 'Saved value')])) };
    const action = f.action(q, payload), accepted = f.accept(q, action);
    assert.equal(accepted.created, true);
    assert.equal(f.answers.question(q.group, q.envelope.interruptId).status, 'answered');
    const content = parseC4Content(accepted.answer.content);
    assert.equal(content.kind, 'envelope');
    assert.equal(content.envelope.questionSummary, q.envelope.questionSummary);
    assert.equal(content.envelope.metadata.zylos.answerId, action.id);
    assert.ok(content.envelope.fallbackText.startsWith(`回答了 interruptId=${q.envelope.interruptId}（问题：${q.envelope.questionSummary}）：`));
    if (name === 'confirmation') assert.match(content.envelope.fallbackText, /取消/);
    const delivery = f.store.db.prepare('SELECT * FROM chat_answer_deliveries WHERE answer_id=?').get(action.id);
    assert.equal(delivery.state, 'pending'); assert.equal(delivery.c4_id, null);
    assert.equal(accepted.answer.sessionGroup, q.group); assert.equal(accepted.answer.endpointId, q.endpoint);
    assert.equal(f.count('chat_answers'), 1); assert.equal(f.count('chat_answer_deliveries'), 1);
  });
}

test('free text is an explicit validated answer and is never guessed from ordinary messages', t => {
  const f = fixture(t), q = f.question(), action = f.action(q, { freeText: 'Neither option; keep the saved question context' });
  const accepted = f.accept(q, action);
  assert.match(accepted.answer.content, /Neither option/);
  const q2 = f.question('single', { interruptId: 'other_question' });
  assert.equal(f.answers.question(q2.group, q2.envelope.interruptId).status, 'paused');
  assert.equal(f.count('chat_answers'), 1);
});

test('same action reuses the saved answer while different answers and altered intent cannot overwrite it', async t => {
  const f = fixture(t), q = f.question(), block = q.envelope.blocks[0];
  const first = f.action(q, { selected: [block.data.options[0].id] });
  const second = f.action(q, { selected: [block.data.options[1].id] }, 'answer_action_02');
  const results = await Promise.allSettled([Promise.resolve().then(() => f.accept(q, first)), Promise.resolve().then(() => f.accept(q, second))]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  const duplicate = f.accept(q, first);
  assert.equal(duplicate.created, false); assert.equal(duplicate.answer.answerId, first.id);
  assert.throws(() => f.accept(q, { ...second, id: first.id }), { code: 'chat_answer_conflict' });
  const reordered = { payload: first.payload, context: first.context, target: first.target,
    type: first.type, protocolVersion: first.protocolVersion, id: first.id };
  assert.equal(f.accept(q, reordered).created, false);
  assert.equal(f.count('chat_answers'), 1); assert.equal(f.count('chat_answer_deliveries'), 1);
});

test('failed unfinished-delivery insertion rolls answer acceptance and question state back together', t => {
  const f = fixture(t), q = f.question(), action = f.action(q, { selected: [q.envelope.blocks[0].data.options[0].id] });
  f.store.db.exec("CREATE TRIGGER fail_answer_delivery BEFORE INSERT ON chat_answer_deliveries BEGIN SELECT RAISE(ABORT,'fixture delivery rejected'); END");
  assert.throws(() => f.accept(q, action), /fixture delivery rejected/);
  assert.equal(f.answers.question(q.group, q.envelope.interruptId).status, 'paused');
  assert.equal(f.count('chat_answers'), 0); assert.equal(f.count('chat_answer_deliveries'), 0);
  assert.equal(f.store.db.inTransaction, false);
});

for (const invalid of ['unknown-option', 'wrong-message', 'wrong-group', 'wrong-endpoint', 'not-paused', 'missing-constraints', 'bad-summary']) {
  test(`answer acceptance rejects ${invalid} without saving an answer or delivery`, t => {
    const f = fixture(t), q = f.question();
    const action = f.action(q, { selected: [q.envelope.blocks[0].data.options[0].id] });
    if (invalid === 'unknown-option') action.payload.selected = ['unknown'];
    if (invalid === 'wrong-message') action.context.messageId = 'other_message';
    if (invalid === 'wrong-group') action.context.conversationId = canonical('dashboard:other');
    if (invalid === 'wrong-endpoint') q.endpoint = 'other';
    if (invalid === 'not-paused') f.store.db.prepare("UPDATE chat_questions SET status='stopped' WHERE c4_id=?").run(q.id);
    if (invalid === 'missing-constraints') f.store.db.prepare('UPDATE chat_questions SET constraints=? WHERE c4_id=?').run('{}', q.id);
    if (invalid === 'bad-summary') f.store.db.prepare('UPDATE chat_questions SET question_summary=? WHERE c4_id=?').run('forged summary', q.id);
    assert.throws(() => f.accept(q, action));
    assert.equal(f.count('chat_answers'), 0); assert.equal(f.count('chat_answer_deliveries'), 0);
  });
}

for (const [name, payload] of [
  ['single', { selected: ['a', 'b'] }],
  ['multiple', { selected: ['a', 'b', 'c'] }],
  ['confirmation', { outcome: 'stop' }],
  ['form', { values: {} }],
  ['form', { values: { name: 'valid', count: 6 } }],
  ['form', { values: { name: 'valid', unknown: 'field' } }],
  ['form', { values: { name: 'valid', tags: ['unknown'] } }],
]) test(`saved ${name} constraints reject an invalid submitted payload ${JSON.stringify(payload)}`, t => {
  const f = fixture(t), q = f.question(name);
  assert.throws(() => f.accept(q, f.action(q, payload)), { code: 'invalid_chat_answer' });
  assert.equal(f.count('chat_answers'), 0); assert.equal(f.count('chat_answer_deliveries'), 0);
  assert.equal(f.answers.question(q.group, q.envelope.interruptId).status, 'paused');
});

test('saved other-input prohibition rejects free text rather than treating it as a new chat message', t => {
  const f = fixture(t), q = f.question();
  const constraints = JSON.parse(f.answers.question(q.group, q.envelope.interruptId).constraints);
  constraints.interrupt.otherInput = false;
  f.store.db.prepare('UPDATE chat_questions SET constraints=? WHERE c4_id=?').run(JSON.stringify(constraints), q.id);
  assert.throws(() => f.accept(q, f.action(q, { freeText: 'unavailable input' })), { code: 'invalid_chat_answer' });
  assert.equal(f.count('chat_answers'), 0); assert.equal(f.count('chat_answer_deliveries'), 0);
});

test('unknown and cross-group questions cannot be answered through another original group', t => {
  const f = fixture(t), q = f.question(), action = f.action(q, { selected: [q.envelope.blocks[0].data.options[0].id] });
  assert.throws(() => f.answers.accept({ sessionGroup: 'dashboard:other', endpointId: 'other', interruptId: q.envelope.interruptId, action }), { code: 'chat_question_not_found' });
  assert.throws(() => f.answers.accept({ sessionGroup: q.group, endpointId: q.endpoint, interruptId: 'missing_question', action }), { code: 'chat_question_not_found' });
  assert.equal(f.count('chat_answers'), 0);
});

function control(q, operation, replacementInterruptId) {
  return { version: 1, kind: 'control', messageId: `control_${operation}`, fallbackText: `Explicit ${operation}`,
    interruptId: q.envelope.interruptId, control: { operation, messageId: q.envelope.messageId,
      ...(replacementInterruptId ? { replacementInterruptId } : {}) } };
}

test('explicit stop closes a paused question without creating a cancel answer', t => {
  const f = fixture(t), q = f.question('confirmation'), envelope = control(q, 'stop');
  const stopped = f.answers.control({ sessionGroup: q.group, endpointId: q.endpoint, envelope });
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.control_operation, 'stop');
  assert.equal(f.count('chat_answers'), 0); assert.equal(f.count('chat_answer_deliveries'), 0);
  assert.equal(f.answers.control({ sessionGroup: q.group, endpointId: q.endpoint, envelope }).status, 'stopped');
  assert.equal(f.count('chat_question_controls'), 1);
  assert.throws(() => f.accept(q, f.action(q, { outcome: 'cancel' })), { code: 'chat_question_not_paused' });
});

test('explicit replacement requires a separately registered paused question in the same group', t => {
  const f = fixture(t), old = f.question(), replacement = f.question('single', { interruptId: 'replacement_question' });
  const envelope = control(old, 'replace', replacement.envelope.interruptId);
  const replaced = f.answers.control({ sessionGroup: old.group, endpointId: old.endpoint, envelope });
  assert.equal(replaced.status, 'superseded');
  assert.equal(replaced.replacement_interrupt_id, replacement.envelope.interruptId);
  assert.equal(f.answers.question(replacement.group, replacement.envelope.interruptId).status, 'paused');
  assert.equal(f.count('chat_answers'), 0);
});

test('an accepted confirmation answer cannot be changed into a stopped question', t => {
  const f = fixture(t), q = f.question('confirmation');
  const accepted = f.accept(q, f.action(q, { outcome: 'cancel' }));
  const before = f.answers.question(q.group, q.envelope.interruptId);
  assert.throws(() => f.answers.control({ sessionGroup: q.group, endpointId: q.endpoint,
    envelope: control(q, 'stop') }), { code: 'chat_question_not_paused', statusCode: 409 });
  assert.deepEqual(f.answers.question(q.group, q.envelope.interruptId), before);
  assert.equal(f.answers.question(q.group, q.envelope.interruptId).status, 'answered');
  assert.equal(f.answers.get(accepted.answer.answerId).answerId, accepted.answer.answerId);
  assert.equal(f.count('chat_answers'), 1); assert.equal(f.count('chat_answer_deliveries'), 1);
  assert.equal(f.count('chat_question_controls'), 0);
});

for (const status of ['answered', 'stopped', 'superseded']) {
  test(`a ${status} question cannot be selected as a replacement`, t => {
    const f = fixture(t), old = f.question(), candidate = f.question('single', { interruptId: 'replacement_candidate' });
    if (status === 'answered') {
      f.accept(candidate, f.action(candidate, { selected: [candidate.envelope.blocks[0].data.options[0].id] }));
    } else if (status === 'stopped') {
      f.answers.control({ sessionGroup: candidate.group, endpointId: candidate.endpoint, envelope: control(candidate, 'stop') });
    } else {
      const next = f.question('single', { interruptId: 'next_replacement' });
      f.answers.control({ sessionGroup: candidate.group, endpointId: candidate.endpoint,
        envelope: control(candidate, 'replace', next.envelope.interruptId) });
    }
    const beforeOld = f.answers.question(old.group, old.envelope.interruptId);
    const beforeCandidate = f.answers.question(candidate.group, candidate.envelope.interruptId);
    const controls = f.count('chat_question_controls');
    assert.equal(beforeCandidate.status, status);
    assert.throws(() => f.answers.control({ sessionGroup: old.group, endpointId: old.endpoint,
      envelope: control(old, 'replace', candidate.envelope.interruptId) }), { code: 'chat_question_not_paused', statusCode: 409 });
    assert.deepEqual(f.answers.question(old.group, old.envelope.interruptId), beforeOld);
    assert.deepEqual(f.answers.question(candidate.group, candidate.envelope.interruptId), beforeCandidate);
    assert.equal(f.count('chat_question_controls'), controls);
  });
}

for (const conflict of ['replace after stop', 'stop after replace', 'different replacement']) {
  test(`a conflicting second lifecycle control rejects ${conflict} without changing the saved control`, t => {
    const f = fixture(t), old = f.question();
    const replacement = f.question('single', { interruptId: 'replacement_question' });
    const other = f.question('single', { interruptId: 'other_replacement' });
    const first = conflict === 'replace after stop' ? control(old, 'stop')
      : control(old, 'replace', replacement.envelope.interruptId);
    f.answers.control({ sessionGroup: old.group, endpointId: old.endpoint, envelope: first });
    const before = f.answers.question(old.group, old.envelope.interruptId);
    const storedControl = f.store.db.prepare('SELECT * FROM chat_question_controls WHERE question_c4_id=?').get(old.id);
    const second = conflict === 'stop after replace' ? control(old, 'stop')
      : control(old, 'replace', conflict === 'different replacement' ? other.envelope.interruptId : replacement.envelope.interruptId);
    assert.throws(() => f.answers.control({ sessionGroup: old.group, endpointId: old.endpoint,
      envelope: second }), { code: 'chat_question_not_paused', statusCode: 409 });
    assert.deepEqual(f.answers.question(old.group, old.envelope.interruptId), before);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM chat_question_controls WHERE question_c4_id=?').get(old.id), storedControl);
    assert.equal(f.count('chat_question_controls'), 1); assert.equal(f.count('chat_answers'), 0);
    assert.equal(f.answers.question(replacement.group, replacement.envelope.interruptId).status, 'paused');
    assert.equal(f.answers.question(other.group, other.envelope.interruptId).status, 'paused');
  });
}

for (const invalid of ['plain-text', 'unknown-replacement', 'cross-group-replacement', 'wrong-message']) {
  test(`lifecycle rejects ${invalid} and leaves the old question paused`, t => {
    const f = fixture(t), q = f.question();
    let envelope = control(q, 'stop');
    if (invalid === 'plain-text') envelope = { message: 'stop' };
    if (invalid === 'unknown-replacement') envelope = control(q, 'replace', 'missing_question');
    if (invalid === 'cross-group-replacement') {
      f.question('single', { group: 'dashboard:other', endpoint: 'other', interruptId: 'other_question' });
      envelope = control(q, 'replace', 'other_question');
    }
    if (invalid === 'wrong-message') envelope.control.messageId = 'other_message';
    assert.throws(() => f.answers.control({ sessionGroup: q.group, endpointId: q.endpoint, envelope }));
    assert.equal(f.answers.question(q.group, q.envelope.interruptId).status, 'paused');
    assert.equal(f.count('chat_question_controls'), 0);
  });
}

test('question pages are bounded, group scoped and preserve answered and stopped overlays after reopen', t => {
  const f = fixture(t), q = f.question('single', { interruptId: 'a_question' });
  const stopped = f.question('single', { interruptId: 'b_question' });
  f.question('single', { interruptId: 'c_question' });
  f.question('single', { group: 'dashboard:other', endpoint: 'other', interruptId: 'other_question' });
  f.accept(q, f.action(q, { selected: [q.envelope.blocks[0].data.options[0].id] }));
  f.answers.control({ sessionGroup: stopped.group, endpointId: stopped.endpoint, envelope: control(stopped, 'stop') });
  const first = f.answers.listQuestions(q.group, { limit: 1 });
  assert.equal(first.items.length, 1); assert.equal(first.items[0].status, 'answered');
  assert.deepEqual(Object.keys(first.items[0]).sort(), questionKeys);
  assert.equal(first.items[0].answerId, 'answer_action_01');
  assert.equal(first.items[0].c4Id, q.id);
  assert.deepEqual(first.items[0].constraints, { block: q.envelope.blocks[0], interrupt: q.envelope.interrupt });
  assert.equal(first.nextCursor, 'a_question');
  const second = f.answers.listQuestions(q.group, { limit: 1, cursor: first.nextCursor });
  assert.equal(second.items.length, 1); assert.equal(second.items[0].status, 'stopped');
  const last = f.answers.listQuestions(q.group, { limit: 1, cursor: second.nextCursor });
  assert.equal(last.items.length, 1); assert.equal(last.items[0].interruptId, 'c_question'); assert.equal(last.nextCursor, null);
  const reopened = new Store(f.file);
  try {
    const answers = new ChatAnswers({ store: reopened });
    assert.equal(answers.question(q.group, q.envelope.interruptId).answer_id, 'answer_action_01');
    assert.equal(answers.question(stopped.group, stopped.envelope.interruptId).control_operation, 'stop');
  } finally { reopened.close(); }
});


test('question pages continue after the last item without repeating questions', t => {
  const f = fixture(t);
  for (const interruptId of ['c_question', 'a_question', 'b_question']) {
    f.question('single', { interruptId });
  }
  const first = f.answers.listQuestions('dashboard:mine', { limit: 2 });
  assert.deepEqual(first.items.map(item => item.interruptId), ['a_question', 'b_question']);
  assert.equal(first.nextCursor, first.items[1].interruptId);
  const second = f.answers.listQuestions('dashboard:mine', { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(item => item.interruptId), ['c_question']);
  assert.equal(second.nextCursor, null);
});

test('question projection preserves large IDs and isolates malformed constraints without changing cursors', t => {
  const f = fixture(t), bad = f.question('single', { interruptId: 'a_question' });
  const good = f.question('single', { interruptId: 'b_question' });
  const largeId = '9223372036854775807';
  f.store.db.prepare('UPDATE chat_questions SET c4_id=? WHERE c4_id=?').run(largeId, good.id);
  f.store.db.prepare('UPDATE chat_questions SET constraints=? WHERE c4_id=?').run('{broken', bad.id);
  const first = f.answers.listQuestions(bad.group, { limit: 1 });
  assert.equal(first.items.length, 1);
  assert.deepEqual(Object.keys(first.items[0]).sort(), [...questionKeys, 'questionError'].sort());
  assert.equal(first.items[0].questionError, 'chat_question_unavailable');
  assert.equal(first.items[0].constraints, null);
  assert.equal(first.nextCursor, 'a_question');
  const next = f.answers.listQuestions(good.group, { limit: 1, cursor: first.nextCursor });
  assert.equal(next.items.length, 1);
  assert.deepEqual(Object.keys(next.items[0]).sort(), questionKeys);
  assert.equal(typeof next.items[0].c4Id, 'string');
  assert.equal(next.items[0].c4Id, largeId);
  assert.equal(next.items[0].interruptId, good.envelope.interruptId);
  assert.deepEqual(next.items[0].constraints, { block: good.envelope.blocks[0], interrupt: good.envelope.interrupt });
  assert.equal(next.items[0].answerId, null);
  for (const field of ['action', 'actionError', 'delivery']) assert.equal(next.items[0][field], null);
  assert.equal(next.nextCursor, null);
});

// Migration fixture removes only this additive schema's tables and version,
// recreating the previous layout without changing runtime source. Run whenever
// the answer storage layout changes; unrelated UI work may skip.
test('answer schema upgrades the prior draft layout without changing questions, drafts, names or user tables', t => {
  const f = fixture(t), q = f.question();
  f.store.db.exec(`INSERT INTO chat_conversations(local_id,display_name,created_at,updated_at) VALUES('retained','Draft',1,1);
    INSERT INTO group_display_names(session_group,display_name,source) VALUES('dashboard:mine','Human title','human');
    CREATE TABLE user_answer_notes(note TEXT); INSERT INTO user_answer_notes VALUES('retained');
    DROP TABLE chat_answer_deliveries; DROP TABLE chat_answers; DROP TABLE chat_question_controls;
    DELETE FROM schema_migrations WHERE version>=25;`);
  const before = f.store.db.prepare('SELECT * FROM chat_questions WHERE c4_id=?').get(q.id);
  assert.equal(owner.inspectSchema(f.store.db).currentVersion, 24);
  assert.equal(owner.migrate(f.store.db).currentVersion, TARGET_SCHEMA_VERSION);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM chat_questions WHERE c4_id=?').get(q.id), before);
  assert.equal(f.store.db.prepare('SELECT display_name FROM chat_conversations').get().display_name, 'Draft');
  assert.equal(f.store.db.prepare('SELECT display_name FROM group_display_names').get().display_name, 'Human title');
  assert.equal(f.store.db.prepare('SELECT note FROM user_answer_notes').get().note, 'retained');
  owner.migrate(f.store.db);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM schema_migrations WHERE version=25').get().n, 1);
});

test('a failed answer table migration retains the prior version and existing question records', t => {
  const f = fixture(t), q = f.question();
  f.store.db.exec(`DROP TABLE chat_answer_deliveries; DROP TABLE chat_answers; DROP TABLE chat_question_controls;
    DELETE FROM schema_migrations WHERE version>=25;
    CREATE TABLE chat_answers(unrelated TEXT);`);
  assert.throws(() => owner.migrate(f.store.db), /no such column/);
  assert.equal(owner.inspectSchema(f.store.db).currentVersion, 24);
  assert.equal(f.store.db.prepare('SELECT status FROM chat_questions WHERE c4_id=?').get(q.id).status, 'paused');
  assert.equal(f.store.db.prepare("SELECT name FROM sqlite_master WHERE name='chat_answer_deliveries'").get(), undefined);
});

for (const table of ['chat_answers', 'chat_answer_deliveries', 'chat_question_controls']) {
  test(`schema inspection rejects missing ${table} without modifying the database`, t => {
    const f = fixture(t);
    f.store.db.exec(`DROP TABLE ${table}`);
    f.store.db.pragma('wal_checkpoint(TRUNCATE)');
    const before = fs.readFileSync(f.file);
    const reader = new Database(f.file, { readonly: true, fileMustExist: true });
    try { assert.throws(() => owner.inspectSchema(reader), /no such table/); }
    finally { reader.close(); }
    assert.deepEqual(fs.readFileSync(f.file), before);
  });
}

for (const [shape, transform, expected] of [
  ['nullable answer identity', sql => sql.replace('answer_id TEXT PRIMARY KEY NOT NULL', 'answer_id TEXT PRIMARY KEY'), /answer persistence/],
  ['non-unique question reference', sql => sql.replace('question_c4_id TEXT NOT NULL UNIQUE', 'question_c4_id TEXT NOT NULL'), /answer identity/],
  ['wrong creation timestamp type', sql => sql.replace('created_at INTEGER NOT NULL', 'created_at TEXT NOT NULL'), /answer persistence/],
]) test(`schema rejects ${shape} before permitting answer writes`, t => {
  const f = fixture(t);
  const original = f.store.db.prepare("SELECT sql FROM sqlite_master WHERE name='chat_answers'").get().sql;
  const changed = transform(original); assert.notEqual(changed, original);
  f.store.db.exec('DROP TABLE chat_answers'); f.store.db.exec(changed);
  f.store.db.exec('CREATE INDEX idx_chat_answers_group ON chat_answers(session_group,answer_id)');
  assert.throws(() => owner.inspectSchema(f.store.db), expected);
  assert.throws(() => owner.migrate(f.store.db), expected);
  assert.equal(f.count('chat_answers'), 0);
});

// Index admission uses real private SQLite layouts on a readonly caller handle.
// Run for answer schema/index inspection changes; UI-only changes may skip.
// Failed inspection and migration must leave the fixture's database bytes intact.
for (const [table, index, columns, wrongColumns] of [
  ['chat_answers', 'idx_chat_answers_group', 'session_group,answer_id', 'answer_id,session_group'],
  ['chat_answer_deliveries', 'idx_chat_answer_deliveries_state', 'state,answer_id', 'answer_id,state'],
]) for (const shape of ['missing', 'wrong columns', 'unique', 'partial']) {
  test(`answer schema rejects a ${shape} ${index} without changing the database`, t => {
    const f = fixture(t);
    f.store.db.exec(`DROP INDEX ${index}`);
    if (shape !== 'missing') {
      f.store.db.exec(`CREATE ${shape === 'unique' ? 'UNIQUE ' : ''}INDEX ${index}
        ON ${table}(${shape === 'wrong columns' ? wrongColumns : columns})
        ${shape === 'partial' ? "WHERE answer_id <> ''" : ''}`);
    }
    f.store.db.pragma('wal_checkpoint(TRUNCATE)');
    const before = fs.readFileSync(f.file);
    const reader = new Database(f.file, { readonly: true, fileMustExist: true });
    try {
      assert.throws(() => owner.inspectSchema(reader), /Unsupported Dashboard answer lookup index/);
      assert.throws(() => owner.migrate(reader), /Unsupported Dashboard answer lookup index/);
    } finally { reader.close(); }
    assert.ok(fs.readFileSync(f.file).equals(before), 'admission failure must not change database bytes');
  });
}
