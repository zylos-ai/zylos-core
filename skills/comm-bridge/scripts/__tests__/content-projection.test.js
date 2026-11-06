import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTENT_PREFIX, parseC4Content } from '../c4-content-schema.js';
import { projectC4Content } from '../c4-content-projection.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const encode = envelope => CONTENT_PREFIX + JSON.stringify(envelope);
const secret = 'HOST_SECRET_SENTINEL';
const invalid = '[C4 content invalid; c4_id=123]';

for (const fixture of fixtures.ordinary) test(`projection preserves ordinary ${fixture.name}`, () => {
  assert.equal(projectC4Content(fixture.content, { c4Id: 123 }), fixture.content);
});
for (const fixture of fixtures.valid) test(`projection exposes only fallback and references for ${fixture.name}`, () => {
  const { fallbackText, messageId, interruptId } = fixture.envelope;
  const reference = `[C4 messageId=${messageId}${interruptId === undefined ? '' : ` interruptId=${interruptId}`}; c4_id=123]`;
  assert.equal(projectC4Content(fixture.content, { c4Id: 123 }), `${fallbackText}\n${reference}`);
});
for (const fixture of fixtures.invalid) test(`projection hides invalid ${fixture.name}`, () => {
  assert.equal(projectC4Content(fixture.content, { c4Id: 123 }), invalid);
});

test('ordinary text including large JSON is returned byte for byte', () => {
  for (const content of ['', '\r\n😀中\t ', JSON.stringify({ version: 999, metadata: secret }), '😀'.repeat(20000)]) {
    assert.equal(projectC4Content(content, { c4Id: 123 }), content);
  }
});

test('outbound questions hide host metadata and block data', () => {
  const envelope = structuredClone(fixtures.valid.find(row => row.name === 'single').envelope);
  envelope.metadata = { private: secret };
  envelope.blocks[0].data.options[0].description = secret;
  const content = encode(envelope);
  assert.equal(parseC4Content(content).kind, 'envelope');
  const text = projectC4Content(content, { c4Id: 42 });
  assert.equal(text, `${envelope.fallbackText}\n[C4 messageId=single_question interruptId=interrupt_single_question; c4_id=42]`);
  assert.equal(text.includes(secret), false);
});

test('inbound answers retain their saved summary while hiding action and answer IDs', () => {
  const envelope = structuredClone(fixtures.valid.find(row => row.name === 'answer_single_select').envelope);
  envelope.action.id = secret;
  envelope.metadata.zylos.answerId = secret;
  envelope.action.context.conversationId = secret;
  const content = encode(envelope);
  assert.equal(parseC4Content(content).kind, 'envelope');
  const text = projectC4Content(content, { c4Id: 43 });
  assert.equal(text, `${envelope.fallbackText}\n[C4 messageId=message_single_select interruptId=interrupt_single_question; c4_id=43]`);
  assert.ok(text.includes(envelope.questionSummary));
  assert.equal(text.includes(secret), false);
});

for (const [name, change] of [
  ['missing fallback', envelope => { delete envelope.fallbackText; }],
  ['unknown version', envelope => { envelope.version = 2; }],
  ['bad question reference', envelope => { envelope.interrupt.blockId = 'missing'; }],
]) test(`invalid ${name} never leaks host fields`, () => {
  const envelope = structuredClone(fixtures.valid.find(row => row.name === 'single').envelope);
  envelope.metadata = { private: secret };
  change(envelope);
  const content = encode(envelope);
  assert.equal(parseC4Content(content).kind, 'invalid');
  assert.equal(projectC4Content(content, { c4Id: 123 }), invalid);
  assert.equal(projectC4Content(content, { c4Id: 123 }).includes(secret), false);
});

test('broken JSON invalid suffix and oversized marked content never leak payload', () => {
  const envelope = structuredClone(fixtures.valid[0].envelope);
  envelope.metadata = { private: secret };
  for (const content of [encode(envelope).slice(0, -1), encode(envelope) + secret,
    CONTENT_PREFIX + '{"secret":"' + secret + 'x'.repeat(65536) + '"}']) {
    assert.equal(projectC4Content(content, { c4Id: 123 }), invalid);
  }
});

test('projection precedes caller budgets so long original content keeps its short summary', () => {
  const envelope = structuredClone(fixtures.valid[0].envelope);
  envelope.fallbackText = 'Readable summary';
  envelope.metadata = { private: secret, padding: 'x'.repeat(30000) };
  const content = encode(envelope), budget = 100;
  assert.ok(Buffer.byteLength(content) > budget * 100);
  assert.equal(parseC4Content(content).kind, 'envelope');
  const projected = projectC4Content(content, { c4Id: 123 });
  assert.ok(projected.length <= budget);
  assert.equal(projected.slice(0, budget), `${envelope.fallbackText}\n[C4 messageId=${envelope.messageId}; c4_id=123]`);
  assert.equal(projected.includes(secret), false);
  assert.equal(projectC4Content(content.slice(0, budget), { c4Id: 123 }), invalid);
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

test('C4 references accept authoritative integer IDs without echoing arbitrary values', () => {
  const content = CONTENT_PREFIX + '{';
  for (const c4Id of [1, Number.MAX_SAFE_INTEGER, '123', '9223372036854775807']) {
    assert.equal(projectC4Content(content, { c4Id }), `[C4 content invalid; c4_id=${c4Id}]`);
  }
  for (const c4Id of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '01', '9223372036854775808', secret, {}]) {
    assert.equal(projectC4Content(content, { c4Id }), '[C4 content invalid; c4_id=unavailable]');
  }
  assert.equal(projectC4Content(content), '[C4 content invalid; c4_id=unavailable]');
  assert.equal(projectC4Content(null, { c4Id: 123 }), invalid);
});

test('public projection entry loads with an empty component directory and no storage', async () => {
  const home = fs.realpathSync(process.env.HOME), actualHome = fs.realpathSync(os.userInfo().homedir);
  assert.notEqual(home, actualHome);
  const root = fs.realpathSync(process.env.ZYLOS_DIR);
  assert.ok(root.startsWith(home + path.sep));
  const components = path.join(root, 'components');
  fs.mkdirSync(components, { recursive: true });
  assert.deepEqual(fs.readdirSync(components), []);
  const publicApi = await import('../../../../cli/lib/content-projection.js');
  assert.deepEqual(Object.keys(publicApi), ['projectC4Content']);
  assert.equal(publicApi.projectC4Content, projectC4Content);
  for (const fixture of fixtures.valid) {
    assert.ok(publicApi.projectC4Content(fixture.content, { c4Id: 123 }).startsWith(fixture.envelope.fallbackText + '\n'));
  }
  assert.deepEqual(fs.readdirSync(components), []);
  assert.deepEqual(fs.readdirSync(root), ['components']);
});
