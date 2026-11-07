import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createCatalogArtifacts } from '../../comm-bridge/scripts/c4-component-catalog.js';
import { runComponents } from '../scripts/components.js';
import { CONTENT_PREFIX, COMPONENT_DEFINITIONS, REGISTERED_COMPONENT_KEYS, MODEL_INSTRUCTIONS,
  parseC4Content } from '../../comm-bridge/scripts/c4-content-schema.js';

// Static CLI boundary only: no DB, HTTP, PM2 or tmux. Run on generated catalog
// or CLI output changes; unrelated chat delivery/runtime work may skip.
function call(args, catalog) {
  let output = '', error = '';
  const exit = runComponents(args, { catalog, stdout: { write: value => { output += value; } },
    stderr: { write: value => { error += value; } } });
  return { exit, output, error };
}

test('component CLI lists the implemented keys and generated descriptions', () => {
  const result = call(['list', '--json']);
  assert.equal(result.exit, 0);
  const data = JSON.parse(result.output).data;
  assert.deepEqual(data.keys, REGISTERED_COMPONENT_KEYS);
  assert.deepEqual(data.components.map(item => item.key), REGISTERED_COMPONENT_KEYS);
  assert.equal(data.components.length, 7);
});

for (const item of COMPONENT_DEFINITIONS) test(`component CLI describes and emits a legal ${item.key} message`, () => {
  const description = call(['describe', item.key, '--json']);
  assert.equal(description.exit, 0);
  const data = JSON.parse(description.output).data;
  const { $defs, ...parameters } = data.parameters;
  const restore = value => Array.isArray(value) ? value.map(restore)
    : !value || typeof value !== 'object' ? value
      : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === '$ref'
        ? entry.replace('#/$defs/block__', '#/$defs/').replace('#/$defs/action__', 'action.schema.json#/$defs/') : restore(entry)]));
  assert.deepEqual(restore(parameters), item.parameters);
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === '$ref') {
        assert.match(entry, /^#\/\$defs\/[^/]+$/);
        assert.ok($defs[entry.slice('#/$defs/'.length)], entry);
      } else visit(entry);
    }
  };
  visit(data.parameters);
  assert.equal(data.description, item.description);
  assert.ok(data.instructions.startsWith(MODEL_INSTRUCTIONS));
  const example = call(['example', item.key]);
  assert.equal(example.exit, 0);
  assert.equal(parseC4Content(example.output.trimEnd()).kind, 'envelope');
  assert.deepEqual(JSON.parse(example.output.slice(CONTENT_PREFIX.length)), item.example);
});

test('component CLI consumes the generated intersection when a catalog component is unimplemented', () => {
  const catalog = { ...createCatalogArtifacts({ implementedKeys: ['markdown@1'] }), CONTENT_PREFIX };
  const listed = call(['list', '--json'], catalog);
  assert.equal(listed.exit, 0);
  assert.deepEqual(JSON.parse(listed.output).data.components.map(item => item.key), ['markdown@1']);
  for (const command of ['describe', 'example']) {
    const result = call([command, 'choice@1'], catalog);
    assert.equal(result.exit, 1);
    assert.equal(result.output, '');
  }
  assert.equal(call(['describe', 'markdown@1'], catalog).exit, 0);
});

test('component CLI describes the transitive form field and action definitions', () => {
  const result = call(['describe', 'form_intent@1', '--json']);
  assert.equal(result.exit, 0);
  const schema = JSON.parse(result.output).data.parameters;
  assert.equal(schema.properties.fields.items.$ref, '#/$defs/block__formField');
  assert.ok(schema.$defs.block__formField.properties.type.enum.includes('multi_select'));
  assert.equal(schema.$defs.block__formField.properties.options.items.$ref, '#/$defs/block__option');
  assert.equal(schema.$defs.block__option.properties.label.$ref, '#/$defs/block__label');
  assert.equal(schema.properties.action.allOf[0].$ref, '#/$defs/action__actionSpec');
  assert.equal(schema.$defs.action__actionSpec.properties.type.$ref, '#/$defs/action__actionType');
  assert.ok(schema.$defs.action__actionType.enum.includes('form.submit'));
  assert.equal(schema.$defs.block__blockState.properties.selected.items.$ref, '#/$defs/action__optionId');
  assert.equal(schema.$defs.block__markdownData, undefined);
});

test('component CLI refuses unimplemented components and malformed arguments', () => {
  for (const args of [['list', 'extra'], ['describe'], ['example', 'x-zylos.image@1'],
    ['describe', 'form_intent@2'], ['list', '--json', '--json'], ['unknown']]) {
    const result = call(args);
    assert.equal(result.exit, 1);
    assert.equal(result.output, '');
    assert.ok(result.error.length > 0);
  }
});

test('installed component CLI entry prints real list and message output', () => {
  const script = new URL('../scripts/components.js', import.meta.url);
  const run = args => execFileSync(process.execPath, [script.pathname, ...args], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 512 * 1024 });
  assert.deepEqual(JSON.parse(run(['list', '--json'])).data.keys, REGISTERED_COMPONENT_KEYS);
  assert.equal(parseC4Content(run(['example', 'choice@1']).trimEnd()).kind, 'envelope');
});
