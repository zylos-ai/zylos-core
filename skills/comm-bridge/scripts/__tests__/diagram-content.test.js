import test from 'node:test';
import assert from 'node:assert/strict';
import { projectC4Content, previewMessageText } from '../c4-content-projection.js';
import { updateSchemaSource } from '../../../../scripts/generate-component-catalog.js';
import fs from 'node:fs';
import { CONTENT_PREFIX, BLOCK_SCHEMA, COMPONENT_DEFINITIONS, REGISTERED_COMPONENT_KEYS,
  CATALOG_SOURCE, MODEL_INSTRUCTIONS, parseC4Content, findC4ContentError } from '../c4-content-schema.js';

const example = () => structuredClone(COMPONENT_DEFINITIONS.find(item => item.key === 'diagram@1').example);
const encode = value => CONTENT_PREFIX + JSON.stringify(value);
const steps = count => Array.from({ length: count }, (_, index) => ({ id: `step_${index}`, nodes: [{ label: `Step ${index}` }] }));
function accepts(change = () => {}) {
  const envelope = example();
  change(envelope.blocks[0].data, envelope.blocks[0]);
  const content = encode(envelope);
  assert.equal(findC4ContentError(content), null);
  for (const submission of [false, true]) assert.equal(parseC4Content(content, { submission }).kind, 'envelope');
  return envelope;
}
function rejects(change, code, path) {
  const envelope = example();
  change(envelope.blocks[0].data, envelope.blocks[0]);
  const content = encode(envelope);
  const error = findC4ContentError(content);
  assert.ok(error);
  if (code) assert.equal(error.code, code);
  if (path) assert.equal(error.path, '/blocks/0/' + path);
  for (const submission of [false, true]) assert.equal(parseC4Content(content, { submission }).kind, 'invalid');
}

test('diagram is implemented, advertised and pinned to the accepted upstream source', () => {
  assert.ok(REGISTERED_COMPONENT_KEYS.includes('diagram@1'));
  assert.equal(CATALOG_SOURCE.chatweaveCommit, '5c4288338e2a6a50c236d06e51e346c080ae7141');
  assert.match(MODEL_INSTRUCTIONS, /diagram@1:/);
  const description = COMPONENT_DEFINITIONS.find(item => item.key === 'diagram@1').description;
  const names = 'bot monitor server network code terminal layers component tool settings book chart message key lock clock alert check search target user users smartphone glasses database cloud globe file'.split(' ');
  for (const name of names) assert.ok(description.includes(name));
  assert.equal(names.length, 28);
  assert.match(description, /Unknown valid icon names are accepted with the icon omitted/);
  const source = fs.readFileSync(new URL('../c4-content-schema.js', import.meta.url), 'utf8');
  assert.equal(updateSchemaSource(source), source);
  assert.equal(BLOCK_SCHEMA.$defs.diagramNode.properties.icon.pattern, '^[a-z][a-z0-9-]{0,31}$');
  accepts();
});

test('history projection uses the diagram message fallback and rejects malformed groups without leaking block data', () => {
  const envelope = example();
  envelope.blocks[0].data.steps[0].nodes[0].detail = 'PRIVATE_NODE_DETAIL';
  const expected = `${envelope.fallbackText}\n[C4 messageId=diagram_message; c4_id=420]`;
  assert.equal(projectC4Content(encode(envelope), { c4Id: 420 }), expected);
  assert.equal(previewMessageText(encode(envelope)), envelope.fallbackText);
  envelope.blocks[0].data.steps[1].id = 'client';
  const rejected = projectC4Content(encode(envelope), { c4Id: 420 });
  assert.equal(rejected, `${envelope.fallbackText}\n[C4 content invalid; c4_id=420]`);
  assert.equal(rejected.includes('PRIVATE_NODE_DETAIL'), false);
});

test('diagram defaults, optional IDs and final links remain valid without normalization', () => {
  const envelope = accepts(data => {
    for (const step of data.steps) delete step.id;
    data.steps[1].link = { arrow: 'both', label: 'ignored final link' };
  });
  assert.equal(Object.hasOwn(envelope.blocks[0].data, 'direction'), false);
  assert.equal(Object.hasOwn(envelope.blocks[0].data.steps[0], 'link'), false);
  accepts(data => { data.steps[0].link = {}; });
  for (const arrow of ['forward', 'both', 'none']) accepts(data => { data.steps[0].link = { arrow }; });
});

test('diagram accepts limits, parallel nodes, Unicode and horizontal flows above five steps', () => {
  for (const count of [2, 5, 6, 8]) accepts(data => { data.steps = steps(count); data.direction = 'horizontal'; });
  accepts(data => {
    data.title = 'T'.repeat(120); data.summary = 'S'.repeat(2000);
    data.steps[0].nodes = Array.from({ length: 3 }, () => ({ label: '😀'.repeat(40), detail: 'D'.repeat(120), highlight: true }));
    data.steps[0].link = { label: 'L'.repeat(40) };
  });
});

test('diagram requires bounded steps, nodes, node labels and block fallback', () => {
  rejects(data => { delete data.steps; }, 'required', 'data/steps');
  for (const count of [0, 1, 9]) rejects(data => { data.steps = steps(count); }, count < 2 ? 'minItems' : 'maxItems', 'data/steps');
  rejects(data => { delete data.steps[0].nodes; }, 'required', 'data/steps/0/nodes');
  for (const count of [0, 4]) rejects(data => { data.steps[0].nodes = Array.from({ length: count }, () => ({ label: 'Node' })); });
  rejects(data => { delete data.steps[0].nodes[0].label; }, 'required', 'data/steps/0/nodes/0/label');
  rejects((data, block) => { delete block.fallbackText; }, 'required', 'fallbackText');
});

test('diagram rejects invalid scalar limits, types, directions, arrows and unknown fields', () => {
  for (const label of ['', 'x'.repeat(41)]) rejects(data => { data.steps[0].nodes[0].label = label; });
  rejects(data => { data.steps[0].nodes[0].detail = 'x'.repeat(121); });
  rejects(data => { data.steps[0].nodes[0].highlight = 'yes'; });
  rejects(data => { data.steps[0].link = { label: 'x'.repeat(41) }; });
  rejects(data => { data.steps[0].link = { arrow: 'backward' }; });
  rejects(data => { data.direction = 'diagonal'; });
  for (const target of ['data', 'step', 'node', 'link', 'group']) rejects(data => {
    data.steps[0].link = {};
    data.groups = [{ label: 'Group', from: 'client', to: 'server' }];
    ({ data, step: data.steps[0], node: data.steps[0].nodes[0], link: data.steps[0].link, group: data.groups[0] })[target].unexpected = true;
  }, 'additionalProperties');
  rejects((data, block) => { block.schemaVersion = 2; });
});

test('diagram icon names are grammar checked without a whitelist', () => {
  for (const icon of ['bot', 'future-custom-icon', 'a', 'a' + '9'.repeat(31)]) accepts(data => { data.steps[0].nodes[0].icon = icon; });
  for (const icon of ['', 'Bot', 'a_b', '-bot', 'a'.repeat(33), '<script>', 'a b']) {
    rejects(data => { data.steps[0].nodes[0].icon = icon; }, 'pattern', 'data/steps/0/nodes/0/icon');
  }
});

test('diagram step IDs are optional but valid and unique in history and submissions', () => {
  rejects(data => { data.steps[1].id = 'client'; }, 'duplicate_diagram_step_id', 'data/steps/1/id');
  for (const id of ['', 'bad.id', 'x'.repeat(65)]) rejects(data => { data.steps[0].id = id; }, 'pattern', 'data/steps/0/id');
  accepts(data => { data.steps[0].id = 'x'.repeat(64); });
});

test('diagram groups accept single-step ranges and unordered disjoint declarations', () => {
  accepts(data => {
    data.steps = steps(8);
    data.groups = [{ label: 'Last', from: 'step_7', to: 'step_7' },
      { label: 'First', from: 'step_0', to: 'step_2' }, { label: 'Middle', from: 'step_3', to: 'step_6' }];
  });
  accepts(data => { data.groups = []; });
});

test('diagram groups reject unresolved endpoints, reverse ranges and inclusive overlap', () => {
  for (const endpoint of ['from', 'to']) rejects(data => {
    data.groups = [{ label: 'Group', from: 'client', to: 'server', [endpoint]: 'missing' }];
  }, 'invalid_diagram_group_endpoint', `data/groups/0/${endpoint}`);
  rejects(data => { data.groups = [{ label: 'Reverse', from: 'server', to: 'client' }]; }, 'invalid_diagram_group_order', 'data/groups/0');
  rejects(data => {
    data.steps = steps(4);
    data.groups = [{ label: 'One', from: 'step_0', to: 'step_2' }, { label: 'Two', from: 'step_2', to: 'step_3' }];
  }, 'overlapping_diagram_groups', 'data/groups/1');
  rejects(data => {
    data.groups = [{ label: 'One', from: 'client', to: 'server' }, { label: 'Two', from: 'client', to: 'client' }];
  }, 'overlapping_diagram_groups', 'data/groups/1');
});

test('diagram groups require their closed bounded schema', () => {
  for (const member of ['label', 'from', 'to']) rejects(data => {
    data.groups = [{ label: 'Group', from: 'client', to: 'server' }]; delete data.groups[0][member];
  }, 'required', `data/groups/0/${member}`);
  for (const label of ['', 'G'.repeat(25)]) rejects(data => { data.groups = [{ label, from: 'client', to: 'server' }]; });
  rejects(data => { data.groups = Array.from({ length: 4 }, () => ({ label: 'G', from: 'client', to: 'client' })); }, 'maxItems', 'data/groups');
  accepts(data => { data.groups = [{ label: 'G'.repeat(24), from: 'client', to: 'server' }]; });
});
