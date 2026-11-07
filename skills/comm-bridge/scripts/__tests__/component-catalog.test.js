import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { COMPONENT_CATALOG, CORE_COMPONENT_KEYS, createCatalogArtifacts } from '../c4-component-catalog.js';
import * as delivered from '../c4-content-schema.js';
import { versionOneSubset } from './helpers/component-schema-subset.js';
import { createComponentFixtures, updateSchemaSource } from '../../../../scripts/generate-component-catalog.js';

const { BLOCK_SCHEMA, ACTION_SCHEMA, CATALOG_SOURCE, COMPONENT_DEFINITIONS,
  REGISTERED_COMPONENT_KEYS, MODEL_INSTRUCTIONS, CONTENT_PREFIX, parseC4Content } = delivered;

const snapshot = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-component-schema-v1.json', import.meta.url), 'utf8'));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const encode = value => CONTENT_PREFIX + JSON.stringify(value);
const fixtures = createComponentFixtures();

// Pure catalog and parser boundary. Run for definition, generated-region or
// registry changes; unrelated UI changes may skip. No DB, process or network.
test('generated version-one members match the fixed protocol definitions', () => {
  const subset = versionOneSubset(BLOCK_SCHEMA, ACTION_SCHEMA, snapshot);
  assert.equal(digest(subset.BLOCK_SCHEMA), digest(snapshot.BLOCK_SCHEMA));
  assert.equal(digest(subset.ACTION_SCHEMA), digest(snapshot.ACTION_SCHEMA));
  assert.deepEqual(CATALOG_SOURCE, snapshot.source);
});

test('version-one comparison permits additional component and action members', () => {
  const block = structuredClone(BLOCK_SCHEMA), action = structuredClone(ACTION_SCHEMA);
  block.properties.type.enum.push('future_component');
  block.properties.schemaVersion = { enum: [1, 2] };
  const form = block.allOf.find(rule => rule.if?.properties?.type?.const === 'form_intent');
  form.if.properties.schemaVersion = { const: 1 };
  form.if.required = ['schemaVersion'];
  block.$defs.futureData = { type: 'object' };
  block.allOf.push({ if: { properties: { type: { const: 'future_component' } } },
    then: { properties: { data: { $ref: '#/$defs/futureData' } } } });
  block.allOf.push({ if: { properties: { type: { const: 'form_intent' }, schemaVersion: { const: 2 } } },
    then: { properties: { data: { $ref: '#/$defs/futureData' } } } });
  action.$defs.actionType.enum.push('future.action');
  action.$defs.futurePayload = { type: 'object' };
  action.$defs.actionRequest.allOf.push({ if: { properties: { type: { const: 'future.action' } } },
    then: { properties: { payload: { $ref: '#/$defs/futurePayload' } } } });
  const subset = versionOneSubset(block, action, snapshot);
  assert.equal(digest(subset.BLOCK_SCHEMA), digest(snapshot.BLOCK_SCHEMA));
  assert.equal(digest(subset.ACTION_SCHEMA), digest(snapshot.ACTION_SCHEMA));
  block.$defs.label.maxLength += 1;
  assert.notEqual(digest(versionOneSubset(block, action, snapshot).BLOCK_SCHEMA), digest(snapshot.BLOCK_SCHEMA));
});

test('the delivered schema contains every current catalog artifact without runtime imports', () => {
  const source = fs.readFileSync(new URL('../c4-content-schema.js', import.meta.url), 'utf8');
  const generated = createCatalogArtifacts();
  for (const [name, value] of Object.entries(generated)) {
    assert.equal(digest(delivered[name]), digest(value), `Regenerate the schema after editing ${name}`);
  }
  assert.equal(updateSchemaSource(source), source, 'Regenerate the schema after editing the component catalog');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /export const COMPONENT_FIXTURES/);
});

test('the static component list is the catalog intersection with shipped implementation keys', () => {
  const catalogKeys = COMPONENT_CATALOG.map(component => `${component.type}@${component.schemaVersion}`);
  for (const component of COMPONENT_CATALOG) assert.ok(BLOCK_SCHEMA.properties.type.enum.includes(component.type));
  assert.deepEqual(REGISTERED_COMPONENT_KEYS, catalogKeys.filter(key => CORE_COMPONENT_KEYS.includes(key)));
  const restricted = createCatalogArtifacts({ implementedKeys: ['markdown@1', 'missing@1', 'form_intent@99'] });
  assert.deepEqual(restricted.REGISTERED_COMPONENT_KEYS, ['markdown@1']);
  assert.deepEqual(restricted.COMPONENT_DEFINITIONS.map(item => item.key), ['markdown@1']);
  assert.ok(restricted.INTERACTIVE_COMPONENT_TYPES.includes('choice'));
  assert.equal(restricted.MODEL_INSTRUCTIONS.includes('choice@1:'), false);
  assert.equal(createCatalogArtifacts({ implementedKeys: [] }).MODEL_INSTRUCTIONS.includes('markdown@1:'), false);
  assert.equal(new Set(catalogKeys).size, catalogKeys.length);
  for (const definition of COMPONENT_DEFINITIONS) {
    assert.equal(definition.key, `${definition.type}@${definition.schemaVersion}`);
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 0);
    const conditional = BLOCK_SCHEMA.allOf.find(rule => rule.if?.properties?.type?.const === definition.type
      && (rule.if.properties.schemaVersion?.const ?? 1) === definition.schemaVersion);
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

test('host definitions extend the catalog without claiming a conditional renderer', () => {
  const conditional = COMPONENT_CATALOG.find(component => component.type === 'form_intent' && component.schemaVersion === 2);
  assert.ok(conditional);
  assert.equal(parseC4Content(encode(conditional.example)).kind, 'envelope');
  assert.equal(REGISTERED_COMPONENT_KEYS.includes('form_intent@2'), false);
  assert.equal(COMPONENT_DEFINITIONS.some(component => component.schemaVersion === 2), false);
  assert.equal(MODEL_INSTRUCTIONS.includes('form_intent@2:'), false);
  assert.equal(delivered.VIEW_SCHEMA.properties.schemaVersion.const, 1);
  assert.equal(delivered.VIEW_SCHEMA.properties.nodes.maxItems, 128);
  assert.equal(digest(delivered.BLOCK_SCHEMA.$defs.activeWhen), digest(delivered.FORM_CONDITION_SCHEMA));
  const hypothetical = createCatalogArtifacts({ implementedKeys: ['form_intent@2'] });
  assert.deepEqual(hypothetical.REGISTERED_COMPONENT_KEYS, ['form_intent@2']);
  assert.deepEqual(hypothetical.COMPONENT_DEFINITIONS[0].parameters, delivered.BLOCK_SCHEMA.$defs.formIntentDataV2);
});
