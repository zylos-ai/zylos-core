import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { writeMemory } from '../memory-write.js';
import { MemoryBrowser } from '../../../dashboard/src/lib/memory-browser.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const liveRun = async () => 'live-run';
const runDir = (f, group) => path.join(f.env.ZYLOS_DIR, 'activity-monitor/session-groups', group);
function marker(f, group, kind, changes = {}) {
  const dir = runDir(f, group);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, kind === 'origin' ? 'origin-sync.lock' : 'sync.lock'), JSON.stringify({
    runId: 'live-run', kind, token: 'a'.repeat(32), expiresAt: Date.now() + 60000, ...changes,
  }));
}

function groupFile(f, group) {
  const rel = `session-groups/${group}/state.md`;
  const file = path.join(f.memory, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'original\n');
  return { ...f.settings, path: rel };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-write-'));
  const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'home/zylos'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp') };
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) fs.mkdirSync(env[key], { recursive: true });
  const memory = path.join(env.ZYLOS_DIR, 'memory');
  fs.mkdirSync(memory);
  const file = path.join(memory, 'identity.md');
  fs.writeFileSync(file, 'original\n', { mode: 0o640 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, env, memory, file, settings: { path: 'identity.md', sha256: digest('original\n'), content: 'updated\n', env } };
}

test('save publishes the requested bytes and hash while preserving permissions', async t => {
  const f = fixture(t);
  const bytes = Buffer.from([0x00, 0xff, 0xc3, 0xa9, 0x0a]);
  fs.chmodSync(f.file, 0o664);
  const beforeUmask = process.umask(0o077);
  t.after(() => process.umask(beforeUmask));
  const result = await writeMemory({ ...f.settings, content: bytes }, { currentRunId: liveRun });
  assert.deepEqual(result, { path: 'identity.md', sha256: digest(bytes) });
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o664);
  assert.deepEqual(fs.readdirSync(f.memory), ['identity.md']);
});

test('conflict returns the current raw-byte hash and text without changing the file', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, 'newer é\r\n');
  await assert.rejects(writeMemory(f.settings, { currentRunId: liveRun }), error => {
    assert.equal(error.code, 'MEMORY_CONFLICT');
    assert.deepEqual(error.current, { text: 'newer é\r\n', sha256: digest(fs.readFileSync(f.file)) });
    return true;
  });
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'newer é\r\n');
  assert.deepEqual(fs.readdirSync(f.memory), ['identity.md']);
});

test('expected hashes use raw bytes for nonempty replacement content', async t => {
  const f = fixture(t);
  const original = Buffer.from([0xff, 0x00, 0xc3, 0xa9]);
  fs.writeFileSync(f.file, original);
  const replacement = Buffer.from([0x00, 0xff, 0x0a]);
  const result = await writeMemory({ ...f.settings, sha256: digest(original), content: replacement }, { currentRunId: liveRun });
  assert.equal(result.sha256, digest(replacement));
  assert.deepEqual(fs.readFileSync(f.file), replacement);
});

for (const content of ['', Buffer.alloc(0)]) {
  test(`empty ${typeof content === 'string' ? 'string' : 'buffer'} content is refused without changing file bytes`, async t => {
    const f = fixture(t);
    const original = Buffer.from([0xff, 0x00, 0xc3, 0xa9]);
    fs.writeFileSync(f.file, original);
    await assert.rejects(writeMemory({ ...f.settings, sha256: digest(original), content }, {
      currentRunId: async () => assert.fail('empty input reached runtime observation'),
    }), { code: 'INVALID_INPUT' });
    assert.deepEqual(fs.readFileSync(f.file), original);
    assert.deepEqual(fs.readdirSync(f.memory), ['identity.md']);
  });
}

// Integration boundary: actual public CLI rejects empty stdin before runtime
// observation. Run for writer input-validation/CLI changes; skip otherwise.
// The runner and fixture isolate HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; the child
// reads only fixture paths, has a bounded lifetime, and opens no tmux/socket/DB.
test('CLI refuses empty stdin and preserves the existing file', { timeout: 10000 }, t => {
  const f = fixture(t);
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(f.env[key].startsWith(f.root + path.sep));
  }
  const args = [new URL('../memory-write.js', import.meta.url).pathname,
    '--path', 'identity.md', '--sha256', f.settings.sha256];
  t.diagnostic(JSON.stringify({ args, paths: Object.fromEntries(
    ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, f.env[key]])),
    tmux: 'unused', socket: 'unused', database: 'unused' }));
  const result = spawnSync(process.execPath, args, {
    env: f.env, input: '', encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'INVALID_INPUT');
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'original\n');
  assert.deepEqual(fs.readdirSync(f.memory), ['identity.md']);
});

test('invalid paths and non-files are rejected before any runtime observation', async t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'note.md'), 'outside');
  fs.symlinkSync(outside, path.join(f.memory, 'linked-dir'));
  fs.symlinkSync(path.join(outside, 'note.md'), path.join(f.memory, 'linked-file.md'));
  fs.mkdirSync(path.join(f.memory, 'directory'));
  const cases = ['', '../outside/note.md', 'a/../identity.md', '/etc/passwd', 'C:\\outside',
    'C:/outside', 'C:', 'a\\identity.md', 'a//identity.md', './identity.md', 'identity.md\0',
    'linked-dir/note.md', 'linked-file.md', 'missing.md', 'directory'];
  for (const value of cases) {
    await assert.rejects(writeMemory({ ...f.settings, path: value }, {
      currentRunId: async () => assert.fail('invalid path reached runtime observation'),
    }), error => ['INVALID_MEMORY_PATH', 'MEMORY_FILE_NOT_FOUND'].includes(error.code), value);
  }
  assert.equal(fs.readFileSync(path.join(outside, 'note.md'), 'utf8'), 'outside');
  assert.equal(fs.existsSync(path.join(f.env.ZYLOS_DIR, 'activity-monitor')), false);
});

test('a symlinked memory root saves through its resolved directory', async t => {
  const f = fixture(t);
  const renamed = path.join(f.root, 'renamed-memory');
  fs.renameSync(f.memory, renamed);
  fs.symlinkSync(renamed, f.memory);
  const browser = new MemoryBrowser({ zylosDir: f.env.ZYLOS_DIR });
  assert.equal((await browser.resolvePath('identity.md', { requireFile: true })).real, path.join(renamed, 'identity.md'));
  assert.equal((await browser.file('identity.md')).sha256, f.settings.sha256);
  const result = await writeMemory(f.settings, { currentRunId: liveRun });
  assert.equal(result.sha256, digest('updated\n'));
  assert.equal(fs.readFileSync(path.join(renamed, 'identity.md'), 'utf8'), 'updated\n');
  assert.equal(fs.lstatSync(f.memory).isSymbolicLink(), true);
  assert.equal(fs.statSync(path.join(renamed, 'identity.md')).mode & 0o777, 0o640);
  assert.equal((await browser.file('identity.md')).sha256, result.sha256);
});

test('a memory root that is not a directory is refused', async t => {
  const f = fixture(t);
  fs.unlinkSync(f.file);
  fs.rmdirSync(f.memory);
  fs.writeFileSync(f.memory, 'not a directory');
  await assert.rejects(writeMemory(f.settings), { code: 'INVALID_MEMORY_PATH' });
});

test('invalid hashes and group keys do not mutate memory', async t => {
  const f = fixture(t);
  for (const hash of [undefined, '', 'g'.repeat(64), 'a'.repeat(63), 'A'.repeat(64)]) {
    await assert.rejects(writeMemory({ ...f.settings, sha256: hash }), { code: 'INVALID_INPUT' });
  }
  fs.mkdirSync(path.join(f.memory, 'session-groups/INVALID'), { recursive: true });
  fs.writeFileSync(path.join(f.memory, 'session-groups/INVALID/state.md'), 'original\n');
  await assert.rejects(writeMemory({ ...f.settings, path: 'session-groups/INVALID/state.md' }), { code: 'SESSION_GROUP_INVALID' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'original\n');
});

test('write and rename failures leave the original and remove temporary files', async t => {
  const f = fixture(t);
  for (const method of ['writeFileSync', 'renameSync']) {
    const io = { ...fs, [method]() { throw Object.assign(new Error('injected I/O failure'), { code: 'EIO' }); } };
    await assert.rejects(writeMemory(f.settings, { currentRunId: liveRun, io }), { code: 'EIO' });
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'original\n');
    assert.deepEqual(fs.readdirSync(f.memory), ['identity.md']);
  }
});

test('target content and symlinks are checked again after runtime observation', async t => {
  const f = fixture(t);
  await assert.rejects(writeMemory(f.settings, { currentRunId: async () => {
    fs.writeFileSync(f.file, 'changed while observing');
    return 'live-run';
  } }), { code: 'MEMORY_CONFLICT' });
  const outside = path.join(f.root, 'outside.md');
  fs.writeFileSync(outside, 'original\n');
  await assert.rejects(writeMemory(f.settings, { currentRunId: async () => {
    fs.unlinkSync(f.file);
    fs.symlinkSync(outside, f.file);
    return 'live-run';
  } }), { code: 'INVALID_MEMORY_PATH' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'original\n');
});

test('group Sync blocks only a live unexpired marker in that file scope', async t => {
  for (const [name, changes, busy] of [
    ['active', {}, true], ['old run', { runId: 'previous-run' }, false],
    ['expired', { expiresAt: Date.now() - 1 }, false],
  ]) await t.test(name, async t => {
    const f = fixture(t);
    const settings = groupFile(f, 'lark:room');
    marker(f, 'lark:room', 'group', changes);
    const currentRunId = async scope => {
      assert.equal(scope.sessionGroup, 'lark:room');
      assert.equal(scope.runDir, runDir(f, 'lark:room'));
      return 'live-run';
    };
    const operation = writeMemory(settings, { currentRunId });
    if (busy) {
      await assert.rejects(operation, { code: 'SYNC_BUSY', exitCode: 2 });
      await assert.rejects(writeMemory({ ...settings, sha256: '0'.repeat(64) }, { currentRunId }), { code: 'SYNC_BUSY' });
      assert.equal(fs.readFileSync(path.join(f.memory, settings.path), 'utf8'), 'original\n');
    } else {
      await operation;
      assert.equal(fs.readFileSync(path.join(f.memory, settings.path), 'utf8'), 'updated\n');
    }
  });
});

test('shared memory refuses either Origin marker and ignores another group', async t => {
  for (const kind of ['global', 'origin']) await t.test(kind, async t => {
    const f = fixture(t);
    marker(f, 'origin', kind);
    await assert.rejects(writeMemory(f.settings, { currentRunId: liveRun }), { code: 'SYNC_BUSY', exitCode: 2 });
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'original\n');
  });
  await t.test('another group does not block shared memory', async t => {
    const f = fixture(t);
    marker(f, 'lark:other', 'group');
    const env = { ...f.env, ZYLOS_SESSION_GROUP: 'lark:other', ZYLOS_RUN_ID: 'caller-run' };
    await writeMemory({ ...f.settings, env }, { currentRunId: async scope => {
      assert.equal(scope.runDir, runDir(f, 'origin'));
      return 'live-run';
    } });
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'updated\n');
  });
});

async function holdLock(f, dir) {
  const child = fork(new URL('./helpers/memory-lock-holder.js', import.meta.url), [dir], {
    env: f.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const closed = once(child, 'close');
  try {
    const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(3000) });
    assert.equal(ready, 'locked', stderr);
  } catch (error) {
    child.kill('SIGKILL');
    await closed;
    throw error;
  }
  return async () => {
    child.send('release');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await closed; } finally { clearTimeout(timeout); }
  };
}

// Integration boundary: another process holds the actual memory.lock in a
// temporary HOME/ZYLOS_DIR/run directory, PM2_HOME and short TMPDIR. Runtime
// identity is injected; no tmux, database or live resource is used. Run for writer scope/locking changes,
// skip otherwise. The child is reaped before the fixture removes its directory.
test('a child holding the same lock causes timeout; another group lock does not', async t => {
  const f = fixture(t);
  for (const [group, timeout] of [['origin', true], ['lark:other', false]]) {
    const release = await holdLock(f, runDir(f, group));
    try {
      const operation = writeMemory({ ...f.settings, waitMs: 80 }, { currentRunId: liveRun });
      if (timeout) {
        await assert.rejects(operation, { code: 'LOCK_TIMEOUT', exitCode: 2 });
        assert.equal(fs.readFileSync(f.file, 'utf8'), 'original\n');
      } else {
        await operation;
        assert.equal(fs.readFileSync(f.file, 'utf8'), 'updated\n');
      }
    } finally { await release(); }
  }
});

function cli(f, { args = ['--path', 'identity.md', '--sha256', digest('original\n')],
  content = 'CLI content\r\n', ids = {}, waitMs } = {}) {
  const result = spawnSync(process.execPath, [new URL('./helpers/memory-write-cli.js', import.meta.url).pathname, ...args], {
    env: { ...f.env, MEMORY_WRITE_TEST_RUN_IDS: JSON.stringify(ids),
      ...(waitMs === undefined ? {} : { MEMORY_WRITE_TEST_WAIT_MS: String(waitMs) }) },
    input: content, encoding: 'utf8',
  });
  return { ...result, json: JSON.parse(result.stdout) };
}

test('CLI emits JSON for success, conflicts and argument errors', t => {
  const f = fixture(t);
  const saved = cli(f);
  assert.equal(saved.status, 0, saved.stderr);
  assert.deepEqual(saved.json, { ok: true, data: { path: 'identity.md', sha256: digest('CLI content\r\n') } });
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'CLI content\r\n');
  const conflict = cli(f);
  assert.equal(conflict.status, 1);
  assert.equal(conflict.json.ok, false);
  assert.equal(conflict.json.error.code, 'MEMORY_CONFLICT');
  assert.deepEqual(conflict.json.error.current, { text: 'CLI content\r\n', sha256: digest('CLI content\r\n') });
  for (const args of [[], ['identity.md'], ['--path', 'identity.md'], ['--other', 'value'],
    ['--path', 'identity.md', '--path', 'identity.md', '--sha256', digest('original\n')]]) {
    const result = cli(f, { args });
    assert.equal(result.status, 1, String(args));
    assert.equal(result.json.ok, false);
    assert.equal(result.json.error.code, 'INVALID_INPUT');
  }
  const actualEntry = spawnSync(process.execPath, [new URL('../memory-write.js', import.meta.url).pathname], {
    env: f.env, input: '', encoding: 'utf8',
  });
  assert.equal(actualEntry.status, 1);
  assert.equal(JSON.parse(actualEntry.stdout).error.code, 'INVALID_INPUT');
});

test('CLI observes the actual single or multi runtime for both Origin marker files', async t => {
  for (const mode of ['single', 'multi']) for (const kind of ['sync', 'origin']) {
    await t.test(`${mode} ${kind}`, t => {
      const f = fixture(t);
      fs.mkdirSync(path.join(f.env.ZYLOS_DIR, '.zylos'));
      fs.writeFileSync(path.join(f.env.ZYLOS_DIR, '.zylos/config.json'), JSON.stringify({ session_mode: mode }));
      marker(f, 'origin', kind === 'origin' ? 'origin' : mode === 'multi' ? 'group' : 'global', {
        runId: mode === 'multi' ? 'origin-live' : 'single-live',
      });
      const result = cli(f, { ids: { '*': 'single-live', origin: 'origin-live' } });
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.json.error.code, 'SYNC_BUSY');
      assert.equal(fs.readFileSync(f.file, 'utf8'), 'original\n');
    });
  }
});

test('CLI group path uses its live identity, not the caller group or run', t => {
  const f = fixture(t);
  const settings = groupFile(f, 'lark:room');
  marker(f, 'lark:room', 'group', { runId: 'group-live' });
  f.env.ZYLOS_SESSION_GROUP = 'lark:other';
  f.env.ZYLOS_RUN_ID = 'caller-run';
  const result = cli(f, { args: ['--path', settings.path, '--sha256', settings.sha256],
    ids: { 'lark:room': 'group-live', 'lark:other': 'caller-run' } });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.json.error.code, 'SYNC_BUSY');
  assert.equal(fs.readFileSync(path.join(f.memory, settings.path), 'utf8'), 'original\n');
});

// Integration boundary: CLI parsing/JSON/exit codes around real child-held locks.
// HOME, ZYLOS_DIR, PM2_HOME, short TMPDIR and all run paths are temporary; runtime
// identity is injected, with no tmux, database or live-resource access. Run for
// writer CLI/locking changes; skip otherwise. Reap the holder before root cleanup.
test('CLI lock timeout is JSON with the shared lock exit code', async t => {
  const f = fixture(t);
  const release = await holdLock(f, runDir(f, 'origin'));
  try {
    const result = cli(f, { waitMs: 80 });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.error.code, 'LOCK_TIMEOUT');
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'original\n');
  } finally { await release(); }
});
