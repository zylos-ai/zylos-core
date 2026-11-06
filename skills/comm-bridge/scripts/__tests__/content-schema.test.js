import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CONTENT_PREFIX, MAX_CONTENT_BYTES, parseC4Content, makeQuestionSummary,
  validateAnswer, normalizeHookMessage, validateHookInput, validateHookOutput, validateDeliveryPacket,
} from '../c4-content-schema.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const encode = value => CONTENT_PREFIX + JSON.stringify(value);
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

test('JSON scanner respects string braces escapes and accepts only the known suffix', () => {
  const envelope = structuredClone(fixtures.valid[0].envelope);
  envelope.metadata = { nested: { text: 'a } { \\" quote', more: [{ brace: '}' }] } };
  const raw = encode(envelope);
  assert.equal(parseC4Content(raw).kind, 'envelope');
  const suffix = '\n\n[C4] Status notification suppressed by cooldown while health=unavailable reason=down.';
  assert.equal(parseC4Content(raw + suffix).kind, 'envelope');
  assert.equal(parseC4Content(raw + suffix + suffix).kind, 'invalid');
  assert.equal(parseC4Content(raw + suffix + ' x').kind, 'invalid');
  assert.equal(parseC4Content(CONTENT_PREFIX + ' \n' + JSON.stringify(envelope) + '\t').kind, 'envelope');
});

test('hook messages count Unicode code points and normalize all line separators', () => {
  const message = '😀'.repeat(499) + '中';
  assert.equal([...normalizeHookMessage(message)].length, 500);
  assert.equal(normalizeHookMessage(message + '尾'), message);
  assert.equal(normalizeHookMessage('a\r\nb\rc\nd\u2028e\u2029f').includes('\n'), false);
  assert.match(normalizeHookMessage('a\r\nb\rc\nd\u2028e\u2029f'), /^a +b c d e f$/);
});

test('question summaries normalize whitespace and use the saved question block', () => {
  const question = structuredClone(fixtures.actions[0].question);
  question.blocks[0].fallbackText = ' \n 方案\t' + '😀'.repeat(501);
  assert.equal(makeQuestionSummary(question), [...('方案 ' + '😀'.repeat(501))].slice(0, 500).join(''));
  assert.equal([...makeQuestionSummary(question)].length, 500);
  question.questionSummary = makeQuestionSummary(question);
  assert.equal(parseC4Content(encode(question)).kind, 'envelope');
});

test('wire rejects invented context and rewritten output and compares exact delivery content', () => {
  assert.deepEqual(parseC4Content(null), { kind: 'invalid', reason: 'content_type' });
  const hook = fixtures.hookInputs[0].value;
  assert.equal(validateHookInput({ ...hook, c4_id: 1 }), false);
  assert.equal(validateHookInput({ ...hook, hook_event_name: 'BeforeReceive' }), false);
  assert.equal(validateHookInput({ ...hook, context: { c4_id: 1 } }), false);
  const delivery = fixtures.delivery[0];
  assert.equal(validateDeliveryPacket({ ...delivery.packet, c4_id: '123' }, delivery.row), true);
  for (const c4_id of [0, -1, '01', '9223372036854775808', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validateDeliveryPacket({ ...delivery.packet, c4_id }, delivery.row), false);
  }
  assert.equal(validateDeliveryPacket(delivery.packet, null), false);
  assert.equal(validateDeliveryPacket({ ...delivery.packet, content: delivery.packet.content + ' ' }, delivery.row), false);
});

test('all form field types enforce saved constraints rather than trusting payload shape', () => {
  const question = structuredClone(fixtures.actions.find(row => row.name === 'form_submit').question);
  const data = question.blocks[0].data;
  data.fields = [
    { key: 'text', label: 'Text', type: 'text', maxLength: 2, required: true },
    { key: 'notes', label: 'Notes', type: 'multiline_text', maxLength: 4 },
    { key: 'number', label: 'Number', type: 'number', min: 1, max: 3 },
    { key: 'integer', label: 'Integer', type: 'integer' },
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'time', label: 'Time', type: 'datetime' },
    { key: 'enabled', label: 'Enabled', type: 'boolean' },
    { key: 'one', label: 'One', type: 'single_select', options: [{ id: 'a', label: 'A' }] },
    { key: 'many', label: 'Many', type: 'multi_select', options: [{ id: 'a', label: 'A' }] },
  ];
  const action = structuredClone(fixtures.actions.find(row => row.name === 'form_submit').action);
  const values = { text: '😀中', notes: 'a\nb', number: 2.5, integer: 1, date: '2024-02-29',
    time: '2026-11-07T01:00:00+08:00', enabled: false, one: 'a', many: ['a'] };
  action.payload = { values };
  assert.equal(validateAnswer(action, question), true);
  for (const [key, invalid] of [['text', '😀中尾'], ['notes', '12345'], ['number', 4], ['integer', 1.1],
    ['date', '2025-02-29'], ['time', '2026-11-07T25:00:00Z'], ['enabled', 'true'], ['one', 'b'], ['many', ['a', 'a']]]) {
    assert.equal(validateAnswer({ ...action, payload: { values: { ...values, [key]: invalid } } }, question), false, key);
  }
});

test('free text answer length counts supplementary characters and excludes conflicting payloads', () => {
  const { question, action } = fixtures.actions.find(row => row.name === 'other_input');
  assert.equal(validateAnswer({ ...action, payload: { freeText: '😀'.repeat(500) } }, question), true);
  assert.equal(validateAnswer({ ...action, payload: { freeText: '😀'.repeat(501) } }, question), false);
  assert.equal(validateAnswer({ ...action, payload: { freeText: 'ok', selected: ['a'] } }, question), false);
  assert.equal(validateAnswer({ ...action, context: { ...action.context, messageId: 'other_question' } }, question), false);
});

test('schema rejects malformed charts destructive actions and ambiguous question references', () => {
  const chart = structuredClone(fixtures.valid.find(row => row.name === 'time_series').envelope);
  chart.blocks[0].data.series[0].points[0].y = 'not numeric';
  assert.equal(parseC4Content(encode(chart)).kind, 'invalid');
  const question = structuredClone(fixtures.valid.find(row => row.name === 'confirmation').envelope);
  question.blocks[0].data.severity = 'normal';
  assert.equal(parseC4Content(encode(question)).kind, 'invalid');
  const single = structuredClone(fixtures.valid.find(row => row.name === 'single').envelope);
  single.blocks.push(structuredClone(single.blocks[0]));
  assert.equal(parseC4Content(encode(single)).kind, 'invalid');
  single.blocks.pop(); single.interrupt.blockId = 'missing';
  assert.equal(parseC4Content(encode(single)).kind, 'invalid');
});

test('parse reasons preserve precedence at byte JSON suffix and schema boundaries', () => {
  assert.deepEqual(parseC4Content(CONTENT_PREFIX + '{' + 'x'.repeat(MAX_CONTENT_BYTES)),
    { kind: 'invalid', reason: 'content_too_large' });
  const invalidEnvelope = { ...fixtures.valid[0].envelope, version: 2 };
  assert.deepEqual(parseC4Content(encode(invalidEnvelope) + 'garbage'), { kind: 'invalid', reason: 'invalid_suffix' });
  assert.deepEqual(parseC4Content(encode(invalidEnvelope)), { kind: 'invalid', reason: 'invalid_envelope' });
});

test('message answer metadata and control reject unknown fields', () => {
  const message = structuredClone(fixtures.valid.find(row => row.name === 'markdown').envelope);
  message.extra = true;
  assert.deepEqual(parseC4Content(encode(message)), { kind: 'invalid', reason: 'invalid_envelope' });
  const answer = structuredClone(fixtures.valid.find(row => row.name === 'answer_cancel').envelope);
  answer.metadata.extra = true;
  assert.deepEqual(parseC4Content(encode(answer)), { kind: 'invalid', reason: 'invalid_envelope' });
  const control = structuredClone(fixtures.valid.find(row => row.name === 'stop').envelope);
  control.control.extra = true;
  assert.deepEqual(parseC4Content(encode(control)), { kind: 'invalid', reason: 'invalid_envelope' });
});

test('suppression suffix requires nonempty fields and permits intervening JSON whitespace', () => {
  const raw = fixtures.valid[0].content;
  const header = '\n\n[C4] Status notification suppressed by cooldown while health=';
  assert.deepEqual(parseC4Content(raw + header + ' reason=quota.'), { kind: 'invalid', reason: 'invalid_suffix' });
  assert.deepEqual(parseC4Content(raw + header + 'unavailable reason=.'), { kind: 'invalid', reason: 'invalid_suffix' });
  assert.equal(parseC4Content(raw + ' \t\r\n' + header + 'temporarily unavailable reason=quota exceeded.').kind, 'envelope');
});

test('suppression scanning stays bounded on a maximum-sized repetitive tail', t => {
  const start = CONTENT_PREFIX + '{}' + '\n\n[C4] Status notification suppressed by cooldown while health=';
  const length = MAX_CONTENT_BYTES - Buffer.byteLength(start);
  const tail = ' reason='.repeat(Math.ceil(length / ' reason='.length)).slice(0, length);
  const content = start + tail;
  assert.equal(Buffer.byteLength(content), MAX_CONTENT_BYTES);
  const before = performance.now();
  const result = parseC4Content(content);
  const elapsed = performance.now() - before;
  assert.deepEqual(result, { kind: 'invalid', reason: 'invalid_suffix' });
  assert.ok(elapsed < 200, `maximum repetitive tail took ${elapsed.toFixed(2)}ms`);
  t.diagnostic(`maximum repetitive tail: ${elapsed.toFixed(3)}ms`);
});

test('question reasons match their block type and referenced blocks must remain open', () => {
  for (const [name, reason] of [['single', 'confirmation'], ['confirmation', 'input_required']]) {
    const question = structuredClone(fixtures.valid.find(row => row.name === name).envelope);
    question.interrupt.reason = reason;
    assert.deepEqual(parseC4Content(encode(question)), { kind: 'invalid', reason: 'invalid_envelope' });
  }
  const question = structuredClone(fixtures.valid.find(row => row.name === 'single').envelope);
  question.blocks[0].data.state = { status: 'expired' };
  assert.deepEqual(parseC4Content(encode(question)), { kind: 'invalid', reason: 'invalid_envelope' });
});

test('multiple choice enforces both saved lower and upper selection bounds', () => {
  const fixture = fixtures.actions.find(row => row.name === 'multiple_select');
  const question = structuredClone(fixture.question), action = structuredClone(fixture.action);
  question.blocks[0].data.maxSelect = 1;
  assert.equal(validateAnswer(action, question), false);
  question.blocks[0].data.maxSelect = 3;
  question.blocks[0].data.minSelect = 2;
  action.payload.selected = ['a'];
  assert.equal(validateAnswer(action, question), false);
  action.payload.selected = ['a', 'b'];
  assert.equal(validateAnswer(action, question), true);
});

test('block counts and fallback Unicode limits include their exact maximum', () => {
  const envelope = structuredClone(fixtures.valid[0].envelope);
  envelope.blocks = Array.from({ length: 64 }, (_, index) => ({ id: `block${index}`, type: 'markdown', schemaVersion: 1, data: { text: '' } }));
  assert.equal(parseC4Content(encode(envelope)).kind, 'envelope');
  envelope.blocks.push({ id: 'block64', type: 'markdown', schemaVersion: 1, data: { text: '' } });
  assert.deepEqual(parseC4Content(encode(envelope)), { kind: 'invalid', reason: 'invalid_envelope' });
  envelope.blocks = [];
  envelope.fallbackText = '😀'.repeat(16000);
  assert.ok(Buffer.byteLength(encode(envelope)) < MAX_CONTENT_BYTES);
  assert.equal(parseC4Content(encode(envelope)).kind, 'envelope');
  envelope.fallbackText += '😀';
  assert.deepEqual(parseC4Content(encode(envelope)), { kind: 'invalid', reason: 'invalid_envelope' });
});

test('markdown UTF8 limit rejects the first multibyte character beyond its bound', () => {
  const envelope = structuredClone(fixtures.valid[0].envelope);
  envelope.blocks[0].data.text = '中'.repeat(10922) + 'aa';
  assert.equal(Buffer.byteLength(envelope.blocks[0].data.text), 32768);
  assert.equal(parseC4Content(encode(envelope)).kind, 'envelope');
  envelope.blocks[0].data.text = '中'.repeat(10923);
  assert.equal(Buffer.byteLength(envelope.blocks[0].data.text), 32769);
  assert.deepEqual(parseC4Content(encode(envelope)), { kind: 'invalid', reason: 'invalid_envelope' });
});

const nestedObject = depth => {
  let value = 'leaf';
  for (let level = 1; level < depth; level++) value = { nested: value };
  return value;
};
test('block data accepts depth six and rejects depth seven', () => {
  const envelope = structuredClone(fixtures.valid[0].envelope);
  const block = structuredClone(fixtures.valid.find(row => row.name === 'form').envelope.blocks[0]);
  block.data.state = { status: 'resolved', resolvedAt: '2026-11-07T00:00:00Z', values: { value: nestedObject(3) } };
  envelope.blocks = [block];
  assert.equal(parseC4Content(encode(envelope)).kind, 'envelope');
  block.data.state.values.value = nestedObject(4);
  assert.deepEqual(parseC4Content(encode(envelope)), { kind: 'invalid', reason: 'invalid_envelope' });
});

test('a single block accepts five thousand JSON nodes but rejects the next node', () => {
  const envelope = structuredClone(fixtures.valid[0].envelope);
  const block = { id: 'text', type: 'markdown', schemaVersion: 1, data: { text: 'x' }, metadata: { host: { nodes: Array(4991).fill(null) } } };
  const nodeCount = value => 1 + (value !== null && typeof value === 'object' ? Object.values(value).reduce((sum, child) => sum + nodeCount(child), 0) : 0);
  assert.equal(nodeCount(block), 5000);
  envelope.blocks = [block];
  assert.ok(Buffer.byteLength(encode(envelope)) < MAX_CONTENT_BYTES);
  assert.equal(parseC4Content(encode(envelope)).kind, 'envelope');
  block.metadata.host.nodes.push(null);
  assert.equal(nodeCount(block), 5001);
  assert.deepEqual(parseC4Content(encode(envelope)), { kind: 'invalid', reason: 'invalid_envelope' });
});

test('hook context rejects empty values and delivery distinguishes null from missing', () => {
  const hook = structuredClone(fixtures.hookInputs[0].value);
  hook.context.runtime = '';
  assert.equal(validateHookInput(hook), false);
  const delivery = structuredClone(fixtures.delivery[0]);
  delivery.packet.endpoint_id = null;
  delivery.row.endpoint_id = null;
  assert.equal(validateDeliveryPacket(delivery.packet, delivery.row), true);
  delete delivery.row.endpoint_id;
  assert.equal(validateDeliveryPacket(delivery.packet, delivery.row), false);
});

test('optional constructor form field is absent unless the payload owns it', () => {
  const fixture = fixtures.actions.find(row => row.name === 'form_submit');
  const question = structuredClone(fixture.question), action = structuredClone(fixture.action);
  question.blocks[0].data.fields.push({ key: 'constructor', label: 'Constructor', type: 'text' });
  assert.equal(validateAnswer(action, question), true);
  action.payload.values.constructor = 'provided';
  assert.equal(validateAnswer(action, question), true);
  action.payload.values.constructor = 123;
  assert.equal(validateAnswer(action, question), false);
});

test('message metadata accepts depth six and rejects depth seven and deeply nested arrays', () => {
  const envelope = structuredClone(fixtures.valid[0].envelope);
  envelope.metadata = nestedObject(6);
  const accepted = parseC4Content(encode(envelope));
  assert.equal(accepted.kind, 'envelope');
  assert.doesNotThrow(() => JSON.stringify(accepted.envelope));
  assert.doesNotThrow(() => structuredClone(accepted.envelope));
  envelope.metadata = nestedObject(7);
  assert.deepEqual(parseC4Content(encode(envelope)), { kind: 'invalid', reason: 'invalid_envelope' });
  const prefix = CONTENT_PREFIX + '{"version":1,"kind":"message","messageId":"deep_metadata","fallbackText":"text","blocks":[],"metadata":{"nested":';
  const deep = prefix + '['.repeat(32000) + '0' + ']'.repeat(32000) + '}}';
  assert.ok(Buffer.byteLength(deep) < MAX_CONTENT_BYTES);
  assert.deepEqual(parseC4Content(deep), { kind: 'invalid', reason: 'invalid_envelope' });
});
