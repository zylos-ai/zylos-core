import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateBeforeSend } from '../scripts/send-hook.js';
import { CONTENT_PREFIX, MAX_CONTENT_BYTES, parseC4Content, validateHookOutput } from '../../comm-bridge/scripts/c4-content-schema.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const wire = content => {
  const input = structuredClone(fixtures.hookInputs.find(row => row.name === 'valid_input').value);
  input.request.content = content;
  return input;
};
const accepts = content => assert.deepEqual(evaluateBeforeSend(wire(content)), { version: 1, decision: 'continue' });
const rejects = content => {
  const result = evaluateBeforeSend(wire(content));
  assert.equal(validateHookOutput(result), true);
  assert.equal(result.decision, 'abort');
  assert.equal(result.message.includes(content), false);
};

for (const fixture of fixtures.ordinary) test(`Dashboard hook accepts unmarked ${fixture.name}`, () => {
  accepts(fixture.content);
});

test('Dashboard hook accepts ordinary JSON and Core status text without rewriting the request', () => {
  for (const content of ['{"version":1,"fallbackText":"ordinary JSON"}', '[C4] Status: runtime unavailable.', 'Unicode 😀 中 "quotes"\nnext line']) {
    const input = wire(content), before = JSON.stringify(input);
    assert.deepEqual(evaluateBeforeSend(input), { version: 1, decision: 'continue' });
    assert.equal(JSON.stringify(input), before);
  }
});

test('Dashboard hook counts UTF-8 bytes at the exact plain-text limit', () => {
  for (const exact of ['中'.repeat(21845) + 'a', '😀'.repeat(16384)]) {
    assert.equal(Buffer.byteLength(exact, 'utf8'), MAX_CONTENT_BYTES);
    accepts(exact);
    rejects(exact + 'a');
  }
});

test('Dashboard hook permits every valid shared envelope without rewriting content', () => {
  for (const fixture of fixtures.valid) {
    const input = wire(fixture.content), before = JSON.stringify(input);
    assert.deepEqual(evaluateBeforeSend(input), { version: 1, decision: 'continue' }, fixture.name);
    assert.equal(JSON.stringify(input), before);
  }
});

test('Dashboard hook aborts malformed or unsupported marked envelopes', () => {
  for (const fixture of fixtures.invalid) {
    assert.ok(fixture.content.startsWith(CONTENT_PREFIX));
    rejects(fixture.content);
  }
  rejects(CONTENT_PREFIX);
});

test('Dashboard hook rejects invalid wire and wrong channel or declaration identity', () => {
  const inputs = [null, {}, { ...wire('text'), version: 2 }, { ...wire('text'), hook_id: 'other.content' }];
  const other = wire('text'); other.request.channel = 'other'; inputs.push(other);
  const emptyContext = wire('text'); emptyContext.context.runtime = ''; inputs.push(emptyContext);
  for (const input of inputs) {
    const result = evaluateBeforeSend(input);
    assert.equal(result.decision, 'abort');
    assert.equal(validateHookOutput(result), true);
  }
});

const viewForms = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/view-and-form.json', import.meta.url), 'utf8'));

// Producer/consumer split only; pure shared-schema/hook calls, no storage or IO.
// Run for View degradation or BeforeSend changes; skip unrelated HTTP/UI work.
test('Dashboard hook rejects degraded Views while the reader retains legal Content', () => {
  for (const fixture of viewForms.views) {
    const envelope = structuredClone(viewForms.message);
    envelope.metadata = { view: fixture.view };
    const content = CONTENT_PREFIX + JSON.stringify(envelope);
    const parsed = parseC4Content(content);
    assert.equal(parsed.kind, 'envelope', fixture.name);
    const input = wire(content), original = JSON.stringify(input);
    const result = evaluateBeforeSend(input);
    assert.equal(result.decision, fixture.valid ? 'continue' : 'abort', fixture.name);
    assert.equal(validateHookOutput(result), true);
    assert.equal(JSON.stringify(input), original);
    if (!fixture.valid) {
      assert.ok(parsed.viewError, fixture.name);
      assert.equal(result.message.includes(content), false);
    }
  }
});

test('Dashboard hook accepts a conditional form without View and rejects invalid definitions', () => {
  accepts(CONTENT_PREFIX + JSON.stringify(viewForms.formQuestion));
  const envelope = structuredClone(viewForms.formQuestion);
  envelope.blocks.find(block => block.type === 'form_intent').data.fields = viewForms.invalidDefinitions[0].fields;
  rejects(CONTENT_PREFIX + JSON.stringify(envelope));
});
