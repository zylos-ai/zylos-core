import test from 'node:test';
import { acquire, withMemoryLock } from '../sync-lock.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { positiveInteger } from '../sync-cli.js';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { renderStateSkeleton } from '../state-format.js';
const rootPath = fileURLToPath(new URL('../../../../', import.meta.url));
function run(script, args, env, input = '') {
  return spawnSync(process.execPath, [fileURLToPath(new URL(`../${script}.js`, import.meta.url)), ...args], { env, input, encoding: 'utf8', timeout: 15000 });
}
// Integration boundary: real CLI + private tmux identity + temporary memory.
// Run when sync CLI errors/lock handling change; skip for unrelated changes.
// readyTmuxTarget owns and cleans its private socket, session and fixture root.
test('CLI exits distinguish malformed input, ownership loss, lock timeout and successful commit', async t => {
  const f = readyTmuxTarget(t, { prefix: 'model-workflow-cli-', mode: 'single', packageRoot: rootPath });
  const env = { ...f.env, ZYLOS_RUN_ID: f.ready.runId };
  const runDir = path.join(f.root, 'activity-monitor/session-groups/origin');
  const memoryDir = path.join(f.root, 'memory'); fs.mkdirSync(memoryDir);
  const token = await acquire({ env, kind: 'global' }, { currentRunId: async () => env.ZYLOS_RUN_ID });
  const text = renderStateSkeleton({ scope: '*', syncedAt: '2026-10-19T05:30:02Z' });
  fs.writeFileSync(path.join(memoryDir, `state.md.${token}.tmp`), text);
  const invalid = run('sync-files', ['commit', '--token', token], env, '{}');
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /^Error \[INVALID_INPUT\]:/);
  const stale = run('sync-files', ['commit', '--token', 'b'.repeat(32)], env, '{"followedUpIds":[]}');
  assert.equal(stale.status, 3); assert.match(stale.stderr, /^Error \[TOKEN_MISMATCH\]:/);
  const okay = run('sync-files', ['commit', '--token', token], env, '{"followedUpIds":[]}');
  assert.equal(okay.status, 0, okay.stderr); assert.equal(fs.readFileSync(path.join(memoryDir, 'state.md'), 'utf8'), text);
  await withMemoryLock(runDir, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../sync-files.js', import.meta.url)), 'commit', '--token', token], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end('{"followedUpIds":[]}');
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => {
      try { assert.equal(code, 2, stderr); assert.match(stderr, /LOCK_TIMEOUT/); assert.equal(fs.readFileSync(path.join(memoryDir, 'state.md'), 'utf8'), text); resolve(); }
      catch (error) { reject(error); }
    });
  }));
  const forbidden = run('sync-files', ['list', '--group', 'origin'], env);
  assert.equal(forbidden.status, 1); assert.match(forbidden.stderr, /^Error \[INVALID_INPUT\]:/);
});

test('positive integer parsing accepts decimal IDs and rejects coercible non-IDs', () => {
  for (const value of ['1', '42', String(Number.MAX_SAFE_INTEGER)]) {
    assert.equal(positiveInteger(value, 'id'), Number(value));
  }
  for (const value of ['', ' ', '0', '-1', '1.5', 'abc', '1e3', '0x10', '+1', ' 1', '1 ', '9007199254740992']) {
    assert.throws(() => positiveInteger(value, 'id'), { code: 'INVALID_INPUT', exitCode: 1 });
  }
});

// Integration boundary: real CLI argument parsing rejects bad IDs before any
// lock/database access, while valid IDs proceed to the normal guard path.
// Run for sync numeric-argument changes; skip for unrelated changes. Each case
// uses private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR and t.after removes the fixture.
// No tmux server or database is needed because no valid Sync marker exists.
test('numeric CLI arguments reject invalid IDs before touching memory or databases', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-cli-input-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: path.join(dir, 'home'), ZYLOS_DIR: path.join(dir, 'zylos'),
    PM2_HOME: path.join(dir, 'pm2'), TMPDIR: path.join(dir, 'tmp'),
    ZYLOS_RUN_ID: 'input-test', ZYLOS_SESSION_GROUP: 'origin' };
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) fs.mkdirSync(env[key], { recursive: true });
  const token = 'b'.repeat(32);
  for (const value of ['', ' ', '0', '-1', '1.5', 'abc', '1e3', '0x10', '+1', ' 1', '1 ', '9007199254740992']) {
    const calls = [
      ['sync-files', ['checkpoint', value, '--token', token]],
      ['origin-cursor', ['advance', '--group', 'telegram:test', '--synced', value, '--checkpoint', '1', '--token', token]],
      ['origin-cursor', ['advance', '--group', 'telegram:test', '--synced', '1', '--checkpoint', value, '--token', token]],
    ];
    for (const [script, args] of calls) {
      const result = run(script, args, env);
      assert.equal(result.status, 1, `${script} ${JSON.stringify(value)}: ${result.stderr}`);
      assert.match(result.stderr, /^Error \[INVALID_INPUT\]:/);
    }
  }
  assert.deepEqual(fs.readdirSync(env.ZYLOS_DIR), []);
  for (const [script, args] of [
    ['sync-files', ['checkpoint', '1', '--token', token]],
    ['origin-cursor', ['advance', '--group', 'telegram:test', '--synced', '1', '--checkpoint', '1', '--token', token]],
  ]) {
    const result = run(script, args, env);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /^Error \[TOKEN_MISMATCH\]:/);
  }
});
