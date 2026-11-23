import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONTENT_PREFIX } from '../c4-content-schema.js';
import { projectC4Content } from '../c4-content-projection.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const invalid = '[C4 content invalid; c4_id=123]';

for (const fixture of fixtures.ordinary) test(`projection preserves ordinary ${fixture.name}`, () => {
  assert.equal(projectC4Content(fixture.content, { c4Id: 123 }), fixture.content);
});
for (const fixture of fixtures.valid) test(`projection exposes only fallback and references for ${fixture.name}`, () => {
  const { fallbackText, messageId, interruptId } = fixture.envelope;
  const reference = `[C4 messageId=${messageId}${interruptId === undefined ? '' : ` interruptId=${interruptId}`}; c4_id=123]`;
  assert.equal(projectC4Content(fixture.content, { c4Id: 123 }), `${fallbackText}\n${reference}`);
});
for (const fixture of fixtures.invalid) test(`projection preserves only qualified fallback for invalid ${fixture.name}`, () => {
  const fallback = fixture.reason === 'invalid_envelope' && fixture.name !== 'missing_fallback'
    ? JSON.parse(fixture.content.slice(CONTENT_PREFIX.length)).fallbackText + '\n' : '';
  assert.equal(projectC4Content(fixture.content, { c4Id: 123 }), fallback + invalid);
});

test('all channels and both directions use the same protocol without modifying the row', () => {
  for (const channel of ['dashboard', 'telegram', 'other_component']) {
    for (const [direction, name] of [['out', 'single'], ['in', 'answer_single_select']]) {
      const content = fixtures.valid.find(row => row.name === name).content;
      const row = Object.freeze({ id: 123, channel, direction, content });
      const before = JSON.stringify(row);
      assert.equal(projectC4Content(row.content, { c4Id: row.id }), projectC4Content(content, { c4Id: 123 }));
      assert.equal(JSON.stringify(row), before);
    }
  }
});
