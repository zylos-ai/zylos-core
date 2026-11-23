import test from 'node:test';
import assert from 'node:assert/strict';
import * as delivered from '../c4-content-schema.js';
import { createComponentFixtures } from '../../../../scripts/generate-component-catalog.js';

const { BLOCK_SCHEMA, ACTION_SCHEMA, CATALOG_SOURCE, COMPONENT_DEFINITIONS,
  REGISTERED_COMPONENT_KEYS, MODEL_INSTRUCTIONS, CONTENT_PREFIX, parseC4Content } = delivered;

const encode = value => CONTENT_PREFIX + JSON.stringify(value);
const fixtures = createComponentFixtures();

for (const fixture of fixtures.valid) test(`catalog example is a legal message for ${fixture.key}`, () => {
  assert.equal(parseC4Content(encode(fixture.envelope)).kind, 'envelope');
  assert.equal(fixture.envelope.blocks[0].type + '@' + fixture.envelope.blocks[0].schemaVersion, fixture.key);
});
