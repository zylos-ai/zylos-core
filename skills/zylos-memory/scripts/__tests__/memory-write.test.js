import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeMemory, appendMemory } from '../memory-write.js';

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

test('write and rename failures leave the original and remove temporary files', async t => {
  const f = fixture(t);
  for (const method of ['writeFileSync', 'renameSync']) {
    const io = { ...fs, [method]() { throw Object.assign(new Error('injected I/O failure'), { code: 'EIO' }); } };
    await assert.rejects(writeMemory(f.settings, { currentRunId: liveRun, io }), { code: 'EIO' });
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'original\n');
    assert.deepEqual(fs.readdirSync(f.memory), ['identity.md']);
  }
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

function cli(f, { args = ['--path', 'identity.md', '--sha256', digest('original\n')],
  content = 'CLI content\r\n', ids = {}, waitMs } = {}) {
  const result = spawnSync(process.execPath, [new URL('./helpers/memory-write-cli.js', import.meta.url).pathname, ...args], {
    env: { ...f.env, MEMORY_WRITE_TEST_RUN_IDS: JSON.stringify(ids),
      ...(waitMs === undefined ? {} : { MEMORY_WRITE_TEST_WAIT_MS: String(waitMs) }) },
    input: content, encoding: 'utf8',
  });
  return { ...result, json: JSON.parse(result.stdout) };
}

test('CLI observes the actual single or multi runtime for both Origin marker files', async t => {
  for (const mode of ['legacy', 'single', 'multi']) for (const kind of ['sync', 'origin']) {
    await t.test(`${mode} ${kind}`, t => {
      const f = fixture(t);
      fs.mkdirSync(path.join(f.env.ZYLOS_DIR, '.zylos'));
      fs.writeFileSync(path.join(f.env.ZYLOS_DIR, '.zylos/config.json'), JSON.stringify(mode === 'legacy' ? {} : { session_mode: mode }));
      marker(f, 'origin', kind === 'origin' ? 'origin' : mode === 'legacy' ? 'global' : 'group', {
        runId: mode === 'legacy' ? 'single-live' : 'origin-live',
      });
      for (const args of [undefined, ['--append', '--path', 'identity.md']]) {
        const result = cli(f, { args, ids: { '*': 'single-live', origin: 'origin-live' } });
        assert.equal(result.status, 2, result.stderr);
        assert.equal(result.json.error.code, 'SYNC_BUSY');
        assert.equal(fs.readFileSync(f.file, 'utf8'), 'original\n');
      }
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

const projectHeader = [
  '# Current project',
  '<!-- zylos:entry kind=projects -->',
  '- **Status:** paused',
  '- **Updated:** 2026-11-10',
  '- **Description:** Keep this current description.',
];

test('append merges existing Keys and Moved from in order without changing other header or body bytes', async t => {
  const f = fixture(t);
  const original = [...projectHeader,
    '- **Keys:** alpha, beta, alpha',
    '- **Moved from:** old A, old B, old A',
    '- **Importance:** high',
    '', 'Existing body é.', '- **Keys:** body-only', '',
  ].join('\n');
  const paragraph = '\n## 整理补充（2026-11-12）\n- Appended fact.\n';
  fs.writeFileSync(f.file, original);
  fs.chmodSync(f.file, 0o640);
  const result = await appendMemory({ path: 'identity.md', keys: 'beta, gamma, gamma',
    movedFrom: 'old B, old C, old C', content: paragraph, env: f.env }, { currentRunId: liveRun });
  const expected = [...projectHeader,
    '- **Keys:** alpha, beta, gamma',
    '- **Moved from:** old A, old B, old C',
    '- **Importance:** high',
    '', 'Existing body é.', '- **Keys:** body-only', '',
  ].join('\n') + paragraph;
  assert.equal(fs.readFileSync(f.file, 'utf8'), expected);
  assert.deepEqual(result, { path: 'identity.md', sha256: digest(expected) });
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(f.memory), ['identity.md']);
});

test('concurrent append and hash-checked write preserve both contributions with conflict retry when needed', async t => {
  const f = fixture(t);
  const original = [...projectHeader, '', 'Original body.', ''].join('\n');
  fs.writeFileSync(f.file, original);
  const [append, write] = await Promise.allSettled([
    appendMemory({ path: 'identity.md', content: 'worker supplement\n', env: f.env }, { currentRunId: liveRun }),
    writeMemory({ path: 'identity.md', sha256: digest(original), content: original + 'Sync contribution\n', env: f.env }, {
      currentRunId: liveRun,
    }),
  ]);
  assert.equal(append.status, 'fulfilled', append.reason?.message);
  if (write.status === 'rejected') {
    assert.equal(write.reason.code, 'MEMORY_CONFLICT');
    const bytes = fs.readFileSync(f.file);
    const current = { text: bytes.toString('utf8'), sha256: digest(bytes) };
    await writeMemory({ path: 'identity.md', sha256: current.sha256,
      content: current.text + 'Sync contribution\n', env: f.env }, { currentRunId: liveRun });
  }
  const actual = fs.readFileSync(f.file, 'utf8');
  assert.ok(actual === original + 'worker supplement\nSync contribution\n' ||
    actual === original + 'Sync contribution\nworker supplement\n', actual);
});
