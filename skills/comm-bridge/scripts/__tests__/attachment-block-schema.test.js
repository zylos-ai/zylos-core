import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONTENT_PREFIX, parseC4Content, readC4Envelope, validateAnswer, validateAttachmentData } from '../c4-content-schema.js';
import { parseC4Content as parseLegacy } from '../../../../test/fixtures/c4-content-schema-legacy.js';
import { projectC4Content } from '../c4-content-projection.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/attachment-blocks.json', import.meta.url), 'utf8'));
const encode = value => CONTENT_PREFIX + JSON.stringify(value);
const message = block => ({ version: 1, kind: 'message', messageId: 'attachment_message',
  fallbackText: 'Registered attachment', blocks: [structuredClone(block)] });

// Shared schema and historical shipped-reader boundary. Run on attachment
// definition/parser changes; unrelated transport/UI may skip. Pure modules and
// static fixtures only: no database, HTTP, runtime, process or file mutation.
for (const block of fixtures.blocks) {
  test(`${block.type} validates its closed attachment data`, () => {
    assert.equal(parseC4Content(encode(message(block))).kind, 'envelope');
    for (const example of fixtures.invalidData) {
      const invalid = structuredClone(block); invalid.data = example.data;
      assert.equal(parseC4Content(encode(message(invalid))).kind, 'invalid', example.name);
    }
    const version = structuredClone(block); version.schemaVersion = 2;
    assert.equal(parseC4Content(encode(message(version))).kind, 'invalid');
    const noFallback = structuredClone(block); delete noFallback.fallbackText;
    assert.equal(parseC4Content(encode(message(noFallback))).kind, 'invalid');
    const boundary = structuredClone(block);
    boundary.data = { attachmentId: '_' + 'a'.repeat(127), nameSnapshot: '文'.repeat(160) };
    assert.equal(parseC4Content(encode(message(boundary))).kind, 'envelope');
    for (const data of [
      { ...boundary.data, attachmentId: 'a'.repeat(129) },
      { ...boundary.data, attachmentId: 'https://example.invalid/file' },
      { ...boundary.data, nameSnapshot: '文'.repeat(161) },
    ]) assert.equal(parseC4Content(encode(message({ ...block, data }))).kind, 'invalid');
  });
  test(`${block.type} requires registered data and permits only complete blocks`, () => {
    assert.equal(parseC4Content(encode(message({ ...block, status: 'complete' }))).kind, 'envelope');
    for (const example of fixtures.invalidBlockStates) {
      const invalid = { ...structuredClone(block), ...example.fields };
      if (example.omitData) delete invalid.data;
      const content = encode(message(invalid));
      assert.equal(parseC4Content(content).kind, 'invalid', example.name);
      assert.equal(projectC4Content(content, { c4Id: 23 }), 'Registered attachment\n[C4 content invalid; c4_id=23]', example.name);
      for (const fallbackText of [undefined, '', 42, 'x'.repeat(16001)]) {
        assert.equal(projectC4Content(encode({ ...message(invalid), fallbackText }), { c4Id: 23 }), '[C4 content invalid; c4_id=23]', example.name);
      }
    }
  });
}

test('attachment diagnostics share the exact closed data schema without accepting a message', () => {
  for (const block of fixtures.blocks) assert.equal(validateAttachmentData(block.data), true);
  assert.equal(validateAttachmentData({ attachmentId: '_' + 'a'.repeat(127), nameSnapshot: '文'.repeat(160) }), true);
  for (const example of fixtures.invalidData) assert.equal(validateAttachmentData(example.data), false, example.name);
  for (const data of [null, [], 'att_file', { attachmentId: 'a'.repeat(129), nameSnapshot: 'report.pdf' },
    { attachmentId: 'att_file', nameSnapshot: '文'.repeat(161) }]) assert.equal(validateAttachmentData(data), false);
  const pending = { ...fixtures.blocks[0], status: 'pending' };
  assert.equal(validateAttachmentData(pending.data), true);
  assert.equal(parseC4Content(encode(message(pending))).kind, 'invalid');
});

test('raw framing supports a rejection hint without accepting closed-schema-invalid data', () => {
  const source = message(fixtures.blocks[1]);
  source.blocks[0].data.path = '/tmp/private.pdf';
  const suffix = '\n\n[C4] Status notification suppressed by cooldown while health=ok reason=recent.';
  for (const tail of ['', suffix]) {
    const content = encode(source) + tail;
    const raw = readC4Envelope(content);
    assert.equal(raw.kind, 'envelope');
    assert.equal(raw.envelope.blocks[0].data.path, '/tmp/private.pdf');
    assert.equal(raw.suffix, tail);
    assert.equal(parseC4Content(content).kind, 'invalid');
  }
  for (const content of [encode(source) + 'garbage', CONTENT_PREFIX + '{broken']) {
    assert.equal(readC4Envelope(content).kind, 'invalid');
    assert.equal(parseC4Content(content).kind, 'invalid');
  }
});

test('attachments share a complete mixed envelope with charts and a question', () => {
  const content = encode(fixtures.mixed), parsed = parseC4Content(content);
  assert.equal(parsed.kind, 'envelope');
  assert.deepEqual(parsed.envelope.blocks.map(block => block.type),
    ['markdown', 'x-zylos.image', 'time_series', 'choice', 'x-zylos.file']);
  const question = parsed.envelope.blocks.find(block => block.id === parsed.envelope.interrupt.blockId);
  const action = { id: 'mixed_attachment_answer', protocolVersion: '0.1', type: question.data.action.type,
    target: question.data.action.target, context: { messageId: parsed.envelope.messageId, blockId: question.id },
    payload: { selected: ['a'] } };
  assert.equal(validateAnswer(action, parsed.envelope), true);
  assert.equal(projectC4Content(content, { c4Id: 23 }),
    `${fixtures.mixed.fallbackText}\n[C4 messageId=mixed_attachments interruptId=${fixtures.mixed.interruptId}; c4_id=23]`);
  for (const secret of ['ATTACHMENT_STORAGE_METADATA', 'ATTACHMENT_SOURCE_PATH', '"attachmentId"', '"nameSnapshot"']) {
    assert.equal(projectC4Content(content, { c4Id: 23 }).includes(secret), false);
  }
});

test('the historical Core and browser schema reject an entire envelope with unknown attachment blocks', () => {
  const beforeAttachments = structuredClone(fixtures.mixed);
  beforeAttachments.blocks = beforeAttachments.blocks.filter(block => !block.type.startsWith('x-zylos.'));
  assert.equal(parseLegacy(encode(beforeAttachments)).kind, 'envelope');
  // This is the unmodified single-file module shipped by the fixed historical
  // Core and served to its browser; ordinary import, never source evaluation.
  for (const source of [fixtures.mixed, ...fixtures.blocks.map(message)]) {
    const parsed = parseLegacy(encode(source));
    assert.equal(parsed.kind, 'invalid');
    assert.equal(Object.hasOwn(parsed, 'envelope'), false);
  }
});
