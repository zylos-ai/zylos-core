import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createCatalogArtifacts } from '../../comm-bridge/scripts/c4-component-catalog.js';
import { runComponents } from '../scripts/components.js';
import { evaluateBeforeSend } from '../scripts/send-hook.js';
import { CONTENT_PREFIX, COMPONENT_DEFINITIONS, REGISTERED_COMPONENT_KEYS, MODEL_INSTRUCTIONS,
  parseC4Content } from '../../comm-bridge/scripts/c4-content-schema.js';

// Static CLI boundary only: no DB, HTTP, PM2 or tmux. Run on generated catalog
// or CLI output changes; unrelated chat delivery/runtime work may skip.
function call(args, catalog, input) {
  let output = '', error = '';
  const exit = runComponents(args, { catalog, stdout: { write: value => { output += value; } },
    stderr: { write: value => { error += value; } },
    ...(input === undefined ? {} : { readInput: () => input }) });
  return { exit, output, error };
}

test('component CLI lists the implemented keys, descriptions and selection guidance', () => {
  const result = call(['list', '--json']);
  assert.equal(result.exit, 0);
  const data = JSON.parse(result.output).data;
  assert.deepEqual(data.keys, REGISTERED_COMPONENT_KEYS);
  assert.deepEqual(data.components.map(item => item.key), REGISTERED_COMPONENT_KEYS);
  assert.equal(data.components.length, 9);
  assert.equal(new Set(data.components.map(item => item.key)).size, 9);
  for (const item of data.components) {
    const definition = COMPONENT_DEFINITIONS.find(component => component.key === item.key);
    assert.equal(typeof item.useWhen, 'string');
    assert.ok(item.useWhen.length > 0);
    assert.equal(item.useWhen, definition.useWhen);
  }
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
  assert.equal(data.useWhen, item.useWhen);
  assert.ok(data.instructions.includes(`When to use: ${item.useWhen}`));
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
    ['describe', 'form_intent@3'], ['list', '--json', '--json'], ['unknown'], ['validate', 'a.txt', 'b.txt']]) {
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
  const listed = JSON.parse(run(['list', '--json'])).data;
  assert.deepEqual(listed.keys, REGISTERED_COMPONENT_KEYS);
  for (const item of listed.components) assert.equal(item.useWhen, COMPONENT_DEFINITIONS.find(component => component.key === item.key).useWhen);
  assert.equal(parseC4Content(run(['example', 'choice@1']).trimEnd()).kind, 'envelope');
  const described = JSON.parse(run(['describe', 'time_series@1', '--json'])).data;
  assert.equal(described.useWhen, COMPONENT_DEFINITIONS.find(item => item.key === 'time_series@1').useWhen);
  assert.match(described.instructions, /When to use: Use for time trends/);
});

const choiceMessage = () => CONTENT_PREFIX + JSON.stringify(COMPONENT_DEFINITIONS.find(item => item.key === 'choice@1').example) + '\n';
const wrongActionType = () => choiceMessage().replace('"choice.select"', '"choice.private_value"');

test('component CLI validates content and reports the first error path', () => {
  const valid = call(['validate'], undefined, choiceMessage());
  assert.deepEqual(valid, { exit: 0, output: 'Valid C4 content.\n', error: '' });
  assert.deepEqual(JSON.parse(call(['validate', '--json'], undefined, choiceMessage()).output), { ok: true, data: { valid: true } });

  const invalid = call(['validate', '-'], undefined, wrongActionType());
  assert.equal(invalid.exit, 1);
  assert.equal(invalid.output, '');
  assert.equal(invalid.error,
    '/blocks/0/data/action/type [enum] must be one of "choice.select", "confirmation.respond", "form.submit".\n');
  const invalidJson = call(['validate', '--json'], undefined, wrongActionType());
  assert.equal(invalidJson.exit, 1);
  const { ok, error } = JSON.parse(invalidJson.output);
  assert.equal(ok, false);
  assert.deepEqual({ code: error.code, path: error.path }, { code: 'enum', path: '/blocks/0/data/action/type' });
  assert.equal(invalidJson.output.includes('private_value'), false);

  const text = call(['validate'], undefined, 'Plain reply without the marker\n');
  assert.equal(text.exit, 1);
  assert.equal(text.output, '');
  assert.match(text.error, /^\(root\) \[marker\] content must start with the \[C4-JSON\] marker/);
  assert.equal(JSON.parse(call(['validate', '--json'], undefined, 'Plain reply').output).error.code, 'marker');
});

test('component CLI validation applies the View rules of the send-time check', () => {
  const envelope = structuredClone(COMPONENT_DEFINITIONS.find(item => item.key === 'choice@1').example);
  envelope.metadata = { view: { schemaVersion: 1, root: 'root', nodes: [{ id: 'root', type: 'block', blockId: 'question' }] } };
  assert.equal(call(['validate'], undefined, CONTENT_PREFIX + JSON.stringify(envelope)).exit, 0);
  envelope.metadata.view.nodes[0].blockId = 'missing';
  const result = call(['validate', '--json'], undefined, CONTENT_PREFIX + JSON.stringify(envelope));
  assert.equal(result.exit, 1);
  assert.deepEqual(JSON.parse(result.output).error, { code: 'unknown_view_block', path: '/metadata/view', message: 'view metadata is not a valid View' });
});

// Installed entry: spawns node on the real script with stdin or a file in a
// per-test temporary directory; no DB, HTTP, PM2 or tmux. Run when the CLI
// entry or input handling changes.
test('installed component CLI validates stdin and files with matching exit codes', t => {
  const script = new URL('../scripts/components.js', import.meta.url).pathname;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'component-validate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (args, input) => spawnSync(process.execPath, [script, 'validate', ...args], {
    input, encoding: 'utf8', timeout: 5000, maxBuffer: 512 * 1024 });
  const example = execFileSync(process.execPath, [script, 'example', 'choice@1'], { encoding: 'utf8', timeout: 5000 });
  const fromStdin = run([], example);
  assert.deepEqual([fromStdin.status, fromStdin.stdout, fromStdin.stderr], [0, 'Valid C4 content.\n', '']);

  const file = path.join(dir, 'message.txt');
  fs.writeFileSync(file, wrongActionType());
  const fromFile = run([file]);
  assert.equal(fromFile.status, 1);
  assert.match(fromFile.stderr, /^\/blocks\/0\/data\/action\/type \[enum\] /);
  assert.equal(fromFile.stdout, '');

  const text = run(['--json'], 'Plain reply');
  assert.equal(text.status, 1);
  assert.equal(JSON.parse(text.stdout).error.code, 'marker');

  const missing = run([path.join(dir, 'absent.txt')]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr, 'Cannot read the content to validate.\n');
});

test('component CLI validation accepts exactly what the Dashboard send check accepts', () => {
  const fixtures = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
  const wire = content => {
    const input = structuredClone(fixtures.hookInputs.find(row => row.name === 'valid_input').value);
    input.request.content = content;
    return input;
  };
  const choice = () => structuredClone(COMPONENT_DEFINITIONS.find(item => item.key === 'choice@1').example);
  const repeatedOption = choice();
  repeatedOption.blocks[0].data.options[1].id = repeatedOption.blocks[0].data.options[0].id;
  const pendingInView = choice();
  pendingInView.blocks.push({ id: 'later', type: 'markdown', schemaVersion: 1, status: 'pending', fallbackText: 'Loading' });
  pendingInView.metadata = { view: { schemaVersion: 1, root: 'root', nodes: [{ id: 'root', type: 'block', blockId: 'later' }] } };
  const texts = [...fixtures.valid.map(item => item.content), ...fixtures.invalid.map(item => item.content),
    ...COMPONENT_DEFINITIONS.map(item => CONTENT_PREFIX + JSON.stringify(item.example)),
    CONTENT_PREFIX + JSON.stringify(repeatedOption), CONTENT_PREFIX + JSON.stringify(pendingInView)];
  let rejected = 0;
  for (const text of texts.filter(item => item.startsWith(CONTENT_PREFIX))) {
    const sent = evaluateBeforeSend(wire(text));
    const checked = call(['validate'], undefined, text);
    assert.equal(checked.exit === 0, sent.decision === 'continue', text.slice(0, 120));
    if (sent.decision === 'continue') continue;
    rejected++;
    assert.ok(sent.message === 'Invalid Dashboard structured content: ' + checked.error.trimEnd()
      || sent.message === 'Invalid Dashboard view: ' + JSON.parse(call(['validate', '--json'], undefined, text).output).error.code, sent.message);
  }
  assert.equal(rejected, fixtures.invalid.filter(item => item.content.startsWith(CONTENT_PREFIX)).length + 2);
});
