import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readChannelHookMetadata, readBeforeSendHook, runBeforeSendHook } from '../c4-channel-hooks.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-hooks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['x', 'y']) fs.mkdirSync(path.join(root, name));
  const write = (name, source) => fs.writeFileSync(path.join(root, name, 'SKILL.md'), source);
  return { root, write, read: channel => readChannelHookMetadata(channel, { skillsDir: root }) };
}

test('broken YAML and invalid frontmatter mappings fail closed', t => {
  const f = fixture(t);
  for (const text of ['---\nc4: [broken\n---', '---\nc4: {}', '---\nc4: {}\nc4: {}\n---',
    '---\n- list\n---', '---\nscalar\n---', '---\nc4: null\n---', '---\nc4: []\n---', '---\nc4: !!js/function x\n---']) {
    f.write('x', text); assert.throws(() => f.read('x'), { code: 'HOOK_INVALID_OUTPUT' });
  }
});

function declaration(f, hook) {
  f.write('x', `---\n${JSON.stringify({ c4: { before_send: hook } })}\n---`);
  return () => readBeforeSendHook('x', { skillsDir: f.root });
}

test('absolute, escaping, symlink-escaping and non-file entries never execute', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'y', 'check.js'), '');
  fs.symlinkSync(path.join(f.root, 'y', 'check.js'), path.join(f.root, 'x', 'outside.js'));
  for (const entry of [path.join(f.root, 'y', 'check.js'), '../y/check.js', 'outside.js', '.', 'missing.js', 'https://example.invalid/check']) {
    assert.throws(declaration(f, { hook_id: 'check', entry, timeout_ms: 1000 }), { code: 'HOOK_INVALID_OUTPUT' });
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
