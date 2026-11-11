import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONTENT_PREFIX, MAX_CONTENT_BYTES } from '../../comm-bridge/scripts/c4-content-schema.js';
import { setupChannelFixture } from './helpers/channel-fixture.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const wire = content => {
  const input = structuredClone(fixtures.hookInputs.find(row => row.name === 'valid_input').value);
  input.request.content = content;
  return input;
};
const textEnvelope = JSON.parse(fixtures.valid.find(row => row.name === 'markdown').content.slice(CONTENT_PREFIX.length));
const questionCount = f => f.dashboardDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_questions'").get()
  ? f.count('chat_questions', f.dashboardDb) : 0;

// Boundary: actual BeforeSend rejection before all C4/receiver side effects.
// Run on envelope validation/hook changes; unrelated UI-only edits may skip.
for (const name of ['broken_json', 'unknown_version', 'unknown_block', 'unknown_block_version', 'block_unknown_action', 'wrong_question_summary', 'trailing_prose']) {
  test(`Real send rejects ${name} before storage and delivery`, t => {
    const f = setupChannelFixture(t), content = fixtures.invalid.find(row => row.name === name).content;
    const hook = f.hook(wire(content));
    assert.ifError(hook.error); assert.equal(hook.status, 0, hook.stderr);
    assert.equal(JSON.parse(hook.stdout).decision, 'abort');
    const result = f.send(content);
    assert.ifError(result.error); assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HOOK_ABORTED/);
    assert.equal(JSON.parse(result.stdout.trim()).error.code, 'HOOK_ABORTED');
    for (const table of ['conversations', 'group_heads', 'channel_namespaces']) assert.equal(f.count(table), 0, table);
    assert.equal(questionCount(f), 0);
    assert.equal(fs.existsSync(f.env.CHANNEL_SEND_LOG), false);
    assert.equal(fs.existsSync(f.env.CHANNEL_HTTP_LOG), false);
  });
}

// Boundary: actual send permits unmarked text and valid non-question envelopes.
// Run on framing/validation/delivery changes; unrelated UI-only edits may skip.
for (const [name, content] of [
  ['plain text', 'ordinary 中 😀 "quotes"'], ['Core status text', '[C4] Status: runtime unavailable.'],
  ['ordinary JSON', '{"version":99,"blocks":["ordinary"]}'],
  ['valid markdown', fixtures.valid.find(row => row.name === 'markdown').content],
  ['known suppressed suffix', fixtures.valid.find(row => row.name === 'suppressed_reason_with_spaces').content],
]) test(`Real send preserves ${name} without question registration`, t => {
  const f = setupChannelFixture(t), result = f.send(content);
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  assert.equal(f.count('conversations'), 1); assert.equal(f.count('group_heads'), 1);
  assert.equal(f.c4Db.prepare('SELECT content FROM conversations').get().content, content.trimEnd());
  assert.equal(questionCount(f), 0);
  assert.equal(fs.readFileSync(f.env.CHANNEL_SEND_LOG, 'utf8'), '[]\n');
  assert.equal(fs.existsSync(f.env.CHANNEL_HTTP_LOG), false);
});

// Boundary: exact UTF-8 cap for plain and tagged messages through real c4-send.
// Run on byte-limit changes; unrelated UI-only edits may skip.
for (const structured of [false, true]) {
  test(`Real send enforces the inclusive UTF-8 byte cap for ${structured ? 'structured' : 'plain'} content`, t => {
    const f = setupChannelFixture(t);
    const base = structured ? CONTENT_PREFIX + JSON.stringify(textEnvelope) : '😀中';
    const exact = structured ? CONTENT_PREFIX + ' '.repeat(MAX_CONTENT_BYTES - Buffer.byteLength(base)) + JSON.stringify(textEnvelope)
      : base + 'a'.repeat(MAX_CONTENT_BYTES - Buffer.byteLength(base));
    assert.equal(Buffer.byteLength(exact), MAX_CONTENT_BYTES);
    const below = structured ? CONTENT_PREFIX + exact.slice(CONTENT_PREFIX.length + 1) : exact.slice(0, -1);
    assert.equal(Buffer.byteLength(below), MAX_CONTENT_BYTES - 1);
    for (const content of [below, exact]) {
      const accepted = f.send(content);
      assert.ifError(accepted.error); assert.equal(accepted.status, 0, accepted.stderr);
      assert.equal(f.c4Db.prepare('SELECT content FROM conversations ORDER BY id DESC LIMIT 1').get().content, content);
    }
    const oversized = structured ? CONTENT_PREFIX + ' ' + exact.slice(CONTENT_PREFIX.length) : exact + 'a';
    assert.equal(Buffer.byteLength(oversized), MAX_CONTENT_BYTES + 1);
    const rejected = f.send(oversized);
    assert.ifError(rejected.error); assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /HOOK_ABORTED/);
    assert.equal(f.count('conversations'), 2); assert.equal(f.count('group_heads'), 1);
    assert.equal(fs.readFileSync(f.env.CHANNEL_SEND_LOG, 'utf8'), '[]\n[]\n');
    assert.equal(questionCount(f), 0);
  });
}

// Boundary: hook performs validation only, including legal questions/answers.
// Run on hook changes; unrelated UI-only edits may skip.
test('Real hook accepts all shared valid envelopes without writes or registration', t => {
  const f = setupChannelFixture(t);
  for (const example of fixtures.valid) {
    const result = f.hook(wire(example.content));
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { version: 1, decision: 'continue' }, example.name);
  }
  assert.equal(f.count('conversations'), 0); assert.equal(f.count('group_heads'), 0);
  assert.equal(questionCount(f), 0); assert.equal(fs.existsSync(f.env.CHANNEL_SEND_LOG), false);
});

// Boundary: malformed hook stdin is fail-closed without state changes.
// Run on hook CLI parsing changes; unrelated UI-only edits may skip.
test('Real hook rejects malformed JSON input without side effects', t => {
  const f = setupChannelFixture(t), result = f.hook('{broken');
  assert.ifError(result.error); assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).decision, 'abort');
  assert.equal(f.count('conversations'), 0); assert.equal(questionCount(f), 0);
});
