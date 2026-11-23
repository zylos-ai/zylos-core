import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONTENT_PREFIX, parseC4Content } from '../c4-content-schema.js';

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
}
