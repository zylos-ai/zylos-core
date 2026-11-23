import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONTENT_PREFIX, parseC4Content, validateAnswer } from '../c4-content-schema.js';

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

// Pure parser and answer boundaries: only static fixtures and imported product
// functions. Run for submission rules or historical compatibility changes;
// unrelated transport, storage and presentation changes may skip.

for (const version of [1, 2]) {

  test(`form version ${version} preserves false and zero in required fields`, () => {
    const { question, action } = form(version,
      [field('boolean', { required: true }), field('number', { key: 'count', required: true })], { value: false, count: 0 });
    assert.equal(strictParse(question).kind, 'envelope');
    assert.equal(validateAnswer(action, question), true);
  });
}

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
