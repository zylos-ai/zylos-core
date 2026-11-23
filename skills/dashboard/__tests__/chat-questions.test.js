import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseC4Content, CONTENT_PREFIX } from '../../comm-bridge/scripts/c4-content-schema.js';

import { setupChannelFixture, deliveryPacket } from './helpers/channel-fixture.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const contentFor = name => fixtures.valid.find(item => item.name === name).content;
const question = (f, id) => f.dashboardDb.prepare('SELECT * FROM chat_questions WHERE c4_id=?').get(String(id));

const noQuestions = f => assert.equal(f.count('chat_questions', f.dashboardDb), 0);

// Boundary: real BeforeSend rejects ambiguous choices before C4 storage or delivery.
// Run on choice/send validation changes; unrelated UI changes may skip. The fixture
// prints private paths, permits no tmux executable, and owns timed child cleanup.

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

// Boundary: post-storage registration failure retains exactly one out and permits
// same-reference repair. Run on registration/Store failure changes; UI-only may skip.

// Boundary: even a stored malformed envelope has no registration fallback.
// Run on parser/registration changes; UI-only edits may skip.

// Boundary: shared Node/Web parser used by consumers ignores only the Core suffix.
// Run on protocol/suffix integration; UI-only edits may skip. No renderer is introduced here.

// Boundary: question identity is unique by group + interruptId.
// Run on question identity/conflict handling; UI-only edits may skip.

// Boundary: answers and extra ordinary chat cannot resolve an open question.
// Run on registration dispatch changes; UI-only edits may skip.

// Boundary: only the interrupt-target block supplies saved answer constraints.
// Run on block selection/registration changes; UI-only edits may skip.

// Boundary: delivery cannot create a missing Dashboard database as a side effect.
// Run on Store/path/existence handling changes; UI-only edits may skip.

// Boundary: explicit instance paths override the HOME-based default for both stores.
// Run on path resolution changes; UI-only edits may skip.

// Boundary: verified outbound lifecycle controls update Dashboard overlays only.
// Run on control dispatch/lifecycle changes; unrelated UI-only edits may skip.

// Boundary: replace requires a separately registered replacement in the same group.
// Run on replacement validation changes; unrelated UI-only edits may skip.

// Boundary: real send-hook -> C4 commit -> Dashboard send process after a
// competing user answer. Failure must retain the committed control and warn
// against another send; only the Dashboard lifecycle overlay is rejected.

// Boundary: a committed control cannot recreate a missing Dashboard database.
// The untyped storage error still needs the same stored/read-only warning.

// Boundary: real hook-free receiver process over the two private databases.
// In single mode Core records every conversation's rows under `origin` at
// delivery; a question and its controls belong to the conversation of the
// row's endpoint. Run on question registration or control changes.
const recordUnderOrigin = (f, row) => {
  f.c4Db.prepare("UPDATE conversations SET session_group='origin' WHERE id=?").run(row.id);
  return { ...row, session_group: 'origin' };
};

test('questions recorded under origin register under the conversation each is sent to', t => {
  const f = setupChannelFixture(t);
  f.insert('seed other conversation', { direction: 'in', endpoint: 'other', group: 'other' });
  const first = f.insert(contentFor('single')), second = f.insert(contentFor('single'), { endpoint: 'other', group: 'other' });
  const groups = [first.session_group, second.session_group];
  assert.notEqual(groups[0], groups[1]);
  for (const row of [first, second]) {
    const result = f.receive(deliveryPacket(recordUnderOrigin(f, row)));
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual([question(f, first.id).session_group, question(f, second.id).session_group], groups);
  assert.deepEqual([question(f, first.id).endpoint_id, question(f, second.id).endpoint_id], ['conversation_a', 'other']);
  assert.equal(question(f, first.id).interrupt_id, question(f, second.id).interrupt_id, 'one interruptId in two conversations');
});
