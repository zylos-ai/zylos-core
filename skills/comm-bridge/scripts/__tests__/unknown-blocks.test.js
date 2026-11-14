import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONTENT_PREFIX, MAX_CONTENT_BYTES, BLOCK_SCHEMA, REGISTERED_COMPONENT_KEYS,
  parseC4Content, findC4ContentError, validateAnswer } from '../c4-content-schema.js';
import { projectC4Content, previewMessage } from '../c4-content-projection.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const encode = envelope => CONTENT_PREFIX + JSON.stringify(envelope);
const unknown = (id = 'future') => ({ id, type: 'future_widget', schemaVersion: 1, fallbackText: 'Future block only', data: { private: 'HIDDEN_DATA' } });
const markdown = { id: 'intro', type: 'markdown', schemaVersion: 1, data: { text: 'Known text' } };
const message = (blocks = [markdown, unknown()]) => ({ version: 1, kind: 'message', messageId: 'ordinary-message', fallbackText: 'Whole message summary', blocks: structuredClone(blocks) });
const invalid = envelope => ({ kind: 'invalid', reason: 'invalid_envelope', fallbackText: envelope.fallbackText });

// Pure parser/projection boundary. Run for unknown-type compatibility or strict
// acceptance changes; skip unrelated UI/transport changes. No storage or runtime.
test('historical unknown blocks retain envelope data and ordered compatibility markers only', () => {
  const envelope = message([unknown('first'), markdown, unknown('last')]);
  const suffix = '\n\n[C4] Status notification suppressed by cooldown while health=unavailable reason=down.';
  const before = JSON.stringify(envelope);
  const parsed = parseC4Content(encode(envelope) + suffix);
  assert.deepEqual(parsed, { kind: 'envelope', envelope, suffix, view: null,
    unsupportedBlocks: [{ index: 0, id: 'first', reason: 'unknown_type' }, { index: 2, id: 'last', reason: 'unknown_type' }] });
  assert.equal('fallbackText' in parsed, false);
  assert.equal(JSON.stringify(envelope), before);
  const known = message([markdown]);
  assert.deepEqual(parseC4Content(encode(known)), { kind: 'envelope', envelope: known, suffix: '', view: null });
});

test('historical unknown blocks accept schema version two with a compatibility marker', () => {
  const envelope = message([{ ...unknown(), schemaVersion: 2 }]);
  assert.deepEqual(parseC4Content(encode(envelope)), {
    kind: 'envelope', envelope, suffix: '', view: null,
    unsupportedBlocks: [{ index: 0, id: 'future', reason: 'unknown_type' }],
  });
});

test('the same unknown content is readable in history and rejected by strict submission diagnostics', () => {
  const content = encode(message());
  assert.equal(parseC4Content(content).kind, 'envelope');
  assert.deepEqual(parseC4Content(content, { submission: true }), invalid(message()));
  assert.equal(findC4ContentError(content)?.path, '/blocks/1/type');
  assert.equal(findC4ContentError(content)?.code, 'enum');
  assert.equal(BLOCK_SCHEMA.properties.type.enum.includes('future_widget'), false);
  assert.equal(REGISTERED_COMPONENT_KEYS.some(key => key.startsWith('future_widget@')), false);
});

for (const [name, change] of [
  ['missing fallback', block => { delete block.fallbackText; }],
  ['empty fallback', block => { block.fallbackText = ''; }],
  ['non-string fallback', block => { block.fallbackText = null; }],
  ['long fallback', block => { block.fallbackText = '😀'.repeat(2001); }],
  ['missing id', block => { delete block.id; }],
  ['invalid id', block => { block.id = 'bad id'; }],
  ['missing version', block => { delete block.schemaVersion; }],
  ['unsupported version', block => { block.schemaVersion = 999; }],
  ['missing data', block => { delete block.data; }],
  ['non-object data', block => { block.data = []; }],
  ['extra property', block => { block.extra = true; }],
  ['invalid status', block => { block.status = 'invented'; }],
  ['reason on complete block', block => { block.reason = 'private reason'; }],
  ['adapter provenance', block => { block.metadata = { provenance: 'adapter' }; }],
  ['invalid metadata', block => { block.metadata = []; }],
  ['empty type', block => { block.type = ''; }],
  ['non-string type', block => { block.type = {}; }],
]) test(`historical unknown blocks still reject ${name}`, () => {
  const envelope = message(); change(envelope.blocks[1]);
  assert.deepEqual(parseC4Content(encode(envelope)), invalid(envelope));
});

test('unknown fallback Unicode limits and pending/error generic shapes remain legal', () => {
  for (const fallbackText of ['😀'.repeat(2000)]) {
    const block = { ...unknown(), fallbackText };
    assert.equal(parseC4Content(encode(message([block]))).kind, 'envelope');
  }
  for (const status of ['pending', 'error']) {
    const block = { ...unknown(), status }; delete block.data;
    if (status === 'error') block.reason = 'Waiting for support';
    assert.equal(parseC4Content(encode(message([block]))).kind, 'envelope');
  }
});

const nested = depth => { let value = 'leaf'; for (let i = 1; i < depth; i++) value = { nested: value }; return value; };
test('unknown blocks retain data depth node byte count and duplicate-id limits', () => {
  const envelope = message([unknown()]);
  envelope.blocks[0].data = nested(6);
  assert.equal(parseC4Content(encode(envelope)).kind, 'envelope');
  envelope.blocks[0].data = nested(7);
  assert.deepEqual(parseC4Content(encode(envelope)), invalid(envelope));
  envelope.blocks[0].data = { nodes: Array(5000).fill(0) };
  assert.deepEqual(parseC4Content(encode(envelope)), invalid(envelope));
  envelope.blocks = Array.from({ length: 64 }, (_, i) => unknown(`future${i}`));
  assert.equal(parseC4Content(encode(envelope)).kind, 'envelope');
  envelope.blocks.push(unknown('overflow'));
  assert.deepEqual(parseC4Content(encode(envelope)), invalid(envelope));
  envelope.blocks = [unknown('same'), { ...markdown, id: 'same' }];
  assert.deepEqual(parseC4Content(encode(envelope)), invalid(envelope));
  envelope.blocks = [unknown('same'), unknown('same')];
  assert.deepEqual(parseC4Content(encode(envelope)), invalid(envelope));
  envelope.blocks = [unknown()]; envelope.blocks[0].data = { padding: '' };
  const padding = MAX_CONTENT_BYTES - Buffer.byteLength(encode(envelope));
  envelope.blocks[0].data.padding = 'x'.repeat(padding);
  assert.equal(Buffer.byteLength(encode(envelope)), MAX_CONTENT_BYTES);
  assert.equal(parseC4Content(encode(envelope)).kind, 'envelope');
  envelope.blocks[0].data.padding += 'x';
  assert.deepEqual(parseC4Content(encode(envelope)), { kind: 'invalid', reason: 'content_too_large' });
});

test('unknown tolerance never hides invalid known siblings or envelope fields', () => {
  for (const name of ['markdown', 'time_series']) {
    const block = structuredClone(fixtures.valid.find(row => row.name === name).envelope.blocks[0]);
    block.id = 'known'; block.data = {};
    const envelope = message([unknown(), block]);
    assert.deepEqual(parseC4Content(encode(envelope)), invalid(envelope));
  }
  for (const patch of [{ version: 999 }, { extra: true }, { metadata: [] }]) {
    const envelope = { ...message(), ...patch };
    assert.deepEqual(parseC4Content(encode(envelope)), invalid(envelope));
  }
});

test('each question field excludes tolerance even when null or incomplete', () => {
  for (const key of ['interruptId', 'questionSummary', 'interrupt']) {
    for (const value of [null, key === 'interrupt' ? {} : 'question']) {
      const envelope = { ...message(), [key]: value };
      assert.deepEqual(parseC4Content(encode(envelope)), invalid(envelope));
    }
  }
  const example = fixtures.actions.find(row => row.name === 'other_input');
  const question = structuredClone(example.question);
  assert.equal(validateAnswer(example.action, question), true);
  question.blocks.push(unknown());
  assert.deepEqual(parseC4Content(encode(question)), invalid(question));
  assert.equal(validateAnswer(example.action, question), false);
  assert.equal(validateAnswer(example.action, question, { historical: true }), false);
  question.blocks.pop(); question.blocks[0].type = 'future_question';
  assert.deepEqual(parseC4Content(encode(question)), invalid(question));
});

test('answers and controls reject unknown block additions and keep known parsing unchanged', () => {
  for (const name of ['answer_cancel', 'stop', 'replace']) {
    const envelope = structuredClone(fixtures.valid.find(row => row.name === name).envelope);
    assert.equal(parseC4Content(encode(envelope)).kind, 'envelope');
    assert.equal('unsupportedBlocks' in parseC4Content(encode(envelope)), false);
    envelope.blocks = [unknown()];
    assert.deepEqual(parseC4Content(encode(envelope)), invalid(envelope));
  }
});

test('projection and preview equal known content with the same whole-message fallback and references', () => {
  const envelope = message(), known = message([markdown]);
  const content = encode(envelope), expected = projectC4Content(encode(known), { c4Id: 81 });
  assert.equal(projectC4Content(content, { c4Id: 81 }), expected);
  assert.equal(expected, 'Whole message summary\n[C4 messageId=ordinary-message; c4_id=81]');
  assert.deepEqual(previewMessage(content), previewMessage(encode(known)));
  assert.equal(expected.includes('Future block only') || expected.includes('HIDDEN_DATA'), false);
});
