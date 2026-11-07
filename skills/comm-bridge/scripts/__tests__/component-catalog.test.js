import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { COMPONENT_CATALOG, CORE_COMPONENT_KEYS, createCatalogArtifacts } from '../c4-component-catalog.js';
import { BLOCK_SCHEMA, ACTION_SCHEMA, CATALOG_SOURCE, COMPONENT_DEFINITIONS,
  REGISTERED_COMPONENT_KEYS, MODEL_INSTRUCTIONS,
  CONTENT_PREFIX, parseC4Content, validateAnswer } from '../c4-content-schema.js';
import { createComponentFixtures, updateSchemaSource } from '../../../../scripts/generate-component-catalog.js';

const snapshot = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-component-schema-v1.json', import.meta.url), 'utf8'));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const encode = value => CONTENT_PREFIX + JSON.stringify(value);
const fixtures = createComponentFixtures();

// Pure catalog and parser boundary. Run for definition, generated-region or
// registry changes; unrelated UI changes may skip. No DB, process or network.
test('generated version-one schemas match the fixed protocol definitions', () => {
  assert.equal(digest(BLOCK_SCHEMA), digest(snapshot.BLOCK_SCHEMA));
  assert.equal(digest(ACTION_SCHEMA), digest(snapshot.ACTION_SCHEMA));
  assert.deepEqual(CATALOG_SOURCE, snapshot.source);
});

test('the delivered schema contains the current catalog output without runtime imports', () => {
  const source = fs.readFileSync(new URL('../c4-content-schema.js', import.meta.url), 'utf8');
  assert.equal(updateSchemaSource(source), source, 'Regenerate the schema after editing the component catalog');
  assert.doesNotMatch(source, /^\s*import\s/m);
  const generated = createCatalogArtifacts();
  assert.deepEqual(COMPONENT_DEFINITIONS, generated.COMPONENT_DEFINITIONS);
  assert.deepEqual(REGISTERED_COMPONENT_KEYS, generated.REGISTERED_COMPONENT_KEYS);
  assert.equal(MODEL_INSTRUCTIONS, generated.MODEL_INSTRUCTIONS);
  assert.doesNotMatch(source, /export const COMPONENT_FIXTURES/);
});

test('the static component list is the catalog intersection with shipped implementation keys', () => {
  const catalogKeys = COMPONENT_CATALOG.map(component => `${component.type}@${component.schemaVersion}`);
  assert.deepEqual(COMPONENT_CATALOG.map(component => component.type), BLOCK_SCHEMA.properties.type.enum);
  assert.deepEqual(REGISTERED_COMPONENT_KEYS, catalogKeys.filter(key => CORE_COMPONENT_KEYS.includes(key)));
  for (const type of snapshot.BLOCK_SCHEMA.properties.type.enum) assert.ok(REGISTERED_COMPONENT_KEYS.includes(`${type}@1`));
  assert.deepEqual(createCatalogArtifacts({ implementedKeys: ['markdown@1', 'missing@1', 'form_intent@2'] }).REGISTERED_COMPONENT_KEYS, ['markdown@1']);
  assert.equal(createCatalogArtifacts({ implementedKeys: [] }).MODEL_INSTRUCTIONS.includes('markdown@1:'), false);
  assert.equal(new Set(catalogKeys).size, catalogKeys.length);
  for (const definition of COMPONENT_DEFINITIONS) {
    assert.equal(definition.key, `${definition.type}@${definition.schemaVersion}`);
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 0);
    const conditional = BLOCK_SCHEMA.allOf.find(rule => rule.if?.properties?.type?.const === definition.type);
    const dataReference = conditional.then.properties.data.$ref.split('/').at(-1);
    assert.deepEqual(definition.parameters, BLOCK_SCHEMA.$defs[dataReference]);
    assert.ok(MODEL_INSTRUCTIONS.includes(`${definition.key}: ${definition.description}`));
    assert.ok(MODEL_INSTRUCTIONS.includes(JSON.stringify(definition.parameters)));
  }
});

for (const fixture of fixtures.valid) test(`catalog example is a legal message for ${fixture.key}`, () => {
  assert.equal(parseC4Content(encode(fixture.envelope)).kind, 'envelope');
  assert.equal(fixture.envelope.blocks[0].type + '@' + fixture.envelope.blocks[0].schemaVersion, fixture.key);
});
for (const fixture of fixtures.invalid) test(`catalog data rejects an unknown parameter for ${fixture.key}`, () => {
  assert.equal(parseC4Content(encode(fixture.envelope)).kind, 'invalid');
});

for (const fixture of snapshot.compatibility.valid) test(`fixed message behavior accepts ${fixture.name}`, () => {
  const result = parseC4Content(fixture.content);
  assert.equal(result.kind, 'envelope');
  assert.deepEqual(result.envelope, fixture.envelope);
});
for (const fixture of snapshot.compatibility.invalid) test(`fixed message behavior rejects ${fixture.name}`, () => {
  const result = parseC4Content(fixture.content);
  assert.equal(result.kind, 'invalid');
  assert.equal(result.reason, fixture.reason);
});
for (const fixture of snapshot.compatibility.actions) test(`fixed action behavior preserves ${fixture.name}`, () => {
  assert.equal(validateAnswer(fixture.action, fixture.question), fixture.valid);
});
