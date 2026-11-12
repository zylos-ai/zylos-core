import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
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
const failedEnvelope = code => ({ stdout: JSON.stringify({ ok: false, error: { code } }) });

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
test('a marker without a matching live tmux session cannot acquire Sync', async t => {
  const f = fixture(t);
  const runDir = path.join(f.root, 'activity-monitor', 'session-groups', group);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'sync.lock'), JSON.stringify({ runId: 'absent-run', kind: 'group', token: 'a'.repeat(32), expiresAt: Date.now() + 60000 }));
  const env = { ...f.childEnv, ZYLOS_SESSION_GROUP: group, ZYLOS_RUN_ID: 'absent-run' };
  assert.throws(() => execFileSync(process.execPath, [path.join(path.dirname(f.script), 'sync-lock.js'), 'acquire', '--kind', 'group'], {
    env, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
  }), error => error.status === 1 && error.stderr.includes('SCOPE_UNBOUND'));
});

// Integration: the real Core default lock wait is ten seconds; run after lock
// timeout/adapter changes, skip for unrelated UI or read-only changes.
test('an occupied Core file lock returns a timeout without writing', { timeout: 25000 }, async t => {
  const f = fixture(t);
  const runDir = path.join(f.root, 'activity-monitor', 'session-groups', group);
  const holder = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/memory-lock-holder.js', import.meta.url)),
    path.join(path.dirname(f.script), 'sync-lock.js'), runDir], { env: f.childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const ended = once(holder, 'close');
  const stop = () => { if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL'); };
  t.signal.addEventListener('abort', stop, { once: true });
  const readyDeadline = setTimeout(stop, 3000);
  let diagnostics = '';
  holder.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2048); });
  try {
    const acquired = await Promise.race([
      once(holder.stdout, 'data').then(([bytes]) => bytes.toString()),
      ended.then(() => { throw new Error('Lock holder exited: ' + diagnostics); }),
    ]);
    clearTimeout(readyDeadline);
    assert.equal(acquired, 'held\n');
    const started = Date.now();
    await assertFailure(f.browser, relative, f.args, 'memory_lock_timeout', 503);
    assert.ok(Date.now() - started >= 9500, 'Core must use its default wait');
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'original\n');
  } finally {
    clearTimeout(readyDeadline);
    t.signal.removeEventListener('abort', stop);
    stop();
    await ended;
  }
});

// Integration: permission failure comes from the actual Core temporary-file
// creation; run after publication/error changes, skip for unrelated frontend work.
test('an unwritable destination returns the Core filesystem error', async t => {
  const f = fixture(t);
  const directory = path.dirname(f.file);
  fs.chmodSync(directory, 0o555);
  f.onCleanup(() => fs.chmodSync(directory, 0o755));
  await assertFailure(f.browser, relative, f.args, 'memory_write_failed', 500, 'EACCES');
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'original\n');
});

test('missing Core script rejects saving without a local write fallback', async t => {
  const f = fixture(t);
  fs.unlinkSync(f.script);
  await assertFailure(f.browser, relative, f.args, 'memory_write_unavailable', 503);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'original\n');
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

for (const [code, error, status] of [
  ['LOCK_TIMEOUT', 'memory_lock_timeout', 503], ['IO_ERROR', 'memory_write_failed', 500],
  ['INVALID_INPUT', 'invalid_memory_write', 400], ['X', 'memory_write_failed', 500],
  ['constructor', 'memory_write_failed', 500],
  ['INVALID_MEMORY_PATH', 'invalid_memory_path', 400], ['MEMORY_FILE_NOT_FOUND', 'memory_file_not_found', 404],
]) {
  test(`Core ${code} is mapped to the memory API result`, async t => {
    const f = fixture(t, { execute: async () => { throw Object.assign(new Error('rejected'), { code: 1, ...failedEnvelope(code) }); } });
    await assertFailure(f.browser, relative, f.args, error, status, error === 'memory_write_failed' ? code : undefined);
  });
}

test('Core INVALID_INPUT for empty content gives the dedicated empty-file error', async t => {
  let input;
  const f = fixture(t, { execute: async (_binary, _args, _options, text) => {
    input = text;
    throw Object.assign(new Error('rejected'), { code: 1, ...failedEnvelope('INVALID_INPUT') });
  } });
  await assertFailure(f.browser, relative, { ...f.args, text: '' }, 'memory_write_empty', 400);
  assert.equal(input, '');
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'original\n');
});

test('Core INVALID_INPUT for nonempty whitespace content keeps the generic write error', async t => {
  const f = fixture(t, { execute: async () => failedEnvelope('INVALID_INPUT') });
  await assertFailure(f.browser, relative, { ...f.args, text: ' \n' }, 'invalid_memory_write', 400);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'original\n');
});

test('empty content does not relabel other Core failures as an empty-file error', async t => {
  for (const [code, error, status] of [
    ['SYNC_BUSY', 'memory_sync_busy', 409], ['IO_ERROR', 'memory_write_failed', 500],
  ]) {
    const f = fixture(t, { execute: async () => failedEnvelope(code) });
    await assertFailure(f.browser, relative, { ...f.args, text: '' }, error, status,
      error === 'memory_write_failed' ? code : undefined);
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'original\n');
  }
});

for (const [title, execute] of [
  ['non-JSON output', async () => ({ stdout: 'partial text' })],
  ['an invalid envelope', async () => ({ stdout: '{}' })],
  ['a timed out process', async () => { throw Object.assign(new Error('timeout'), { killed: true, stdout: '{"ok":true}' }); }],
]) {
  test(`${title} gives an unknown result and never retries`, async t => {
    let calls = 0;
    const f = fixture(t, { execute: async (...args) => { calls++; return execute(...args); } });
    await assertFailure(f.browser, relative, f.args, 'memory_write_unknown', 502);
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'original\n');
  });
}

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

test('two saves for the same file launch Core serially', { timeout: 10000 }, async t => {
  let calls = 0, active = 0, maximum = 0, queued = 0, secondOperationStarted = false;
  let releaseFirst, firstStarted, secondAtQueue, secondLaunched;
  const firstMayFinish = new Promise(resolve => { releaseFirst = resolve; });
  const start = new Promise(resolve => { firstStarted = resolve; });
  const queueEntrance = new Promise(resolve => { secondAtQueue = resolve; });
  const prematureLaunch = new Promise(resolve => { secondLaunched = resolve; });
  const f = fixture(t, { execute: async () => {
    const call = ++calls;
    maximum = Math.max(maximum, ++active);
    if (call === 1) { firstStarted(); await firstMayFinish; }
    else secondLaunched();
    fs.writeFileSync(f.file, call === 1 ? 'first' : 'second');
    active--;
    return { stdout: '{"ok":true,"data":{}}' };
  } });
  // Observe the actual queue entrance after both requests finish validation;
  // delegate unchanged to the product queue and observe when its work starts.
  const withWriteLock = f.browser.withWriteLock.bind(f.browser);
  f.browser.withWriteLock = (real, operation) => {
    const position = ++queued;
    const result = withWriteLock(real, () => {
      if (position === 2) secondOperationStarted = true;
      return operation();
    });
    if (position === 2) secondAtQueue();
    return result;
  };
  const first = f.browser.writeFile(relative, f.args);
  await start;
  const second = f.browser.writeFile(relative, { ...f.args, text: 'second' });
  let deadline;
  try {
    await Promise.race([
      queueEntrance,
      prematureLaunch.then(() => assert.fail('second save bypassed the occupied queue')),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('second save never reached the queue')), 3000); }),
    ]);
    assert.equal(queued, 2);
    assert.equal(secondOperationStarted, false, 'second validated save must wait for the first');
    assert.equal(calls, 1);
  } finally {
    clearTimeout(deadline);
    releaseFirst();
    await Promise.allSettled([first, second]);
  }
  assert.equal(calls, 2);
  assert.equal(secondOperationStarted, true);
  assert.equal(maximum, 1);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'second');
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
