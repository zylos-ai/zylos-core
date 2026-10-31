import test from 'node:test';
import { acquire, withMemoryLock } from '../sync-lock.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { renderStateSkeleton } from '../state-format.js';
const rootPath = fileURLToPath(new URL('../../../../', import.meta.url));
function run(script, args, env, input = '') {
  return spawnSync(process.execPath, [fileURLToPath(new URL(`../${script}.js`, import.meta.url)), ...args], { env, input, encoding: 'utf8', timeout: 15000 });
}
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
