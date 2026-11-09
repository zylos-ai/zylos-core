import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONTENT_PREFIX, parseC4Content, validateAnswer, evaluateFormState, validateFormFields } from '../c4-content-schema.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);
const encode = value => CONTENT_PREFIX + JSON.stringify(value);
const strictParse = question => parseC4Content(encode(question), { submission: true });
function choice() {
  const example = fixtures.actions.find(item => item.name === 'other_input');
  const question = clone(example.question), action = clone(example.action);
  action.payload = { selected: ['a'] };
  return { question, action };
}
function form(version, fields, values) {
  const example = fixtures.actions.find(item => item.name === 'form_submit');
  const question = clone(example.question), action = clone(example.action);
  question.blocks[0].schemaVersion = version;
  question.blocks[0].data.fields = clone(fields);
  action.payload = { values: clone(values) };
  return { question, action };
}
const field = (type, extra = {}) => ({ key: 'value', label: 'Value', type, ...extra });
const options = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];

// Pure parser and answer boundaries: only static fixtures and imported product
// functions. Run for submission rules or historical compatibility changes;
// unrelated transport, storage and presentation changes may skip.
const invalidChoices = [
  ['duplicate option identifiers', data => { data.options[1].id = 'a'; }],
  ['minimum greater than option count', data => { data.selection = 'multiple'; data.minSelect = 3; }],
  ['minimum greater than option count with a larger explicit maximum', data => {
    data.options.push({ id: 'c', label: 'C' });
    Object.assign(data, { selection: 'multiple', minSelect: 4, maxSelect: 10 });
  }],
  ['minimum greater than maximum', data => { data.selection = 'multiple'; data.minSelect = 2; data.maxSelect = 1; }],
  ['single choice minimum greater than one', data => { data.minSelect = 2; }],
  ['zero minimum', data => { data.minSelect = 0; }],
];
for (const [name, change] of invalidChoices) test(`new choice submissions reject ${name}`, () => {
  const { question, action } = choice();
  assert.equal(strictParse(question).kind, 'envelope');
  assert.equal(validateAnswer(action, question), true);
  change(question.blocks[0].data);
  assert.equal(strictParse(question).kind, 'invalid');
  assert.equal(validateAnswer(action, question), false);
  assert.equal(parseC4Content(encode(question)).kind, 'envelope');
});

test('satisfiable multiple choice limits accept boundary answers', () => {
  const { question, action } = choice();
  Object.assign(question.blocks[0].data, { selection: 'multiple', minSelect: 1, maxSelect: 2 });
  assert.equal(strictParse(question).kind, 'envelope');
  for (const selected of [['a'], ['a', 'b']]) {
    assert.equal(validateAnswer({ ...action, payload: { selected } }, question), true);
  }
});

const definitions = [
  ['boolean default type', field('boolean', { defaultValue: 'false' }), field('boolean', { defaultValue: false }), false],
  ['number default type', field('number', { defaultValue: '2' }), field('number', { defaultValue: 2 }), 2],
  ['integer default type', field('integer', { defaultValue: '2' }), field('integer', { defaultValue: 2 }), 2],
  ['integer default fraction', field('integer', { defaultValue: 1.5 }), field('integer', { defaultValue: 1 }), 1],
  ['number bounds order', field('number', { min: 3, max: 1 }), field('number', { min: 1, max: 3 }), 2],
  ['integer bounds order', field('integer', { min: 3, max: 1 }), field('integer', { min: 1, max: 3 }), 2],
  ['default below minimum', field('number', { min: 1, defaultValue: 0 }), field('number', { min: 1, defaultValue: 1 }), 1],
  ['default above maximum', field('integer', { max: 3, defaultValue: 4 }), field('integer', { max: 3, defaultValue: 3 }), 3],
  ['text default type', field('text', { defaultValue: false }), field('text', { defaultValue: 'text' }), 'text'],
  ['text default length', field('text', { maxLength: 2, defaultValue: 'long' }), field('text', { maxLength: 2, defaultValue: 'ok' }), 'ok'],
  ['multiline default type', field('multiline_text', { defaultValue: 2 }), field('multiline_text', { defaultValue: 'ok' }), 'ok'],
  ['date default type', field('date', { defaultValue: false }), field('date', { defaultValue: '2024-02-29' }), '2024-02-29'],
  ['datetime default type', field('datetime', { defaultValue: 2 }), field('datetime', { defaultValue: '2024-02-29T12:30:00Z' }), '2024-02-29T12:30:00Z'],
  ['single select option identifiers', field('single_select', { options: [options[0], options[0]] }), field('single_select', { options }), 'a'],
  ['multi select option identifiers', field('multi_select', { options: [options[0], options[0]] }), field('multi_select', { options }), ['a']],
  ['single select default membership', field('single_select', { options, defaultValue: 'missing' }), field('single_select', { options, defaultValue: 'a' }), 'a'],
  ['multi select default membership', field('multi_select', { options, defaultValue: ['missing'] }), field('multi_select', { options, defaultValue: ['a'] }), ['a']],
  ['multi select default type', field('multi_select', { options, defaultValue: 'a' }), field('multi_select', { options, defaultValue: ['a'] }), ['a']],
  ['multi select default uniqueness', field('multi_select', { options, defaultValue: ['a', 'a'] }), field('multi_select', { options, defaultValue: ['a'] }), ['a']],
  ['non-select options', field('text', { options }), field('text'), 'text'],
  ['non-numeric minimum', field('text', { min: 1 }), field('text'), 'text'],
  ['non-numeric maximum', field('boolean', { max: 1 }), field('boolean'), false],
  ['null default', field('text', { defaultValue: null }), field('text', { defaultValue: '' }), 'text'],
];
for (const version of [1, 2]) {
  for (const [name, invalid, valid, value] of definitions) test(`form version ${version} checks ${name} before sending and answering`, () => {
    const good = form(version, [valid], { value });
    assert.equal(strictParse(good.question).kind, 'envelope');
    assert.equal(validateAnswer(good.action, good.question), true);
    const bad = form(version, [invalid], { value });
    assert.equal(strictParse(bad.question).kind, 'invalid');
    assert.equal(validateAnswer(bad.action, bad.question), false);
    assert.equal(parseC4Content(encode(bad.question)).kind, 'envelope');
  });
  test(`form version ${version} rejects duplicate field keys`, () => {
    const good = form(version, [field('text'), field('text', { key: 'other' })], { value: 'one', other: 'two' });
    assert.equal(strictParse(good.question).kind, 'envelope');
    assert.equal(validateAnswer(good.action, good.question), true);
    const bad = form(version, [field('text'), field('text')], { value: 'one' });
    assert.equal(strictParse(bad.question).kind, 'invalid');
    assert.equal(validateAnswer(bad.action, bad.question), false);
  });

  for (const type of ['text', 'multiline_text', 'multi_select']) test(`form version ${version} required ${type} rejects absent values`, () => {
    const definition = field(type, { required: true, ...(type === 'multi_select' ? { options } : {}) });
    const absent = type === 'multi_select' ? [[]] : ['', ' \t\n', '\u200b\u200c\u200d\ufeff', ' \u200b\t\u2060'];
    for (const value of absent) {
      const { question, action } = form(version, [definition], { value });
      assert.equal(strictParse(question).kind, 'envelope');
      assert.equal(validateAnswer(action, question), false);
      assert.equal(validateAnswer(action, question, { historical: true }), true);
      if (version === 2) assert.deepEqual(validateFormFields([definition], { value }).errors, [{ key: 'value', reason: 'required' }]);
      question.blocks[0].data.fields[0].required = false;
      assert.equal(validateAnswer(action, question), true);
    }
    const { question, action } = form(version, [definition], { value: type === 'multi_select' ? ['a'] : ' \u200ba' });
    assert.equal(validateAnswer(action, question), true);
  });

  test(`form version ${version} preserves false and zero in required fields`, () => {
    const { question, action } = form(version,
      [field('boolean', { required: true }), field('number', { key: 'count', required: true })], { value: false, count: 0 });
    assert.equal(strictParse(question).kind, 'envelope');
    assert.equal(validateAnswer(action, question), true);
  });
}

test('required values and present conditions share whitespace and zero-width handling', () => {
  for (const [type, values] of [
    ['text', ['', ' \t\n', '\u200b\u200c\u200d\ufeff', ' \u2060', 'visible']],
    ['multi_select', [[], ['a']]], ['number', [0]], ['boolean', [false]],
  ]) {
    const source = field(type, { required: true, ...(type === 'multi_select' ? { options } : {}) });
    const fields = [source, field('text', { key: 'detail', activeWhen: { field: 'value', present: true } })];
    for (const value of values) {
      const result = validateFormFields([source], { value });
      const active = evaluateFormState(fields, { value });
      assert.deepEqual(active.errors, []);
      assert.equal(active.activeKeys.includes('detail'), result.errors.length === 0);
    }
  }
});

test('historical conditional forms retain whitespace presence and their original answer', () => {
  const fields = [field('text'), field('text', { key: 'detail', required: true,
    activeWhen: { field: 'value', present: true } })];
  const values = { value: ' \t\n', detail: 'Original detail' };
  const { question, action } = form(2, fields, values);
  assert.equal(validateAnswer(action, question), false);
  assert.deepEqual(evaluateFormState(fields, values).activeKeys, ['value']);
  assert.deepEqual(evaluateFormState(fields, values, { historical: true }).activeKeys, ['value', 'detail']);
  assert.deepEqual(validateFormFields(fields, values, { historical: true }).errors, []);
  assert.equal(validateAnswer(action, question, { historical: true }), true);
  assert.deepEqual(action.payload.values, values);
});

test('historical duplicate choices and empty required answers retain their original values', () => {
  const duplicated = choice();
  duplicated.question.blocks[0].data.options[1].id = 'a';
  assert.equal(validateAnswer(duplicated.action, duplicated.question), false);
  assert.equal(validateAnswer(duplicated.action, duplicated.question, { historical: true }), true);
  assert.deepEqual(parseC4Content(encode(duplicated.question)).envelope, duplicated.question);
  for (const version of [1, 2]) {
    const { question, action } = form(version, [field('text', { required: true })], { value: '' });
    assert.equal(validateAnswer(action, question), false);
    assert.equal(validateAnswer(action, question, { historical: true }), true);
    assert.equal(action.payload.values.value, '');
    assert.deepEqual(parseC4Content(encode(question)).envelope, question);
  }
});

for (const allowFreeText of [undefined, true, false]) for (const otherInput of [undefined, true, false]) {
  test(`choice free text respects allowance ${allowFreeText} and other input ${otherInput}`, () => {
    const { question, action } = choice();
    if (allowFreeText !== undefined) question.blocks[0].data.allowFreeText = allowFreeText;
    if (otherInput !== undefined) question.interrupt.otherInput = otherInput;
    assert.equal(strictParse(question).kind, 'envelope');
    assert.equal(validateAnswer(action, question), true);
    action.payload = { freeText: 'Another answer' };
    assert.equal(validateAnswer(action, question), allowFreeText !== false && otherInput !== false);
    assert.equal(validateAnswer(action, question, { historical: true }), otherInput !== false);
  });
}

test('View references accept only complete blocks and degrade independently of answers', () => {
  for (const status of [undefined, 'complete', 'pending', 'error']) {
    const { question, action } = choice();
    question.blocks.push({ id: 'notice', type: 'markdown', schemaVersion: 1, fallbackText: 'Notice', data: { text: 'Notice' } });
    if (status !== undefined) question.blocks[1].status = status;
    if (status === 'pending' || status === 'error') delete question.blocks[1].data;
    question.metadata = { view: { schemaVersion: 1, root: 'layout', nodes: [{ id: 'layout', type: 'block', blockId: 'notice' }] } };
    const result = strictParse(question);
    assert.equal(result.kind, 'envelope');
    assert.equal(validateAnswer(action, question), true);
    if (status === undefined || status === 'complete') {
      assert.deepEqual(result.view, question.metadata.view);
      assert.equal('viewError' in result, false);
    } else {
      assert.equal(result.view, null);
      assert.equal(result.viewError, 'incomplete_view_block');
    }
  }
});
