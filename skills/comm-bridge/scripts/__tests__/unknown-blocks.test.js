import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONTENT_PREFIX, BLOCK_SCHEMA, REGISTERED_COMPONENT_KEYS,
  parseC4Content, findC4ContentError } from '../c4-content-schema.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const encode = envelope => CONTENT_PREFIX + JSON.stringify(envelope);
const unknown = (id = 'future') => ({ id, type: 'future_widget', schemaVersion: 1, fallbackText: 'Future block only', data: { private: 'HIDDEN_DATA' } });
const markdown = { id: 'intro', type: 'markdown', schemaVersion: 1, data: { text: 'Known text' } };
const message = (blocks = [markdown, unknown()]) => ({ version: 1, kind: 'message', messageId: 'ordinary-message', fallbackText: 'Whole message summary', blocks: structuredClone(blocks) });
const invalid = envelope => ({ kind: 'invalid', reason: 'invalid_envelope', fallbackText: envelope.fallbackText });

test('the same unknown content is readable in history and rejected by strict submission diagnostics', () => {
  const content = encode(message());
  assert.equal(parseC4Content(content).kind, 'envelope');
  assert.deepEqual(parseC4Content(content, { submission: true }), invalid(message()));
  assert.equal(findC4ContentError(content)?.path, '/blocks/1/type');
  assert.equal(findC4ContentError(content)?.code, 'enum');
  assert.equal(BLOCK_SCHEMA.properties.type.enum.includes('future_widget'), false);
  assert.equal(REGISTERED_COMPONENT_KEYS.some(key => key.startsWith('future_widget@')), false);
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
