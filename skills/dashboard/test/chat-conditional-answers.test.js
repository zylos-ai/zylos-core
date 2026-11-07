import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/lib/store.js';
import { ChatAnswers } from '../src/lib/chat/answers.js';
import { registerQuestion } from '../src/lib/chat/questions.js';
import { CONTENT_PREFIX, parseC4Content, makeQuestionSummary, evaluateFormState } from '../../comm-bridge/scripts/c4-content-schema.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/view-and-form.json', import.meta.url), 'utf8'));
const fieldErrors = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/form-field-errors.json', import.meta.url), 'utf8'));
const wire = envelope => CONTENT_PREFIX + JSON.stringify(envelope);
const clone = value => structuredClone(value);

// Boundary: real question registration, saved constraints and answer transaction.
// Run for conditional-answer or saved-question changes; unrelated UI may skip.
// The mandatory runner isolates paths before imports. Each case owns one SQLite
// file and closes it before removing its directory. No C4 process, HTTP, model,
// runtime, PM2, tmux, timers or external service is selected or started.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conditional-answers-'));
  let store;
  t.after(() => { store?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'components/dashboard/dashboard.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  store = new Store(file);
  const answers = new ChatAnswers({ store, now: () => 1000 });
  let serial = 0;
  function question(source = fixtures.formQuestion) {
    const envelope = clone(source);
    envelope.messageId += `_${++serial}`;
    envelope.interruptId += `_${serial}`;
    envelope.questionSummary = makeQuestionSummary(envelope);
    const row = { id: serial, session_group: 'dashboard:mine', endpoint_id: 'mine', content: wire(envelope) };
    const saved = registerQuestion(row, { env: { ZYLOS_DIR: root } });
    return { row, envelope, saved };
  }
  function action(q, payload, id = `conditional_answer_${serial}`) {
    const block = q.envelope.blocks.find(item => item.id === q.envelope.interrupt.blockId);
    return { id, protocolVersion: '0.1', type: block.data.action.type, target: block.data.action.target,
      context: { messageId: q.envelope.messageId, blockId: block.id }, payload };
  }
  const accept = (q, intent) => answers.accept({ sessionGroup: q.saved.session_group,
    endpointId: q.saved.endpoint_id, interruptId: q.saved.interrupt_id, action: intent });
  const count = table => store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  const assertEmpty = q => {
    assert.equal(count('chat_answers'), 0);
    assert.equal(count('chat_answer_deliveries'), 0);
    assert.equal(answers.question(q.saved.session_group, q.saved.interrupt_id).status, 'paused');
  };
  return { file, store, answers, question, action, accept, count, assertEmpty };
}

for (const example of fixtures.answers) test(`saved conditional fields validate ${example.name}`, t => {
  const f = fixture(t), q = f.question();
  const action = f.action(q, { values: clone(example.values) });
  assert.equal(JSON.parse(q.saved.constraints).block.schemaVersion, 2);
  if (!example.valid) {
    assert.throws(() => f.accept(q, action), { code: 'invalid_chat_answer', statusCode: 400 });
    f.assertEmpty(q);
    return;
  }
  const accepted = f.accept(q, action);
  assert.equal(accepted.created, true);
  assert.equal(f.count('chat_answers'), 1);
  assert.equal(f.count('chat_answer_deliveries'), 1);
  const parsed = parseC4Content(accepted.answer.content);
  assert.equal(parsed.kind, 'envelope');
  assert.equal(parsed.envelope.version, 1);
  assert.equal(parsed.envelope.action.protocolVersion, '0.1');
  assert.deepEqual(parsed.envelope.action.payload.values, example.values);
  assert.equal(parsed.envelope.action.context.messageId, q.saved.message_id);
  assert.equal(parsed.envelope.action.context.blockId, 'customer_form');
  assert.equal(parsed.envelope.metadata.zylos.answerId, action.id);
  assert.equal(parsed.envelope.questionSummary, q.saved.question_summary);
  assert.equal(f.store.db.prepare('SELECT state FROM chat_answer_deliveries WHERE answer_id=?').get(action.id).state, 'pending');
});

// Default, ungated Store boundary: exact field reasons and the non-field
// refusal exclusions must run when answer validation changes. UI-only work
// may skip. Uses only the private SQLite fixture above, without a receiver,
// subprocess, service or network; every refusal must leave durable counts alone.
test('saved answers expose fixed field reasons only for eligible conditional refusals', t => {
  const f = fixture(t);
  let durable = 0;
  const unchanged = q => {
    assert.equal(f.count('chat_answers'), durable);
    assert.equal(f.count('chat_answer_deliveries'), durable);
    if (q) assert.equal(f.answers.question(q.saved.session_group, q.saved.interrupt_id).status, 'paused');
  };
  const refusal = (run, code, expectedFields) => {
    assert.throws(run, error => {
      assert.equal(error.code, code);
      if (expectedFields === undefined) assert.equal(Object.hasOwn(error, 'fields'), false);
      else assert.deepEqual(error.fields, expectedFields);
      return true;
    });
    unchanged();
  };
  const invalid = fixtures.answers.filter(example => !example.valid);
  assert.equal(invalid.length, 11);
  for (const example of invalid) {
    const q = f.question();
    refusal(() => f.accept(q, f.action(q, { values: clone(example.values) })), 'invalid_chat_answer', fieldErrors[example.name]);
    unchanged(q);
  }

  const q = f.question();
  const invalidValues = { customer_type: 'company', employee_count: 3 };
  for (const change of [
    action => { action.extra = true; },
    action => { action.context.messageId = 'another_message'; },
    action => { action.context.blockId = 'another_block'; },
    action => { action.protocolVersion = '0.2'; },
    action => { action.type = 'choice.select'; },
    action => { action.target = 'another.handler'; },
    action => { action.schemaVersion = 2; },
    action => { action.context.conversationId = 'g:64617368626F6172643A6F74686572'; },
  ]) {
    const action = f.action(q, { values: clone(invalidValues) }); change(action);
    refusal(() => f.accept(q, action), 'invalid_chat_answer');
    unchanged(q);
  }
  refusal(() => f.answers.accept({ sessionGroup: q.saved.session_group, endpointId: 'other',
    interruptId: q.saved.interrupt_id, action: f.action(q, { values: clone(invalidValues) }) }), 'chat_question_forbidden');
  refusal(() => f.answers.accept({ sessionGroup: 'dashboard:other', endpointId: q.saved.endpoint_id,
    interruptId: q.saved.interrupt_id, action: f.action(q, { values: clone(invalidValues) }) }), 'chat_question_not_found');
  unchanged(q);

  const legacy = clone(fixtures.formQuestion);
  legacy.blocks[0].schemaVersion = 1;
  for (const field of legacy.blocks[0].data.fields) delete field.activeWhen;
  const old = f.question(legacy);
  refusal(() => f.accept(old, f.action(old, { values: clone(invalidValues) })), 'invalid_chat_answer');
  unchanged(old);
  const denied = clone(fixtures.formQuestion); denied.interrupt.otherInput = false;
  const noText = f.question(denied);
  refusal(() => f.accept(noText, f.action(noText, { freeText: 'Please clarify' })), 'invalid_chat_answer');
  unchanged(noText);

  const control = f.action(q, { values: { customer_type: 'person' } }, 'durable_conditional_answer');
  const accepted = f.accept(q, control);
  assert.equal(accepted.created, true);
  durable = 1;
  unchanged();
  assert.equal(f.accept(q, clone(control)).created, false);
  unchanged();
  refusal(() => f.accept(q, f.action(q, { values: clone(invalidValues) }, 'answered_invalid_fields')), 'invalid_chat_answer');
  refusal(() => f.accept(q, f.action(q, { values: { customer_type: 'person' } }, 'answered_valid_fields')), 'chat_question_not_paused');
  const conflict = clone(control); conflict.payload.values = { customer_type: 'partner' };
  refusal(() => f.accept(q, conflict), 'chat_answer_conflict');
  assert.equal(f.answers.question(q.saved.session_group, q.saved.interrupt_id).status, 'answered');
  assert.deepEqual(f.answers.get(control.id), accepted.answer);
});

const legalView = { schemaVersion: 1, root: 'layout_root', nodes: [{ id: 'layout_root', type: 'block', blockId: 'customer_form' }] };
const overdeepView = clone(legalView);
overdeepView.nodes[0].extra = { b: { c: 1 } };
for (const [name, view, valid] of [
  ['legal', legalView, true], ['scalar', 1, false],
  ['unknown-version', { schemaVersion: 99, root: 'x', nodes: [] }, false], ['overdeep', overdeepView, false],
]) test(`stored ${name} View does not alter conditional answer constraints`, t => {
  const f = fixture(t), source = clone(fixtures.formQuestion);
  source.metadata = { view: clone(view) };
  const parsed = parseC4Content(wire(source));
  assert.equal(parsed.kind, 'envelope');
  assert.equal('viewError' in parsed, !valid);
  if (name === 'overdeep') {
    const depth = value => value !== null && typeof value === 'object'
      ? 1 + Math.max(0, ...Object.values(value).map(depth)) : 1;
    assert.equal(depth(source.metadata), 7);
  }
  const q = f.question(source), constraints = JSON.parse(q.saved.constraints);
  assert.deepEqual(Object.keys(constraints).sort(), ['block', 'interrupt']);
  assert.deepEqual(constraints.block, source.blocks[0]);
  assert.deepEqual(constraints.interrupt, source.interrupt);
  const accepted = f.accept(q, f.action(q, { values: { customer_type: 'person' } }));
  assert.equal(accepted.created, true);
  assert.equal(parseC4Content(accepted.answer.content).envelope.action.protocolVersion, '0.1');
});

test('saved conditional dependencies hide stale descendants and accept their restored values', t => {
  const f = fixture(t);
  const hidden = fixtures.formStates.find(item => item.name === 'inactive_upstream_ignores_saved_descendant');
  const restored = fixtures.formStates.find(item => item.name === 'restored_upstream_restores_chain');
  assert.deepEqual(hidden.fields, restored.fields);
  const source = clone(fixtures.formQuestion);
  source.blocks[0].data.fields = clone(hidden.fields);
  const q = f.question(source);
  assert.deepEqual(evaluateFormState(JSON.parse(q.saved.constraints).block.data.fields, hidden.values).activeKeys, hidden.activeKeys);
  assert.throws(() => f.accept(q, f.action(q, { values: clone(hidden.values) })), { code: 'invalid_chat_answer' });
  f.assertEmpty(q);
  const hiddenAnswer = f.accept(q, f.action(q, { values: { a: false } }));
  assert.deepEqual(hiddenAnswer.answer.action.payload.values, { a: false });
  const next = f.question(source);
  assert.deepEqual(evaluateFormState(JSON.parse(next.saved.constraints).block.data.fields, restored.values).activeKeys, restored.activeKeys);
  const restoredAnswer = f.accept(next, f.action(next, { values: clone(restored.values) }));
  assert.deepEqual(restoredAnswer.answer.action.payload.values, restored.values);
  assert.equal(f.count('chat_answers'), 2);
});

test('stored form versions govern field rules and the closed Action schema rejects a caller version', t => {
  const f = fixture(t), legacy = clone(fixtures.formQuestion);
  legacy.blocks[0].schemaVersion = 1;
  for (const field of legacy.blocks[0].data.fields) delete field.activeWhen;
  const q = f.question(legacy);
  const payload = { values: { customer_type: 'person' } };
  assert.throws(() => f.accept(q, f.action(q, payload)), { code: 'invalid_chat_answer' });
  const forged = { ...f.action(q, payload), schemaVersion: 2 };
  assert.throws(() => f.accept(q, forged), { code: 'invalid_chat_answer' });
  f.assertEmpty(q);
  assert.equal(f.accept(q, f.action(q, { values: { customer_type: 'person', company_name: 'Required in v1', employee_count: 1 } })).created, true);
  const conditional = f.question();
  assert.equal(f.accept(conditional, f.action(conditional, payload)).created, true);
});

test('conditional free text preserves stored other-input permission', t => {
  const f = fixture(t), denied = clone(fixtures.formQuestion);
  denied.interrupt.otherInput = false;
  const q = f.question(denied);
  assert.throws(() => f.accept(q, f.action(q, { freeText: 'Please clarify' })), { code: 'invalid_chat_answer' });
  f.assertEmpty(q);
  const allowed = f.question();
  const accepted = f.accept(allowed, f.action(allowed, { freeText: 'Please clarify' }));
  assert.equal(accepted.answer.action.payload.freeText, 'Please clarify');
  assert.ok(parseC4Content(accepted.answer.content).envelope.fallbackText.endsWith('Please clarify'));
});

test('conditional answers preserve action protocol and stored context authority', t => {
  const f = fixture(t), q = f.question(), valid = f.action(q, { values: { customer_type: 'person' } });
  for (const change of [
    action => { action.protocolVersion = '0.2'; },
    action => { action.context.messageId = 'another_message'; },
    action => { action.context.blockId = 'another_block'; },
    action => { action.target = 'another.handler'; },
  ]) {
    const action = clone(valid); change(action);
    assert.throws(() => f.accept(q, action), { code: 'invalid_chat_answer' });
    f.assertEmpty(q);
  }
  assert.throws(() => f.answers.accept({ sessionGroup: q.saved.session_group, endpointId: 'other',
    interruptId: q.saved.interrupt_id, action: valid }), { code: 'chat_question_forbidden', statusCode: 403 });
  f.assertEmpty(q);
  assert.equal(f.accept(q, valid).created, true);
});

test('a repeated conditional answer retains one durable result across reopening', t => {
  const f = fixture(t), q = f.question(), action = f.action(q, { values: { customer_type: 'person' } });
  const accepted = f.accept(q, action);
  assert.equal(f.accept(q, clone(action)).created, false);
  const different = clone(action); different.payload.values = { customer_type: 'partner' };
  assert.throws(() => f.accept(q, different), { code: 'chat_answer_conflict', statusCode: 409 });
  const reopened = new Store(f.file);
  try {
    const answers = new ChatAnswers({ store: reopened });
    const again = answers.accept({ sessionGroup: q.saved.session_group, endpointId: q.saved.endpoint_id,
      interruptId: q.saved.interrupt_id, action: clone(action) });
    assert.equal(again.created, false);
    assert.deepEqual(again.answer, accepted.answer);
    assert.equal(reopened.db.prepare('SELECT count(*) n FROM chat_answers').get().n, 1);
    assert.equal(reopened.db.prepare('SELECT count(*) n FROM chat_answer_deliveries').get().n, 1);
  } finally { reopened.close(); }
});
