import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { MemoryBrowser, memoryErrorPayload } from '../src/lib/memory-browser.js';
import { tmuxNameForGroup } from '../../../cli/lib/session-group-paths.js';
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
  const cleanups = [];
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  const browser = new MemoryBrowser({ zylosDir: root, executeMemoryWrite: execute, env: childEnv });
  const args = { text: 'changed é\n', sha256: digest('original\n') };
  return { root, childEnv, script, file, relative, browser, args, onCleanup: action => cleanups.push(action) };
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

// Integration: exercising actual Core save/Sync admission and publication; run
// when the adapter/locking boundary changes, skip for unrelated frontend work.
test('active group Sync blocks saving until its real marker is released', { timeout: 30000 }, async t => {
  const f = fixture(t);
  const env = { ...f.childEnv, ZYLOS_SESSION_GROUP: group, ZYLOS_RUN_ID: 'memory-test-run' };
  const lock = path.join(path.dirname(f.script), 'sync-lock.js');
  const tmux = args => execFileSync('tmux', args, { env, encoding: 'utf8', timeout: 5000 });
  f.onCleanup(() => { try { tmux(['kill-server']); } catch {} });
  tmux(['-f', '/dev/null', 'new-session', '-d', '-s', tmuxNameForGroup(group),
    '-e', `ZYLOS_SESSION_GROUP=${group}`, '-e', 'ZYLOS_RUN_ID=memory-test-run']);
  const token = execFileSync(process.execPath, [lock, 'acquire', '--kind', 'group'], { env, encoding: 'utf8', timeout: 15000 }).trim();
  await assertFailure(f.browser, relative, f.args, 'memory_sync_busy', 409);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'original\n');
  execFileSync(process.execPath, [lock, 'release', '--kind', 'group', '--token', token], { env, timeout: 15000 });
  const result = await f.browser.writeFile(relative, f.args);
  assert.equal(result.text, f.args.text);
  assert.equal(result.sha256, digest(fs.readFileSync(f.file)));
});

// Integration: verifies real admission observes tmux identity, not a fabricated
// on-disk marker; run with Sync/save boundary changes, skip for display changes.

// Integration: the real Core default lock wait is ten seconds; run after lock
// timeout/adapter changes, skip for unrelated UI or read-only changes.

// Integration: permission failure comes from the actual Core temporary-file
// creation; run after publication/error changes, skip for unrelated frontend work.

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
