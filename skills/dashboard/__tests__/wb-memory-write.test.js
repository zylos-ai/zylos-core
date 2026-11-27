import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { MemoryBrowser, memoryErrorPayload } from '../src/lib/memory-browser.js';
import { installMemoryScripts, memoryTestEnv, memoryTempRoot } from './fixtures/memory-installation.js';

const digest = text => createHash('sha256').update(text).digest('hex');
const group = 'openmax:research';
const relative = `session-groups/${group}/handoff.md`;

function fixture(t, { execute, env = {} } = {}) {
  const root = memoryTempRoot('wbm-');
  const childEnv = { ...memoryTestEnv(root), ...env };
  const script = installMemoryScripts(root);
  const memory = path.join(root, 'memory');
  const file = path.join(memory, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'original\n');
  fs.writeFileSync(path.join(memory, 'identity.md'), 'original\n');
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.writeFileSync(path.join(root, '.zylos', 'config.json'), JSON.stringify({ session_mode: 'multi' }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const browser = new MemoryBrowser({ zylosDir: root, executeMemoryWrite: execute, env: childEnv });
  const args = { text: 'changed é\n', sha256: digest('original\n') };
  return { root, childEnv, script, file, relative, browser, args };
}

function assertFailure(browser, rel, args, error, status, code) {
  return assert.rejects(browser.writeFile(rel, args), cause => {
    assert.equal(cause.code, error);
    const payload = memoryErrorPayload(cause);
    assert.equal(payload.status, status);
    if (code) assert.equal(payload.body.code, code);
    return true;
  });
}

// Boundary: the real Core writer invoked by Dashboard against a fixture-owned memory tree.
// Run for writer admission or publication changes; no runtime or tmux starts.
test('a Dashboard save uses the installed Core writer to publish scoped memory', { timeout: 30000 }, async t => {
  const f = fixture(t);
  const result = await f.browser.writeFile(relative, f.args);
  assert.equal(result.text, f.args.text);
  assert.equal(result.sha256, digest(fs.readFileSync(f.file)));
});

test('invalid requests never launch the Core writer', async t => {
  let calls = 0;
  const f = fixture(t, { execute: async () => { calls++; throw Error('must not execute'); } });
  await assertFailure(f.browser, '../x', f.args, 'invalid_memory_path', 400);
  await assertFailure(f.browser, 'missing.md', f.args, 'memory_file_not_found', 404);
  await assertFailure(f.browser, relative, { ...f.args, sha256: 'bad' }, 'invalid_memory_write', 400);
  await assertFailure(f.browser, relative, { ...f.args, text: '\0' }, 'invalid_memory_write', 400);
  await assertFailure(f.browser, relative, { ...f.args, text: '\ufffd' }, 'invalid_memory_write', 400);
  fs.writeFileSync(f.file, Buffer.from([0xff, 0]));
  await assertFailure(f.browser, relative, f.args, 'unsupported_memory_file', 415);
  assert.equal(calls, 0);
});

test('the child uses stdin, bounded execution and the configured instance', async t => {
  let observed;
  const f = fixture(t, { env: { ZYLOS_SESSION_GROUP: 'telegram:inherited', ZYLOS_DIR: '/wrong-root' }, execute: async (...args) => {
    observed = args;
    fs.writeFileSync(f.file, f.args.text);
    return { stdout: JSON.stringify({ ok: true, data: {} }) };
  } });
  const result = await f.browser.writeFile(relative, f.args);
  const [binary, argv, options, input] = observed;
  assert.equal(binary, process.execPath);
  assert.deepEqual(argv, [f.script, '--path', relative, '--sha256', f.args.sha256]);
  assert.equal(input, f.args.text);
  assert.equal(options.timeout, 15000);
  assert.equal(options.maxBuffer, 1024 * 1024);
  assert.equal(options.env.ZYLOS_DIR, f.root);
  assert.equal(Object.hasOwn(options.env, 'ZYLOS_SESSION_GROUP'), false);
  assert.equal(result.sha256, digest(f.args.text));
});

test('a stale hash returns full current metadata and current text', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, 'external edit\n');
  await assert.rejects(f.browser.writeFile(relative, f.args), error => {
    const payload = memoryErrorPayload(error);
    assert.equal(payload.status, 409);
    assert.equal(payload.body.current.path, relative);
    assert.equal(payload.body.current.text, 'external edit\n');
    assert.equal(payload.body.current.sha256, digest('external edit\n'));
    assert.equal(payload.body.current.size_bytes, Buffer.byteLength('external edit\n'));
    return true;
  });
});
