import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { runComponents } from '../scripts/components.js';
import { CONTENT_PREFIX, COMPONENT_DEFINITIONS, REGISTERED_COMPONENT_KEYS, MODEL_INSTRUCTIONS,
  parseC4Content } from '../../comm-bridge/scripts/c4-content-schema.js';

// Static CLI boundary only: no DB, HTTP, PM2 or tmux. Run on generated catalog
// or CLI output changes; unrelated chat delivery/runtime work may skip.
function call(args) {
  let output = '', error = '';
  const exit = runComponents(args, { stdout: { write: value => { output += value; } },
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

for (const item of COMPONENT_DEFINITIONS.filter(item => REGISTERED_COMPONENT_KEYS.includes(item.key))) test(`component CLI describes and emits a legal ${item.key} message`, () => {
  const description = call(['describe', item.key, '--json']);
  assert.equal(description.exit, 0);
  const data = JSON.parse(description.output).data;
  assert.deepEqual(data.parameters, item.parameters);
  assert.equal(data.description, item.description);
  assert.equal(data.instructions, MODEL_INSTRUCTIONS);
  const example = call(['example', item.key]);
  assert.equal(example.exit, 0);
  assert.equal(parseC4Content(example.output.trimEnd()).kind, 'envelope');
  assert.deepEqual(JSON.parse(example.output.slice(CONTENT_PREFIX.length)), item.example);
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
