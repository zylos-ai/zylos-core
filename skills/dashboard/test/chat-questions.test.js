import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseC4Content, CONTENT_PREFIX } from '../../comm-bridge/scripts/c4-content-schema.js';
import { projectC4Content } from '../../comm-bridge/scripts/c4-content-projection.js';
import { setupChannelFixture, deliveryPacket } from './helpers/channel-fixture.js';
import { ChatAnswers } from '../src/lib/chat/answers.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const contentFor = name => fixtures.valid.find(item => item.name === name).content;
const question = (f, id) => f.dashboardDb.prepare('SELECT * FROM chat_questions WHERE c4_id=?').get(String(id));
const assertStoredWarning = result => assert.match(result.stderr, /already stored in C4 and visible read-only in Dashboard\. Do not resend/);
const noQuestions = f => assert.equal(f.count('chat_questions', f.dashboardDb), 0);

// Boundary: actual hook -> committed C4 -> receiver -> real Dashboard Store.
// Run on protocol/registration changes; UI-only edits may skip.
for (const name of ['single', 'multiple', 'confirmation', 'form']) test(`Stored ${name} question registers its original group references and constraints`, t => {
  const f = setupChannelFixture(t), content = contentFor(name), envelope = parseC4Content(content).envelope;
  const sent = f.send(content);
  assert.ifError(sent.error); assert.equal(sent.status, 0, sent.stderr);
  const row = f.c4Db.prepare('SELECT * FROM conversations').get(), saved = question(f, row.id);
  assert.equal(saved.c4_id, String(row.id)); assert.equal(saved.session_group, row.session_group);
  assert.equal(saved.endpoint_id, row.endpoint_id); assert.equal(saved.message_id, envelope.messageId);
  assert.equal(saved.interrupt_id, envelope.interruptId); assert.equal(saved.question_summary, envelope.questionSummary);
  assert.equal(saved.status, 'paused');
  const constraints = JSON.parse(saved.constraints);
  assert.deepEqual(constraints.block, envelope.blocks.find(item => item.id === envelope.interrupt.blockId));
  assert.deepEqual(constraints.interrupt, envelope.interrupt);
  const reconstructed = { version: 1, kind: 'message', messageId: saved.message_id,
    fallbackText: saved.question_summary, blocks: [constraints.block], interruptId: saved.interrupt_id,
    questionSummary: saved.question_summary, interrupt: constraints.interrupt };
  assert.equal(parseC4Content(CONTENT_PREFIX + JSON.stringify(reconstructed)).kind, 'envelope');
  assert.equal(row.content, content); assert.equal(f.count('group_heads'), 1);
  assert.equal(fs.existsSync(f.env.CHANNEL_HTTP_LOG), false);
});

// Boundary: repeat callback must not overwrite future answer/lifecycle state.
// Run on registration conflict behavior; UI-only edits may skip.
test('Repeated delivery preserves the existing question state and constraints', t => {
  const f = setupChannelFixture(t), row = f.insert(contentFor('single'));
  assert.equal(f.receive(deliveryPacket(row)).status, 0);
  f.dashboardDb.prepare("UPDATE chat_questions SET status='complete', constraints='retained' WHERE c4_id=?").run(String(row.id));
  assert.equal(f.receive(deliveryPacket(row)).status, 0);
  assert.equal(f.count('chat_questions', f.dashboardDb), 1);
  assert.equal(question(f, row.id).status, 'complete'); assert.equal(question(f, row.id).constraints, 'retained');
  assert.equal(f.count('conversations'), 1);
});

// Boundary: authority validation precedes every registration/open/write.
// Run on packet/readback changes; UI-only edits may skip.
test('Forged or mismatched delivery cannot register a question', t => {
  const f = setupChannelFixture(t), row = f.insert(contentFor('single')), packet = deliveryPacket(row);
  for (const change of [{ c4_id: 999 }, { channel: 'other' }, { endpoint_id: 'other' },
    { session_group: 'dashboard:other' }, { content: contentFor('multiple') }]) {
    const received = f.receive({ ...packet, ...change });
    assert.notEqual(received.status, 0); assert.match(received.stderr, /DELIVERY_MISMATCH/);
    noQuestions(f);
  }
  for (const options of [{ direction: 'in' }, { channel: 'other' }]) {
    const received = f.receive(deliveryPacket(f.insert(contentFor('single'), options)));
    assert.notEqual(received.status, 0); noQuestions(f);
  }
});

// Boundary: storage failure occurs after validation but before receiver/registration.
// Run on send/commit integration; UI-only edits may skip.
test('C4 storage failure does not invoke the receiver or register a question', t => {
  const f = setupChannelFixture(t);
  f.c4Db.exec("CREATE TRIGGER fail_out BEFORE INSERT ON conversations WHEN NEW.direction='out' BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END");
  const result = f.send(contentFor('single'));
  assert.notEqual(result.status, 0);
  assert.equal(f.count('conversations'), 0); assert.equal(f.count('group_heads'), 0);
  assert.equal(fs.existsSync(f.env.CHANNEL_SEND_LOG), false); noQuestions(f);
});

// Boundary: post-storage registration failure retains exactly one out and permits
// same-reference repair. Run on registration/Store failure changes; UI-only may skip.
test('Registration failure can be repaired by the same C4 reference without resending', t => {
  const f = setupChannelFixture(t);
  f.dashboardDb.exec("CREATE TRIGGER fail_question BEFORE INSERT ON chat_questions BEGIN SELECT RAISE(ABORT,'fixture registration failure'); END");
  const result = f.send(contentFor('single'));
  assert.notEqual(result.status, 0); assert.match(result.stderr, /QUESTION_REGISTRATION_FAILED/);
  assert.match(result.stderr, /repair must use the existing C4 reference/);
  assertStoredWarning(result);
  assert.equal(f.count('conversations'), 1); noQuestions(f);
  const row = f.c4Db.prepare('SELECT * FROM conversations').get();
  f.dashboardDb.exec('DROP TRIGGER fail_question');
  assert.equal(f.receive(deliveryPacket(row)).status, 0);
  assert.equal(f.count('conversations'), 1); assert.equal(f.count('chat_questions', f.dashboardDb), 1);
  assert.equal(question(f, row.id).status, 'paused');
});

// Boundary: even a stored malformed envelope has no registration fallback.
// Run on parser/registration changes; UI-only edits may skip.
test('A malformed stored envelope is rejected without registering a question', t => {
  const f = setupChannelFixture(t), row = f.insert(contentFor('single') + ' unknown trailing prose');
  const result = f.receive(deliveryPacket(row));
  assert.notEqual(result.status, 0); assert.match(result.stderr, /INVALID_CONTENT/);
  assert.match(result.stderr, /Invalid Dashboard content/); assertStoredWarning(result); noQuestions(f);
});

// Boundary: shared Node/Web parser used by consumers ignores only the Core suffix.
// Run on protocol/suffix integration; UI-only edits may skip. No renderer is introduced here.
test('Suppressed annotation preserves question summary references and answer identity', t => {
  const f = setupChannelFixture(t);
  const suffix = '\n\n[C4] Status notification suppressed by cooldown while health=unavailable reason=runtime unavailable.';
  const content = contentFor('single') + suffix, envelope = parseC4Content(content).envelope;
  const row = f.insert(content);
  assert.equal(f.receive(deliveryPacket(row)).status, 0);
  const saved = question(f, row.id);
  assert.equal(saved.question_summary, envelope.questionSummary); assert.equal(saved.interrupt_id, envelope.interruptId);
  assert.match(projectC4Content(content, { c4Id: row.id }), new RegExp(envelope.interruptId));
  assert.equal(f.c4Db.prepare('SELECT content FROM conversations WHERE id=?').get(row.id).content, content);
  const answer = fixtures.valid.map(item => ({ item, parsed: parseC4Content(item.content) })).find(({ parsed }) => parsed.envelope?.kind === 'answer');
  const annotated = answer.item.content + suffix;
  const parsed = parseC4Content(annotated).envelope;
  assert.equal(parsed.metadata.zylos.answerId, answer.parsed.envelope.metadata.zylos.answerId);
  assert.equal(parsed.questionSummary, answer.parsed.envelope.questionSummary);
  assert.equal(projectC4Content(annotated, { c4Id: 1 }), projectC4Content(answer.item.content, { c4Id: 1 }));
  assert.equal(f.receive(deliveryPacket(f.insert(annotated))).status, 0);
  assert.equal(f.count('chat_questions', f.dashboardDb), 1);
});

// Boundary: question identity is unique by group + interruptId.
// Run on question identity/conflict handling; UI-only edits may skip.
test('Another C4 row cannot reuse a question reference within the same group', t => {
  const f = setupChannelFixture(t), first = f.insert(contentFor('single'));
  assert.equal(f.receive(deliveryPacket(first)).status, 0);
  f.dashboardDb.prepare("UPDATE chat_questions SET status='answered' WHERE c4_id=?").run(String(first.id));
  const duplicate = f.insert(contentFor('single')), result = f.receive(deliveryPacket(duplicate));
  assert.notEqual(result.status, 0); assert.match(result.stderr, /QUESTION_REFERENCE_CONFLICT.*another C4 row/);
  assertStoredWarning(result);
  assert.equal(f.count('chat_questions', f.dashboardDb), 1);
  assert.equal(question(f, first.id).status, 'answered'); assert.equal(question(f, duplicate.id), undefined);
  f.insert('seed other group', { direction: 'in', endpoint: 'other', group: 'other' });
  const other = f.insert(contentFor('single'), { endpoint: 'other', group: 'other' });
  assert.notEqual(other.session_group, first.session_group);
  assert.equal(f.receive(deliveryPacket(other)).status, 0);
  assert.equal(f.count('chat_questions', f.dashboardDb), 2);
});

// Boundary: answers and extra ordinary chat cannot resolve an open question.
// Run on registration dispatch changes; UI-only edits may skip.
test('Non-question messages and answer envelopes do not change an existing question state', t => {
  const f = setupChannelFixture(t), row = f.insert(contentFor('single'));
  assert.equal(f.receive(deliveryPacket(row)).status, 0);
  for (const item of fixtures.valid) {
    const parsed = parseC4Content(item.content);
    if (parsed.kind !== 'envelope' || parsed.envelope.interrupt || parsed.envelope.kind === 'control') continue;
    assert.equal(f.receive(deliveryPacket(f.insert(item.content))).status, 0, item.name);
    assert.equal(question(f, row.id).status, 'paused', item.name);
    assert.equal(f.count('chat_questions', f.dashboardDb), 1);
  }
  assert.equal(f.send('additional ordinary text').status, 0);
  assert.equal(question(f, row.id).status, 'paused');
});

// Boundary: only the interrupt-target block supplies saved answer constraints.
// Run on block selection/registration changes; UI-only edits may skip.
test('A multi-block question saves the interrupt target rather than the first block', t => {
  const f = setupChannelFixture(t), envelope = structuredClone(parseC4Content(contentFor('single')).envelope);
  envelope.blocks.unshift({ id: 'intro_block', type: 'markdown', schemaVersion: 1, data: { text: 'Context only' } });
  const content = CONTENT_PREFIX + JSON.stringify(envelope);
  assert.equal(parseC4Content(content).kind, 'envelope');
  const result = f.send(content);
  assert.equal(result.status, 0, result.stderr);
  const row = f.c4Db.prepare('SELECT * FROM conversations').get(), saved = question(f, row.id);
  assert.equal(JSON.parse(saved.constraints).block.id, envelope.interrupt.blockId);
  assert.notEqual(JSON.parse(saved.constraints).block.id, envelope.blocks[0].id);
});

// Boundary: delivery cannot create a missing Dashboard database as a side effect.
// Run on Store/path/existence handling changes; UI-only edits may skip.
test('A missing Dashboard database fails registration without creating a replacement', t => {
  const f = setupChannelFixture(t), row = f.insert(contentFor('single'));
  f.dashboardStore.close();
  fs.unlinkSync(f.dashboardPath);
  const result = f.receive(deliveryPacket(row));
  assert.notEqual(result.status, 0); assert.match(result.stderr, /QUESTION_REGISTRATION_FAILED/); assertStoredWarning(result);
  assert.equal(fs.existsSync(f.dashboardPath), false);
  assert.equal(f.count('conversations'), 1);
});

// Boundary: explicit instance paths override the HOME-based default for both stores.
// Run on path resolution changes; UI-only edits may skip.
test('Question delivery uses ZYLOS_DIR when it differs from the HOME default', t => {
  const f = setupChannelFixture(t);
  assert.notEqual(f.env.ZYLOS_DIR, path.join(f.env.HOME, 'zylos'));
  const result = f.send(contentFor('single'));
  assert.equal(result.status, 0, result.stderr);
  const row = f.c4Db.prepare('SELECT * FROM conversations').get();
  assert.equal(question(f, row.id).question_summary, parseC4Content(row.content).envelope.questionSummary);
  assert.equal(fs.existsSync(path.join(f.env.HOME, 'zylos')), false);
});

// Boundary: verified outbound lifecycle controls update Dashboard overlays only.
// Run on control dispatch/lifecycle changes; unrelated UI-only edits may skip.
test('An explicit stop closes its stored question without fabricating a cancel answer or changing C4', t => {
  const f = setupChannelFixture(t), row = f.insert(contentFor('single'));
  assert.equal(f.receive(deliveryPacket(row)).status, 0);
  const controlRow = f.insert(contentFor('stop'));
  assert.equal(f.receive(deliveryPacket(controlRow)).status, 0);
  assert.equal(question(f, row.id).status, 'stopped');
  assert.equal(f.count('chat_answers', f.dashboardDb), 0);
  assert.equal(f.c4Db.prepare('SELECT content FROM conversations WHERE id=?').get(row.id).content, row.content);
  assert.equal(f.receive(deliveryPacket(controlRow)).status, 0, 'same control delivery is idempotent');
  assert.equal(f.count('chat_question_controls', f.dashboardDb), 1);
});

// Boundary: replace requires a separately registered replacement in the same group.
// Run on replacement validation changes; unrelated UI-only edits may skip.
test('An explicit replacement requires registration and preserves both immutable question messages', t => {
  const f = setupChannelFixture(t), row = f.insert(contentFor('single'));
  assert.equal(f.receive(deliveryPacket(row)).status, 0);
  const controlRow = f.insert(contentFor('replace'));
  const failed = f.receive(deliveryPacket(controlRow));
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Error \[chat_question_not_found\]/);
  assertStoredWarning(failed);
  assert.doesNotMatch(failed.stderr, /Dashboard delivery unconfirmed/);
  assert.equal(question(f, row.id).status, 'paused');
  const replacement = structuredClone(parseC4Content(contentFor('single')).envelope);
  replacement.messageId = 'replacement_message'; replacement.interruptId = 'new_question';
  const replacementRow = f.insert(CONTENT_PREFIX + JSON.stringify(replacement));
  assert.equal(f.receive(deliveryPacket(replacementRow)).status, 0);
  assert.equal(f.receive(deliveryPacket(controlRow)).status, 0);
  assert.equal(question(f, row.id).status, 'superseded');
  assert.equal(question(f, replacementRow.id).status, 'paused');
  const saved = f.dashboardDb.prepare('SELECT * FROM chat_question_controls WHERE question_c4_id=?').get(String(row.id));
  assert.equal(saved.replacement_interrupt_id, 'new_question');
  assert.equal(f.count('chat_answers', f.dashboardDb), 0);
  for (const original of [row, replacementRow]) {
    assert.equal(f.c4Db.prepare('SELECT content FROM conversations WHERE id=?').get(original.id).content, original.content);
  }
});

// Boundary: real send-hook -> C4 commit -> Dashboard send process after a
// competing user answer. Failure must retain the committed control and warn
// against another send; only the Dashboard lifecycle overlay is rejected.
test('an agent stop after a user answer reports its stored control without changing the answered question', t => {
  const f = setupChannelFixture(t);
  const sent = f.send(contentFor('single'));
  assert.equal(sent.status, 0, sent.stderr);
  const original = f.c4Db.prepare('SELECT * FROM conversations').get();
  const saved = question(f, original.id);
  const action = structuredClone(parseC4Content(contentFor('answer_single_select')).envelope.action);
  new ChatAnswers({ store: f.dashboardStore }).accept({ sessionGroup: saved.session_group,
    endpointId: saved.endpoint_id, interruptId: saved.interrupt_id, action });
  const result = f.send(contentFor('stop'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /chat_question_not_paused/);
  assertStoredWarning(result);
  assert.doesNotMatch(result.stderr, /Dashboard delivery unconfirmed/);
  assert.equal(f.count('conversations'), 2);
  const control = f.c4Db.prepare('SELECT * FROM conversations WHERE id<>?').get(original.id);
  assert.equal(parseC4Content(control.content).envelope.kind, 'control');
  assert.equal(control.session_group, original.session_group);
  assert.equal(control.content, contentFor('stop'));
  assert.equal(question(f, original.id).status, 'answered');
  assert.equal(f.count('chat_answers', f.dashboardDb), 1);
  assert.equal(f.count('chat_question_controls', f.dashboardDb), 0);
  assert.equal(f.c4Db.prepare('SELECT content FROM conversations WHERE id=?').get(original.id).content, original.content);
});

// Boundary: a committed control cannot recreate a missing Dashboard database.
// The untyped storage error still needs the same stored/read-only warning.
test('a missing Dashboard database reports a stored control failure without recreating the database', t => {
  const f = setupChannelFixture(t), control = f.insert(contentFor('stop'));
  f.dashboardStore.close();
  fs.unlinkSync(f.dashboardPath);
  const result = f.receive(deliveryPacket(control));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Error \[QUESTION_CONTROL_FAILED\]/);
  assertStoredWarning(result);
  assert.doesNotMatch(result.stderr, /Dashboard delivery unconfirmed/);
  assert.equal(fs.existsSync(f.dashboardPath), false);
  assert.equal(f.count('conversations'), 1);
  assert.equal(f.c4Db.prepare('SELECT content FROM conversations WHERE id=?').get(control.id).content, control.content);
});
