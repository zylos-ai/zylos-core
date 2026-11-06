import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readChannelHookMetadata, readBeforeSendHook, assertHookProcessSucceeded, runBeforeSendHook, parseBeforeSendOutput } from '../c4-channel-hooks.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-hooks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['x', 'y']) fs.mkdirSync(path.join(root, name));
  const write = (name, source) => fs.writeFileSync(path.join(root, name, 'SKILL.md'), source);
  return { root, write, read: channel => readChannelHookMetadata(channel, { skillsDir: root }) };
}

test('strict metadata reads only the actual channel and never caches declarations', t => {
  const f = fixture(t);
  f.write('x', '---\nc4:\n  before_send: first\n---\nBody');
  f.write('y', '---\nc4: [broken\n---');
  assert.deepEqual(f.read('x'), { before_send: 'first' });
  f.write('x', '---\nc4:\n  before_send: second\n---');
  assert.deepEqual(f.read('x'), { before_send: 'second' });
  assert.throws(() => f.read('y'), { code: 'HOOK_INVALID_OUTPUT' });
});

test('missing skill or absent c4 metadata preserves the unregistered path', t => {
  const f = fixture(t);
  assert.equal(f.read('x'), null);
  for (const text of ['# Channel', '---\nname: x\n---', '---\n---', '\uFEFF---\r\nname: x\r\n---\r\n']) {
    f.write('x', text); assert.equal(f.read('x'), null);
  }
});

test('broken YAML and invalid frontmatter mappings fail closed', t => {
  const f = fixture(t);
  for (const text of ['---\nc4: [broken\n---', '---\nc4: {}', '---\nc4: {}\nc4: {}\n---',
    '---\n- list\n---', '---\nscalar\n---', '---\nc4: null\n---', '---\nc4: []\n---', '---\nc4: !!js/function x\n---']) {
    f.write('x', text); assert.throws(() => f.read('x'), { code: 'HOOK_INVALID_OUTPUT' });
  }
});

test('unavailable channels reject while Core-owned paths never read component metadata', t => {
  const f = fixture(t);
  for (const name of ['missing', '../y', 'x/y', 'x\\y', '', '/x']) {
    assert.throws(() => f.read(name), { code: 'INVALID_ARGS' });
  }
  for (const name of ['internal', 'void', 'system']) {
    assert.equal(readChannelHookMetadata(name, { skillsDir: '/does-not-exist' }), null);
  }
});

function declaration(f, hook) {
  f.write('x', `---\n${JSON.stringify({ c4: { before_send: hook } })}\n---`);
  return () => readBeforeSendHook('x', { skillsDir: f.root });
}

test('one synchronous script is resolved within its own channel without executable requirements', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'x', 'scripts'));
  const script = path.join(f.root, 'x', 'scripts', 'check.js');
  fs.writeFileSync(script, '', { mode: 0o600 });
  const hook = { hook_id: 'check', entry: 'scripts/check.js', timeout_ms: 0.5 };
  assert.deepEqual(declaration(f, hook)(), { hookId: 'check', entry: script, timeoutMs: 0.5, directory: path.join(f.root, 'x') });
  assert.equal(declaration(f, { ...hook, timeout_ms: Number.MAX_VALUE })().timeoutMs, Number.MAX_VALUE);
  assert.equal(declaration(f, { ...hook, async: false })().hookId, 'check');
  f.write('x', '---\nc4:\n  delivery: stdin\n---');
  assert.equal(readBeforeSendHook('x', { skillsDir: f.root }), null);
});

test('missing fields, invalid timeouts, asynchronous and other event declarations reject', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'x', 'check.js'), '');
  const hook = { hook_id: 'check', entry: 'check.js', timeout_ms: 1000 };
  for (const key of Object.keys(hook)) {
    const bad = { ...hook }; delete bad[key];
    assert.throws(declaration(f, bad), { code: 'HOOK_INVALID_OUTPUT' });
  }
  for (const timeout_ms of [null, '1000', 0, -1, Infinity, NaN]) {
    assert.throws(declaration(f, { ...hook, timeout_ms }), { code: 'HOOK_INVALID_OUTPUT' });
  }
  for (const bad of [null, [], [hook], { ...hook, async: true }, { ...hook, url: 'https://example.invalid' },
    { ...hook, hook_id: ' ' }, { ...hook, entry: { type: 'http' } }, { ...hook, event: 'BeforeReceive' }]) {
    assert.throws(declaration(f, bad), { code: 'HOOK_INVALID_OUTPUT' });
  }
  for (const metadata of [{ before_receive: hook }, { before_send: hook, after_send: hook }, { delivery: 'http' }]) {
    f.write('x', `---\n${JSON.stringify({ c4: metadata })}\n---`);
    assert.throws(() => readBeforeSendHook('x', { skillsDir: f.root }), { code: 'HOOK_INVALID_OUTPUT' });
  }
});

test('absolute, escaping, symlink-escaping and non-file entries never execute', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'y', 'check.js'), '');
  fs.symlinkSync(path.join(f.root, 'y', 'check.js'), path.join(f.root, 'x', 'outside.js'));
  for (const entry of [path.join(f.root, 'y', 'check.js'), '../y/check.js', 'outside.js', '.', 'missing.js', 'https://example.invalid/check']) {
    assert.throws(declaration(f, { hook_id: 'check', entry, timeout_ms: 1000 }), { code: 'HOOK_INVALID_OUTPUT' });
  }
});

test('process outcome reasons prioritize timeout and Core output termination over exit signals', () => {
  const success = { timedOut: false, outputTooLarge: false, exitCode: 0, signal: null, error: null };
  assert.equal(assertHookProcessSucceeded(success), undefined);
  for (const result of [{ ...success, timedOut: true, outputTooLarge: true, signal: 'SIGKILL' },
    { ...success, timedOut: true, error: new Error('spawn') }]) {
    assert.throws(() => assertHookProcessSucceeded(result), { code: 'HOOK_TIMEOUT' });
  }
  assert.throws(() => assertHookProcessSucceeded({ ...success, outputTooLarge: true, signal: 'SIGKILL' }), { code: 'HOOK_INVALID_OUTPUT' });
  for (const result of [{ ...success, exitCode: 1 }, { ...success, signal: 'SIGTERM' }, { ...success, error: new Error('spawn') }]) {
    assert.throws(() => assertHookProcessSucceeded(result), { code: 'HOOK_EXEC_FAILED' });
  }
});

test('approved wire contains only the original request and Core-generated correlation IDs', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'x', 'check.js'), '');
  declaration(f, { hook_id: 'check', entry: 'check.js', timeout_ms: 250 })();
  const env = { ZYLOS_SESSION_GROUP: 'x:group', ZYLOS_RUN_ID: 'existing-run',
    ZYLOS_MODEL_CONFIG: '{"runtime":"codex"}', CODEX_SESSION_ID: 'existing-session', CLAUDE_SESSION_ID: 'other-runtime-session' };
  const request = { channel: 'x', endpoint: 'room', groupName: 'group', wholeGroup: false,
    request_id: 'caller', invocation_id: 'caller', context: { component: 'y' }, request: { channel: 'y' } };
  const inputs = [];
  const run = async options => {
    assert.equal(options.command, 'node');
    assert.deepEqual(options.args, [path.join(f.root, 'x', 'check.js')]);
    assert.equal(options.cwd, path.join(f.root, 'x'));
    assert.equal(options.env, env);
    assert.equal(options.timeoutMs, 250);
    const input = JSON.parse(options.input); inputs.push(input);
    assert.deepEqual(Object.keys(input).sort(), ['context','hook_event_name','hook_id','invocation_id','request','request_id','version']);
    assert.equal(input.version, 1); assert.equal(input.hook_event_name, 'BeforeSend'); assert.equal(input.hook_id, 'check');
    assert.match(input.request_id, /^[0-9a-f-]{36}$/); assert.match(input.invocation_id, /^[0-9a-f-]{36}$/);
    assert.notEqual(input.request_id, input.invocation_id);
    assert.deepEqual(input.request, { channel: 'x', endpoint: 'room', content: 'original $() `body`', options: {groupName:'group',wholeGroup:false} });
    assert.deepEqual(input.context, { component:'x',session_group:'x:group',run_id:'existing-run',runtime:'codex',session_id:'existing-session' });
    return { exitCode:0,signal:null,error:null,timedOut:false,outputTooLarge:false,stdout:'{"version":1,"decision":"continue"}' };
  };
  for (let i = 0; i < 2; i++) assert.deepEqual(await runBeforeSendHook(request, 'original $() `body`', { skillsDir:f.root,env,run }), {version:1,decision:'continue'});
  assert.notEqual(inputs[0].request_id, inputs[1].request_id);
  assert.notEqual(inputs[0].invocation_id, inputs[1].invocation_id);
});

test('unknown wire fields and continue messages reject while abort text is single-line code points', () => {
  for (const value of ['bad', '[]', 'null', '{"version":2,"decision":"continue"}',
    '{"version":1,"decision":"maybe"}', '{"version":1,"decision":"continue","message":"unused"}',
    '{"version":1,"decision":"continue","content":"rewrite"}', '{"version":1,"decision":"abort"}',
    '{"version":1,"decision":"abort","message":1}', '{"version":1,"decision":"abort","message":"x","request":{}}']) {
    assert.throws(() => parseBeforeSendOutput(value), { code:'HOOK_INVALID_OUTPUT' });
  }
  const message = 'A\r\nB\rC\nD\u2028E\u2029F' + '😀'.repeat(501);
  const output = parseBeforeSendOutput(JSON.stringify({version:1,decision:'abort',message}));
  assert.equal(Array.from(output.message).length, 500);
  assert.ok(output.message.startsWith('A  B C D E F'));
  assert.doesNotMatch(output.message, /[\r\n\u2028\u2029]/);
  assert.equal(output.message.at(-1), '\ude00', 'final emoji remains a complete supplementary code point');
});
