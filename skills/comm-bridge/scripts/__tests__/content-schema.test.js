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
