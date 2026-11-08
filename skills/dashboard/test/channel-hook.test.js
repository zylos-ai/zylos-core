import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateBeforeSend } from '../scripts/send-hook.js';
import { CONTENT_PREFIX, MAX_CONTENT_BYTES, parseC4Content, validateHookOutput, makeQuestionSummary, COMPONENT_DEFINITIONS } from '../../comm-bridge/scripts/c4-content-schema.js';

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


for (const component of COMPONENT_DEFINITIONS.filter(item => item.interactive)) {
  test(`Dashboard hook explains and enforces the derived summary for ${component.key}`, () => {
    const envelope = structuredClone(component.example);
    const block = envelope.blocks.find(item => item.id === envelope.interrupt.blockId);
    block.fallbackText = '  Correct   question\n' + '😀'.repeat(510);
    envelope.questionSummary = 'PRIVATE_SUMMARY_DO_NOT_ECHO';
    const content = CONTENT_PREFIX + JSON.stringify(envelope);
    assert.equal(parseC4Content(content).kind, 'invalid');
    const result = evaluateBeforeSend(wire(content));
    assert.equal(result.decision, 'abort');
    assert.match(result.message, /questionSummary must equal the interrupted block's derived summary/);
    assert.match(result.message, /fallbackText/);
    assert.equal(result.message.includes(envelope.questionSummary), false);
    assert.equal(result.message.includes(block.fallbackText), false);
    envelope.questionSummary = makeQuestionSummary(envelope);
    assert.equal(envelope.questionSummary, 'Correct question ' + '😀'.repeat(483));
    assert.equal([...envelope.questionSummary].length, 500);
    accepts(CONTENT_PREFIX + JSON.stringify(envelope));
  });
}

test('Dashboard hook reports the first safe structural or framing reason without reflecting submitted data', () => {
  const marker = 'PRIVATE_CONTENT_DO_NOT_ECHO';
  const envelope = structuredClone(fixtures.valid.find(item => item.name === 'confirmation').envelope);
  const cases = [
    [CONTENT_PREFIX + '{"' + marker, /Expected one JSON object after the C4 marker/],
    [CONTENT_PREFIX + JSON.stringify({ ...envelope, version: 2, fallbackText: marker }), /Envelope version must be 1/],
    [CONTENT_PREFIX + JSON.stringify({ ...envelope, blocks: [{ ...envelope.blocks[0], [marker]: marker }] }), /blocks\[0\] does not match a supported block schema/],
    [CONTENT_PREFIX + JSON.stringify({ ...envelope, [marker]: marker }), /Envelope fields do not match the required/],
    [CONTENT_PREFIX + JSON.stringify(envelope) + marker, /Unexpected text follows the structured JSON object/],
  ];
  for (const [content, reason] of cases) {
    const result = evaluateBeforeSend(wire(content));
    assert.equal(result.decision, 'abort');
    assert.equal(validateHookOutput(result), true);
    assert.match(result.message, reason);
    assert.equal(result.message.includes(marker), false);
  }
});


test('Dashboard hook explains when an interrupt does not identify an interactive block', () => {
  for (const blockId of ['missing_target', 'plain_context']) {
    const envelope = structuredClone(fixtures.valid.find(item => item.name === 'confirmation').envelope);
    envelope.blocks.push({ id: 'plain_context', type: 'markdown', schemaVersion: 1,
      data: { text: 'Context only' }, fallbackText: 'Context only' });
    envelope.interrupt.blockId = blockId;
    const content = CONTENT_PREFIX + JSON.stringify(envelope);
    const input = wire(content), before = JSON.stringify(input);
    assert.equal(parseC4Content(content).kind, 'invalid');
    const result = evaluateBeforeSend(input);
    assert.equal(result.decision, 'abort');
    assert.equal(validateHookOutput(result), true);
    assert.match(result.message, /interrupt\.blockId must identify an interactive block/);
    assert.doesNotMatch(result.message, /register|missing_target|plain_context/);
    assert.equal(JSON.stringify(input), before);
  }
});
