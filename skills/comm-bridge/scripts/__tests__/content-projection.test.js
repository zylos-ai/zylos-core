import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTENT_PREFIX, parseC4Content } from '../c4-content-schema.js';
import { previewMessageText, projectC4Content } from '../c4-content-projection.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const encode = envelope => CONTENT_PREFIX + JSON.stringify(envelope);
const secret = 'HOST_SECRET_SENTINEL';
const invalid = '[C4 content invalid; c4_id=123]';
const viewFixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/view-and-form.json', import.meta.url), 'utf8'));

for (const fixture of fixtures.ordinary) test(`projection preserves ordinary ${fixture.name}`, () => {
  assert.equal(projectC4Content(fixture.content, { c4Id: 123 }), fixture.content);
});
for (const fixture of fixtures.valid) test(`projection exposes only fallback and references for ${fixture.name}`, () => {
  const { fallbackText, messageId, interruptId } = fixture.envelope;
  const reference = `[C4 messageId=${messageId}${interruptId === undefined ? '' : ` interruptId=${interruptId}`}; c4_id=123]`;
  assert.equal(projectC4Content(fixture.content, { c4Id: 123 }), `${fallbackText}\n${reference}`);
});
for (const fixture of fixtures.invalid) test(`projection preserves only qualified fallback for invalid ${fixture.name}`, () => {
  const fallback = fixture.reason === 'invalid_envelope' && fixture.name !== 'missing_fallback'
    ? JSON.parse(fixture.content.slice(CONTENT_PREFIX.length)).fallbackText + '\n' : '';
  assert.equal(projectC4Content(fixture.content, { c4Id: 123 }), fallback + invalid);
});

// Pure IM/model projection boundary. Run for parser/projection changes;
// unrelated presentation and transport changes may skip. No external sends.
test('invalid unknown blocks project their whole-message fallback as literal text', () => {
  const envelope = structuredClone(fixtures.valid.find(row => row.name === 'single').envelope);
  envelope.blocks[0].type = 'unknown';
  envelope.metadata = { private: secret };
  envelope.blocks[0].data.prompt = secret;
  envelope.fallbackText = '<script>alert(1)</script> **literal** [link](javascript:alert(1))';
  assert.equal(projectC4Content(encode(envelope), { c4Id: 123 }), `${envelope.fallbackText}\n${invalid}`);
  assert.equal(projectC4Content(encode(envelope), { c4Id: 123 }).includes(secret), false);
});

test('invalid fallback values and non-JSON content keep the existing invalid marker', () => {
  for (const fallbackText of ['', null, false, 12, [], {}, 'x'.repeat(16001)]) {
    assert.equal(projectC4Content(encode({ fallbackText }), { c4Id: 123 }), invalid);
  }
  for (const content of [encode({}), CONTENT_PREFIX + 'not JSON', CONTENT_PREFIX + '[]']) {
    assert.equal(projectC4Content(content, { c4Id: 123 }), invalid);
  }
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
  assert.equal(projectC4Content(content, { c4Id: 123 }), `${name === 'missing fallback' ? '' : envelope.fallbackText + '\n'}${invalid}`);
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
  for (const c4Id of [1, 95, '95', Number.MAX_SAFE_INTEGER, '123', '9223372036854775807']) {
    assert.equal(projectC4Content(content, { c4Id }), `[C4 content invalid; c4_id=${c4Id}]`);
  }
  for (const c4Id of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '01', '9223372036854775808', '10000000000000000000', secret, {}]) {
    assert.equal(projectC4Content(content, { c4Id }), '[C4 content invalid; c4_id=unavailable]');
  }
  assert.equal(projectC4Content(content), '[C4 content invalid; c4_id=unavailable]');
  assert.equal(projectC4Content(null, { c4Id: 123 }), invalid);
});

test('public projection entry loads with an empty component directory and no storage', async () => {
  const home = fs.realpathSync(process.env.HOME), actualHome = fs.realpathSync(os.userInfo().homedir);
  assert.notEqual(home, actualHome);
  // The Node runner shares one ZYLOS_DIR across concurrently running test
  // files, so this test owns a private root to make its emptiness checks exact.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(home, 'content-projection-zylos-')));
  const previousZylosDir = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = root;
  try {
    const components = path.join(root, 'components');
    fs.mkdirSync(components);
    assert.deepEqual(fs.readdirSync(components), []);
    const publicApi = await import('../../../../cli/lib/content-projection.js');
    assert.deepEqual(Object.keys(publicApi), ['projectC4Content']);
    assert.equal(publicApi.projectC4Content, projectC4Content);
    for (const fixture of fixtures.valid) {
      assert.ok(publicApi.projectC4Content(fixture.content, { c4Id: 123 }).startsWith(fixture.envelope.fallbackText + '\n'));
    }
    assert.deepEqual(fs.readdirSync(components), []);
    assert.deepEqual(fs.readdirSync(root), ['components']);
  } finally {
    if (previousZylosDir === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = previousZylosDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Shared Content/View boundary only. Run for parser/projection changes; skip
// unrelated storage or UI work. No database, transport or component is loaded.
for (const fixture of viewFixtures.views) test(`View ${fixture.name} leaves model projection byte-identical`, () => {
  const base = structuredClone(viewFixtures.message), withView = structuredClone(base);
  withView.metadata = { view: structuredClone(fixture.view) };
  const original = encode(withView), parsed = parseC4Content(original);
  assert.equal(parsed.kind, 'envelope');
  assert.equal(parsed.view === null, !fixture.valid);
  assert.equal('viewError' in parsed, !fixture.valid);
  const expected = `${base.fallbackText}\n[C4 messageId=${base.messageId} interruptId=${base.interruptId}; c4_id=123]`;
  assert.equal(projectC4Content(encode(base), { c4Id: 123 }), expected);
  assert.equal(projectC4Content(original, { c4Id: 123 }), expected);
  if (parsed.viewError) assert.equal(expected.includes(parsed.viewError), false);
});

test('a preview shows what the person said inside the channel wrapping, without the sender prefix', () => {
  const wrapped = '[OM-RUN r_f03d9218] [OPENMAX DM] (org: Enjoy)\n<org-context org-id="019f63e3"/>\n'
    + '<message-context conversation-id="01a1" source-message-id="17"/>\n<openmax-instruction>\nBefore handling the current message, invoke the skill.\n</openmax-instruction>\n'
    + '<current-message>\nhoward said: 这个卡片在手机上\n看布局太乱了\n</current-message> ---- image: /tmp/a.png name="a.png"\n';
  assert.equal(previewMessageText(wrapped), '这个卡片在手机上 看布局太乱了');
  assert.equal(previewMessageText('[Lark DM]\n<current-message>\ne1fg313c said: ok, 0.167.0\n</current-message>\n'), 'ok, 0.167.0');
  // Only a block on its own lines counts: a message quoting the tag inline is ordinary text.
  assert.equal(previewMessageText('[Task] look at `<current-message>` handling'), '[Task] look at `<current-message>` handling');
});

test('a preview is null for channel wrapping without a current message, and plain text passes through', () => {
  assert.equal(previewMessageText('[OM-RUN r_1] [OPENMAX DM] (org: Enjoy)\n<org-context org-id="x"/>\n'), null);
  assert.equal(previewMessageText('[Lark DM]\nsomething internal'), null);
  assert.equal(previewMessageText('[urgent] fix the build'), '[urgent] fix the build');
  assert.equal(previewMessageText('  hello\n\nthere '), 'hello there');
  assert.equal(previewMessageText(''), null);
  assert.equal(previewMessageText(null), null);
  const valid = CONTENT_PREFIX + JSON.stringify({ version: 1, kind: 'message', messageId: 'm1', fallbackText: 'Summary for the person',
    blocks: [{ id: 'b1', type: 'markdown', schemaVersion: 1, data: { text: 'Summary' } }] });
  assert.equal(parseC4Content(valid).kind, 'envelope');
  assert.equal(previewMessageText(valid, { c4Id: 7 }), 'Summary for the person [C4 messageId=m1; c4_id=7]');
});

test('a long preview is cut at the code point limit and ends with an ellipsis', () => {
  assert.equal(previewMessageText('🚀'.repeat(80)), '🚀'.repeat(80));
  assert.equal(previewMessageText('🚀'.repeat(81)), '🚀'.repeat(79) + '…');
  assert.equal(previewMessageText('word '.repeat(10), { limit: 12 }), 'word word…');
});
