import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONTENT_PREFIX, parseC4Content, evaluateFormState, validateAnswer, validateFormFields } from '../c4-content-schema.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/view-and-form.json', import.meta.url), 'utf8'));
const expected = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/form-field-errors.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);
const actionFor = (question, values) => ({ id: 'field_answer', protocolVersion: '0.1', type: 'form.submit', target: 'customer.register',
  context: { messageId: question.messageId, blockId: 'customer_form' }, payload: { values } });
const success = result => !result.formError && result.errors.length === 0;
const diagnostics = (question, values) => validateFormFields(question.blocks[0].data.fields, values);

// Pure shared-schema boundary, with static fixtures only. Run for form-field or
// answer validation changes; unrelated transport/UI changes may skip. Fixed
// expectations use a valid v2 question and matching form.values Action;
// protocol, context, permissions and freeText are not field diagnostics.
for (const example of fixtures.answers) test(`shared field diagnostics preserve fixed reasons for ${example.name}`, () => {
  const question = clone(fixtures.formQuestion), values = clone(example.values);
  const before = JSON.stringify({ question, values });
  assert.equal(parseC4Content(CONTENT_PREFIX + JSON.stringify(question)).kind, 'envelope');
  const result = diagnostics(question, values);
  assert.deepEqual(result.errors, expected[example.name]);
  assert.equal(result.formError, undefined);
  assert.equal(success(result), example.valid);
  assert.equal(validateAnswer(actionFor(question, values), question), example.valid);
  assert.equal(JSON.stringify({ question, values }), before);
});

const types = [
  ['text', { maxLength: 3 }, ['abc', ''], [[4, 'type'], ['abcd', 'range']]],
  ['multiline_text', { maxLength: 3 }, ['a\nb', ''], [[false, 'type'], ['abcd', 'range']]],
  ['number', { min: 1, max: 3 }, [1, 2.5, 3], [['2', 'type'], [0, 'range'], [4, 'range']]],
  ['integer', { min: 1, max: 3 }, [1, 3], [[1.5, 'type'], ['2', 'type'], [0, 'range'], [4, 'range']]],
  ['boolean', {}, [false, true], [[0, 'type'], ['false', 'type']]],
  ['date', {}, ['2024-02-29'], [[4, 'type'], ['2025-02-29', 'type']]],
  ['datetime', {}, ['2024-02-29T12:30:00Z'], [[4, 'type'], ['2024-02-29T25:00:00Z', 'type']]],
  ['single_select', { options: [{ id: 'a', label: 'A' }] }, ['a'], [[4, 'type'], ['b', 'range']]],
  ['multi_select', { options: [{ id: 'a', label: 'A' }] }, [[], ['a']], [['a', 'type'], [[4], 'type'], [['b'], 'range'], [['a', 'a'], 'range']]],
];
for (const [type, constraints, accepted, rejected] of types) test(`${type} field reasons preserve saved type and bounds`, () => {
  const question = clone(fixtures.formQuestion);
  const field = { key: 'value', label: 'Value', type, required: true, ...constraints };
  question.blocks[0].data.fields = [field];
  assert.equal(parseC4Content(CONTENT_PREFIX + JSON.stringify(question)).kind, 'envelope');
  for (const value of accepted) {
    const values = { value }, result = diagnostics(question, values);
    assert.deepEqual(result, { activeKeys: ['value'], errors: [] });
    assert.equal(validateAnswer(actionFor(question, values), question), true);
  }
  for (const [value, reason] of [...rejected, [null, 'required'], [undefined, 'required']]) {
    const values = value === undefined ? {} : { value }, result = diagnostics(question, values);
    assert.deepEqual(result, { activeKeys: ['value'], errors: [{ key: 'value', reason }] });
    assert.equal(validateAnswer(actionFor(question, values), question), false);
  }
  field.required = false;
  for (const values of [{}, { value: null }]) {
    assert.equal(success(diagnostics(question, values)), true);
    assert.equal(validateAnswer(actionFor(question, values), question), true);
  }
});

test('field diagnostics keep dependency order and reject inactive keys before active errors', () => {
  const hidden = fixtures.formStates.find(item => item.name === 'inactive_upstream_ignores_saved_descendant');
  const restored = fixtures.formStates.find(item => item.name === 'restored_upstream_restores_chain');
  assert.deepEqual(validateFormFields(hidden.fields, hidden.values), { activeKeys: ['a'], errors: [
    { key: 'b', reason: 'inactive' }, { key: 'c', reason: 'inactive' },
  ] });
  assert.deepEqual(validateFormFields(restored.fields, restored.values), { activeKeys: restored.activeKeys, errors: [] });
  const fields = clone(fixtures.formQuestion.blocks[0].data.fields);
  assert.deepEqual(validateFormFields(fields, { customer_type: 'company', tag_note: null, unknown: 1 }).errors, [
    { key: 'tag_note', reason: 'inactive' }, { key: 'unknown', reason: 'unknown' },
    { key: 'company_name', reason: 'required' }, { key: 'employee_count', reason: 'required' },
  ]);
});

test('invalid definitions and non-object values have form errors rather than invented field keys', () => {
  for (const example of fixtures.invalidDefinitions) {
    const result = validateFormFields(example.fields, {});
    assert.equal(success(result), false);
    assert.equal(result.formError, evaluateFormState(example.fields, {}).errors[0]);
    assert.deepEqual(result.errors, []);
  }
  for (const values of [null, [], 'values']) {
    assert.deepEqual(validateFormFields(fixtures.formQuestion.blocks[0].data.fields, values), {
      activeKeys: [], errors: [], formError: 'invalid_form_values',
    });
  }
});

test('field diagnostics remain independent of stored View degradation', () => {
  const question = clone(fixtures.formQuestion), values = { customer_type: 'person' };
  const expected = diagnostics(question, values);
  const legal = { schemaVersion: 1, root: 'layout', nodes: [{ id: 'layout', type: 'block', blockId: 'customer_form' }] };
  const overdeep = clone(legal); overdeep.nodes[0].extra = { b: { c: 1 } };
  for (const view of [1, { schemaVersion: 99, root: 'x', nodes: [] },
    legal, overdeep]) {
    question.metadata = { view };
    assert.equal(parseC4Content(CONTENT_PREFIX + JSON.stringify(question)).kind, 'envelope');
    assert.deepEqual(diagnostics(question, values), expected);
    assert.equal(validateAnswer(actionFor(question, values), question), true);
  }
});

test('successful field diagnostics do not authorize an invalid action or replace free-text checks', () => {
  const question = clone(fixtures.formQuestion), values = { customer_type: 'person' };
  assert.equal(success(diagnostics(question, values)), true);
  for (const change of [
    action => { action.protocolVersion = '0.2'; },
    action => { action.context.messageId = 'other_message'; },
    action => { action.target = 'other.handler'; },
    action => { action.schemaVersion = 2; },
  ]) {
    const action = actionFor(question, values); change(action);
    assert.equal(validateAnswer(action, question), false);
  }
  const free = actionFor(question, {}); free.payload = { freeText: 'Please clarify' };
  assert.equal(success(diagnostics(question, {})), false);
  assert.equal(validateAnswer(free, question), true);
  question.interrupt.otherInput = false;
  assert.equal(validateAnswer(free, question), false);
});
