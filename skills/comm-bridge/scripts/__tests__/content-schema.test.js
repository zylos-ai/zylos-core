import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CONTENT_PREFIX, MAX_CONTENT_BYTES, parseC4Content, findC4ContentError,
  validateAnswer, validateHookInput, validateHookOutput, validateDeliveryPacket,
} from '../c4-content-schema.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const encode = value => CONTENT_PREFIX + JSON.stringify(value);

// Pure shared-parser boundary. Run for invalid-content display or acceptance
// changes; unrelated UI/transport changes may skip. No storage or runtime starts.
for (const [name, change] of [
  ['unknown block', envelope => { envelope.blocks[0].type = 'unknown'; }],
  ['unknown version', envelope => { envelope.version = 999; }],
  ['unknown envelope field', envelope => { envelope.extra = true; }],
  ['missing blocks', envelope => { delete envelope.blocks; }],
]) test(`invalid ${name} retains only whole-message fallback without accepting blocks`, () => {
  const example = fixtures.actions.find(row => row.name === 'other_input');
  const envelope = structuredClone(example.question);
  envelope.fallbackText = '<img src=x onerror=alert(1)> **literal** [link](javascript:alert(1))';
  envelope.metadata = { private: 'HIDDEN_METADATA' };
  change(envelope);
  const result = parseC4Content(encode(envelope));
  assert.deepEqual(result, { kind: 'invalid', reason: 'invalid_envelope', fallbackText: envelope.fallbackText });
  assert.equal('blocks' in result || 'envelope' in result, false);
  assert.deepEqual(parseC4Content(encode(envelope), { submission: true }), result);
  assert.notEqual(findC4ContentError(encode(envelope)), null);
  assert.equal(validateAnswer(example.action, envelope), false);
});

for (const fixture of fixtures.valid) test(`content envelope accepts ${fixture.name}`, () => {
  const result = parseC4Content(fixture.content);
  assert.equal(result.kind, 'envelope');
  assert.deepEqual(result.envelope, fixture.envelope);
  if (fixture.name === 'answer_cancel_suppressed') {
    assert.equal(result.envelope.metadata.zylos.answerId, 'answer_cancel');
    assert.ok(result.suffix.includes('Status notification suppressed'));
  }
});
for (const fixture of fixtures.invalid) test(`content envelope rejects ${fixture.name}`, () => {
  const result = parseC4Content(fixture.content);
  assert.equal(result.kind, 'invalid');
  assert.equal(result.reason, fixture.reason);
  assert.equal('envelope' in result || 'text' in result, false);
});
for (const { name, content } of fixtures.ordinary) test(`unmarked content remains ordinary text ${name}`, () => {
  assert.deepEqual(parseC4Content(content), { kind: 'text', text: content });
});
for (const fixture of fixtures.actions) test(`answer constraints ${fixture.name}`, () => {
  assert.equal(validateAnswer(fixture.action, fixture.question), fixture.valid);
});
for (const fixture of fixtures.delivery) test(`delivery authority ${fixture.name}`, () => {
  assert.equal(validateDeliveryPacket(fixture.packet, fixture.row), fixture.valid);
});
for (const fixture of fixtures.hookInputs) test(`hook input ${fixture.name}`, () => {
  assert.equal(validateHookInput(fixture.value), fixture.valid);
});
for (const fixture of fixtures.hookOutputs) test(`hook output ${fixture.name}`, () => {
  assert.equal(validateHookOutput(fixture.value), fixture.valid);
});

test('content byte limit includes multibyte text and framing at the exact boundary', () => {
  assert.equal(MAX_CONTENT_BYTES, 65536);
  const plain = '中'.repeat(21845) + 'a';
  assert.equal(Buffer.byteLength(plain), MAX_CONTENT_BYTES);
  assert.equal(parseC4Content(plain).kind, 'text');
  assert.equal(Buffer.byteLength(plain + 'a'), 65537);
  assert.deepEqual(parseC4Content(plain + 'a'), { kind: 'text', text: plain + 'a' });
  const envelope = structuredClone(fixtures.valid[0].envelope);
  envelope.metadata = { padding: '中'.repeat(20000) };
  const short = encode(envelope);
  envelope.metadata.padding += 'a'.repeat(MAX_CONTENT_BYTES - Buffer.byteLength(short));
  const exact = encode(envelope);
  assert.equal(Buffer.byteLength(exact), MAX_CONTENT_BYTES);
  assert.equal(parseC4Content(exact).kind, 'envelope');
  assert.deepEqual(parseC4Content(exact + ' '), { kind: 'invalid', reason: 'content_too_large' });
});
