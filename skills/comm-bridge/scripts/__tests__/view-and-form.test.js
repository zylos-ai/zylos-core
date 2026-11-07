import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONTENT_PREFIX, COMPONENT_DEFINITIONS, parseC4Content, evaluateFormState, validateAnswer } from '../c4-content-schema.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/view-and-form.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);
const encode = value => CONTENT_PREFIX + JSON.stringify(value);
const suffix = '\n\n[C4] Status notification suppressed by cooldown while health=unavailable reason=waiting for recovery.';
const choiceAction = () => ({ id: 'layout_answer', protocolVersion: '0.1', type: 'choice.select', target: 'clarification.answer',
  context: { messageId: fixtures.message.messageId, blockId: 'question' }, payload: { selected: ['a'] } });
const formAction = values => ({ id: 'customer_answer', protocolVersion: '0.1', type: 'form.submit', target: 'customer.register',
  context: { messageId: fixtures.formQuestion.messageId, blockId: 'customer_form' }, payload: { values } });

// Shared schema/parser boundary only. Run for View, conditional form or answer
// validation changes; unrelated transport/storage/UI work may skip. No IO other
// than these static fixtures, and no process, database, network or runtime starts.
for (const fixture of fixtures.views) test(`view consumption preserves Content for ${fixture.name}`, () => {
  const message = clone(fixtures.message);
  message.metadata = { source: 'shared-fixture', view: clone(fixture.view) };
  const result = parseC4Content(encode(message) + suffix);
  assert.equal(result.kind, 'envelope', fixture.name);
  assert.equal(result.suffix, suffix);
  const expected = clone(fixtures.message);
  expected.metadata = { source: 'shared-fixture' };
  assert.deepEqual(result.envelope, expected);
  if (fixture.valid) {
    assert.deepEqual(result.view, fixture.view);
    assert.equal('viewError' in result, false);
  } else {
    assert.equal(result.view, null);
    assert.equal(typeof result.viewError, 'string');
    assert.ok(result.viewError.length > 0);
  }
});

test('a layout omitting the interrupt keeps the original block order and question answerable', () => {
  const message = clone(fixtures.message);
  message.metadata = { view: clone(fixtures.views.find(item => item.name === 'balanced_columns').view) };
  const result = parseC4Content(encode(message));
  assert.equal(result.kind, 'envelope');
  assert.deepEqual(result.envelope.blocks.map(block => block.id), ['plan_a', 'plan_b', 'question']);
  assert.equal(result.envelope.interrupt.blockId, 'question');
  assert.equal(validateAnswer(choiceAction(), message), true);
});

test('an invalid stored layout does not block a valid Content answer', () => {
  const message = clone(fixtures.message);
  message.metadata = { view: { schemaVersion: 99, root: 'absent', nodes: [] } };
  assert.equal(parseC4Content(encode(message)).kind, 'envelope');
  assert.equal(validateAnswer(choiceAction(), message), true);
  const wrong = choiceAction(); wrong.context.messageId = 'another_message';
  assert.equal(validateAnswer(wrong, message), false);
});

test('invalid Content remains invalid even when layout is independently malformed', () => {
  const message = clone(fixtures.message);
  message.blocks[0].schemaVersion = 99;
  message.metadata = { view: { schemaVersion: 99, root: 'absent', nodes: [] } };
  assert.equal(parseC4Content(encode(message) + suffix).kind, 'invalid');
  assert.equal(validateAnswer(choiceAction(), message), false);
});

test('messages without layout return no layout error and preserve their original envelope', () => {
  const result = parseC4Content(encode(fixtures.message));
  assert.equal(result.kind, 'envelope');
  assert.equal(result.view, null);
  assert.equal('viewError' in result, false);
  assert.deepEqual(result.envelope, fixtures.message);
});

for (const kind of ['answer', 'control']) test(`${kind} envelopes cannot carry layout metadata`, () => {
  const envelope = kind === 'answer'
    ? { version: 1, kind, messageId: 'answer_message', fallbackText: 'Plan A chosen', interruptId: fixtures.message.interruptId,
      questionSummary: fixtures.message.questionSummary, action: choiceAction(), metadata: { zylos: { answerId: 'layout_answer' } } }
    : { version: 1, kind, messageId: 'stop_message', fallbackText: 'Stopped', interruptId: fixtures.message.interruptId,
      control: { operation: 'stop', messageId: fixtures.message.messageId } };
  assert.equal(parseC4Content(encode(envelope)).kind, 'envelope');
  envelope.metadata = { ...envelope.metadata, view: clone(fixtures.views[0].view) };
  assert.equal(parseC4Content(encode(envelope)).kind, 'invalid');
});

for (const kind of ['answer', 'control']) for (const view of [1, { schemaVersion: 99, root: 'x', nodes: [] }]) {
  test(`${kind} envelopes reject ${typeof view === 'number' ? 'scalar' : 'unknown-version'} layout metadata`, () => {
    const envelope = kind === 'answer'
      ? { version: 1, kind, messageId: 'answer_message', fallbackText: 'Plan A chosen', interruptId: fixtures.message.interruptId,
        questionSummary: fixtures.message.questionSummary, action: choiceAction(), metadata: { zylos: { answerId: 'layout_answer' } } }
      : { version: 1, kind, messageId: 'stop_message', fallbackText: 'Stopped', interruptId: fixtures.message.interruptId,
        control: { operation: 'stop', messageId: fixtures.message.messageId } };
    assert.equal(parseC4Content(encode(envelope)).kind, 'envelope');
    envelope.metadata = { ...envelope.metadata, view: clone(view) };
    assert.equal(parseC4Content(encode(envelope)).kind, 'invalid');
  });
}

test('an overdeep stored layout does not block a valid Content answer', () => {
  const message = clone(fixtures.message);
  assert.equal(validateAnswer(choiceAction(), message), true);
  message.metadata = { view: clone(fixtures.views.find(item => item.name === 'balanced_columns').view) };
  message.metadata.view.nodes[1].extra = { b: { c: 1 } };
  const depth = value => value !== null && typeof value === 'object'
    ? 1 + Math.max(0, ...Object.values(value).map(depth)) : 1;
  assert.equal(depth(message.metadata), 7);
  const result = parseC4Content(encode(message));
  assert.equal(result.kind, 'envelope');
  assert.equal(result.view, null);
  assert.ok(result.viewError);
  assert.equal('view' in result.envelope.metadata, false);
  assert.equal(validateAnswer(choiceAction(), message), true);
});

function nodeBoundaryMessage(total) {
  const message = { version: 1, kind: 'message', messageId: 'many_nodes', fallbackText: 'Many complete blocks', blocks: [] };
  const view = { schemaVersion: 1, root: 'root', nodes: [{ id: 'root', type: 'stack', children: [] }] };
  for (let index = 0; index < 63; index++) {
    message.blocks.push({ id: `content_${index}`, type: 'markdown', schemaVersion: 1, data: { text: `Block ${index}` } });
    view.nodes[0].children.push(`branch_${index}`);
    view.nodes.push({ id: `branch_${index}`, type: 'stack', children: [`leaf_${index}`] },
      { id: `leaf_${index}`, type: 'block', blockId: `content_${index}` });
  }
  for (let index = 0; index < total - 127; index++) {
    view.nodes[0].children[index] = `wrapper_${index}`;
    view.nodes.push({ id: `wrapper_${index}`, type: 'stack', children: [`branch_${index}`] });
  }
  message.metadata = { view };
  return message;
}
for (const total of [128, 129]) test(`View node count ${total} has the required consumption boundary`, () => {
  const message = nodeBoundaryMessage(total);
  assert.equal(message.metadata.view.nodes.length, total);
  const result = parseC4Content(encode(message));
  assert.equal(result.kind, 'envelope');
  if (total === 128) {
    assert.equal(result.view.nodes.length, total);
    assert.equal('viewError' in result, false);
  } else {
    assert.equal(result.view, null);
    assert.ok(result.viewError);
  }
  assert.equal(result.envelope.blocks.length, 63);
});

for (const depth of [6, 7]) test(`View semantic depth ${depth} has the required consumption boundary`, () => {
  const message = clone(fixtures.message), nodes = [];
  for (let index = 1; index < depth; index++) nodes.push({ id: `node_${index}`, type: 'stack', children: [`node_${index + 1}`] });
  nodes.push({ id: `node_${depth}`, type: 'block', blockId: 'plan_a' });
  message.metadata = { view: { schemaVersion: 1, root: 'node_1', nodes } };
  const result = parseC4Content(encode(message));
  assert.equal(result.kind, 'envelope');
  assert.equal(result.view === null, depth === 7);
  assert.equal('viewError' in result, depth === 7);
});

test('flat child references fit the six-level metadata budget', () => {
  const message = clone(fixtures.message);
  message.metadata = { view: clone(fixtures.views[0].view) };
  const result = parseC4Content(encode(message));
  assert.equal(result.kind, 'envelope');
  assert.deepEqual(result.view, message.metadata.view);
});

test('overdeep data inside View is dropped while unrelated overdeep metadata invalidates the base', () => {
  const message = clone(fixtures.message);
  message.metadata = { view: clone(fixtures.views[0].view) };
  message.metadata.view.nodes[1].props = { nested: { text: 'depth seven' } };
  const result = parseC4Content(encode(message));
  assert.equal(result.kind, 'envelope');
  assert.equal(result.view, null);
  assert.ok(result.viewError);
  const other = clone(fixtures.message);
  other.metadata = { a: { b: { c: { d: { e: 'depth six' } } } } };
  assert.equal(parseC4Content(encode(other)).kind, 'envelope');
  other.metadata.a.b.c.d.e = { f: 'depth seven' };
  assert.equal(parseC4Content(encode(other)).kind, 'invalid');
});

for (const fixture of fixtures.formStates) test(`conditional form state evaluates ${fixture.name}`, () => {
  const original = clone(fixture.values);
  const result = evaluateFormState(fixture.fields, fixture.values);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.activeKeys, fixture.activeKeys);
  assert.deepEqual(fixture.values, original);
  assert.deepEqual(evaluateFormState(fixture.fields, fixture.values), result);
});

for (const fixture of fixtures.invalidDefinitions) test(`conditional form definition rejects ${fixture.name}`, () => {
  const state = evaluateFormState(fixture.fields, {});
  assert.deepEqual(state.activeKeys, []);
  assert.ok(Array.isArray(state.errors) && state.errors.length > 0);
  assert.ok(state.errors.every(error => typeof error === 'string' && error.length > 0));
  const question = clone(fixtures.formQuestion);
  question.blocks[0].data.fields = clone(fixture.fields);
  assert.equal(parseC4Content(encode(question)).kind, 'invalid');
});

for (const fixture of fixtures.answers) test(`conditional form answer validates ${fixture.name}`, () => {
  assert.equal(parseC4Content(encode(fixtures.formQuestion)).kind, 'envelope');
  const action = formAction(clone(fixture.values));
  assert.equal(action.protocolVersion, '0.1');
  assert.equal(validateAnswer(action, fixtures.formQuestion), fixture.valid);
});

test('a conditional form needs no View and remains in a version-one C4 envelope', () => {
  const result = parseC4Content(encode(fixtures.formQuestion));
  assert.equal(result.kind, 'envelope');
  assert.equal(result.envelope.version, 1);
  assert.equal(result.envelope.blocks[0].schemaVersion, 2);
  assert.equal(result.view, null);
  assert.equal(validateAnswer(formAction({ customer_type: 'person' }), fixtures.formQuestion), true);
});

test('conditional form answers use the stored block version and keep free-text rules', () => {
  const legacy = clone(fixtures.formQuestion);
  legacy.blocks[0].schemaVersion = 1;
  assert.equal(parseC4Content(encode(legacy)).kind, 'invalid', 'v1 never accepts activeWhen');
  const free = formAction({}); delete free.payload.values; free.payload.freeText = 'Ask me later';
  assert.equal(validateAnswer(free, fixtures.formQuestion), true);
  const noOther = clone(fixtures.formQuestion); noOther.interrupt.otherInput = false;
  assert.equal(validateAnswer(free, noOther), false);
  const wrong = formAction({ customer_type: 'person' }); wrong.protocolVersion = '0.2';
  assert.equal(validateAnswer(wrong, fixtures.formQuestion), false);
});

test('invalid layout on a conditional question preserves valid active-field answers', () => {
  const question = clone(fixtures.formQuestion);
  question.metadata = { view: { schemaVersion: 99, root: 'missing', nodes: [] } };
  assert.equal(parseC4Content(encode(question)).kind, 'envelope');
  assert.equal(validateAnswer(formAction({ customer_type: 'person' }), question), true);
  assert.equal(validateAnswer(formAction({ customer_type: 'person', company_name: null }), question), false);
});

for (const component of COMPONENT_DEFINITIONS.filter(item => item.type !== 'form_intent')) test(`schema version two is rejected for ${component.type}`, () => {
  const envelope = clone(component.example);
  envelope.blocks.find(block => block.type === component.type).schemaVersion = 2;
  assert.equal(parseC4Content(encode(envelope)).kind, 'invalid');
});

test('conditional string constants do not acquire the answer text length limit', () => {
  const fields = [{ key: 'source', label: 'Source', type: 'text' },
    { key: 'detail', label: 'Detail', type: 'text', activeWhen: { field: 'source', eq: 'x'.repeat(2100) } }];
  assert.deepEqual(evaluateFormState(fields, {}), { activeKeys: ['source'], errors: [] });
  const question = clone(fixtures.formQuestion);
  question.blocks[0].data.fields = fields;
  assert.equal(parseC4Content(encode(question)).kind, 'envelope');
});

test('balanced columns reject five otherwise independent complete blocks', () => {
  const message = { version: 1, kind: 'message', messageId: 'five_columns', fallbackText: 'Five complete blocks', blocks: [],
    metadata: { view: { schemaVersion: 1, root: 'root', nodes: [{ id: 'root', type: 'columns', children: [] }] } } };
  for (let index = 0; index < 5; index++) {
    message.blocks.push({ id: `block_${index}`, type: 'markdown', schemaVersion: 1, data: { text: `Block ${index}` } });
    message.metadata.view.nodes[0].children.push(`node_${index}`);
    message.metadata.view.nodes.push({ id: `node_${index}`, type: 'block', blockId: `block_${index}` });
  }
  const result = parseC4Content(encode(message));
  assert.equal(result.kind, 'envelope');
  assert.equal(result.view, null);
  assert.ok(result.viewError);
});
