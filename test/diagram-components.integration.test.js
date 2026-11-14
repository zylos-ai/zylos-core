import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTENT_PREFIX, COMPONENT_DEFINITIONS, CATALOG_SOURCE } from '../skills/comm-bridge/scripts/c4-content-schema.js';

// Boundary: real Dashboard component CLI and Core catalog/validator. Run after
// diagram schema/catalog or component CLI changes; unrelated UI work may skip.
// Official runner supplies private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; no DB,
// socket, backend or model is opened. Children are bounded and synchronous.
function componentCli(args, input) {
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) assert.ok(process.env[key]);
  assert.equal(os.homedir(), process.env.HOME);
  assert.ok(path.resolve(process.env.ZYLOS_DIR).startsWith(path.resolve(process.env.HOME) + path.sep));
  assert.ok(path.resolve(process.env.PM2_HOME).startsWith(path.resolve(process.env.HOME) + path.sep));
  console.info('component CLI isolation', JSON.stringify(Object.fromEntries(
    ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]]))));
  const script = fileURLToPath(new URL('../skills/dashboard/scripts/components.js', import.meta.url));
  const result = spawnSync(process.execPath, [script, ...args], {
    input, encoding: 'utf8', timeout: 5000, maxBuffer: 512 * 1024,
  });
  assert.equal(result.error, undefined);
  return result;
}

test('component CLI lists and describes the implemented diagram and local parameter references', () => {
  const listed = componentCli(['list', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  const catalog = JSON.parse(listed.stdout).data;
  assert.ok(catalog.keys.includes('diagram@1'));
  assert.equal(catalog.components.find(item => item.key === 'diagram@1').schemaVersion, 1);
  const described = componentCli(['describe', 'diagram@1', '--json']);
  assert.equal(described.status, 0, described.stderr);
  const definition = JSON.parse(described.stdout).data;
  assert.equal(definition.source.chatweaveCommit, CATALOG_SOURCE.chatweaveCommit);
  assert.equal(definition.parameters.properties.steps.items.$ref, '#/$defs/block__diagramStep');
  assert.equal(definition.parameters.$defs.block__diagramNode.properties.icon.pattern, '^[a-z][a-z0-9-]{0,31}$');
  assert.equal(definition.parameters.$defs.block__diagramGroup.required.join(','), 'label,from,to');
  assert.match(definition.description, /Unknown valid icon names are accepted with the icon omitted/);
  const unavailable = componentCli(['describe', 'diagram@2', '--json']);
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stderr, /not implemented/);
});

test('component CLI validates diagram defaults and rejects semantic errors with exact diagnostics', () => {
  const envelope = structuredClone(COMPONENT_DEFINITIONS.find(item => item.key === 'diagram@1').example);
  envelope.blocks[0].data.steps[0].nodes[0].icon = 'future-icon';
  const encode = () => CONTENT_PREFIX + JSON.stringify(envelope);
  const accepted = componentCli(['validate', '-', '--json'], encode());
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout), { ok: true, data: { valid: true } });
  envelope.blocks[0].data.groups = [{ label: 'Bad endpoint', from: 'client', to: 'missing' }];
  const rejected = componentCli(['validate', '-', '--json'], encode());
  assert.equal(rejected.status, 1);
  const failure = JSON.parse(rejected.stdout);
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, 'invalid_diagram_group_endpoint');
  assert.equal(failure.error.path, '/blocks/0/data/groups/0/to');
  assert.equal(rejected.stderr, '');
});
