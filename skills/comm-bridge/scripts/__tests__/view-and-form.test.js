import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONTENT_PREFIX, parseC4Content, validateAnswer } from '../c4-content-schema.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/view-and-form.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);
const encode = value => CONTENT_PREFIX + JSON.stringify(value);
const suffix = '\n\n[C4] Status notification suppressed by cooldown while health=unavailable reason=waiting for recovery.';
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

for (const fixture of fixtures.answers) test(`conditional form answer validates ${fixture.name}`, () => {
  assert.equal(parseC4Content(encode(fixtures.formQuestion)).kind, 'envelope');
  const action = formAction(clone(fixture.values));
  assert.equal(action.protocolVersion, '0.1');
  assert.equal(validateAnswer(action, fixtures.formQuestion), fixture.valid);
});
