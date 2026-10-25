import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { renderStateSkeleton } from '../state-format.js';
const rootPath = fileURLToPath(new URL('../../../../', import.meta.url));
const token = 'a'.repeat(32);
function run(script, args, env, input = '') {
  return spawnSync(process.execPath, [fileURLToPath(new URL(`../${script}.js`, import.meta.url)), ...args], { env, input, encoding: 'utf8', timeout: 15000 });
}
test('IB51 CLI exits distinguish malformed input, ownership loss, conflict and successful commit', t => {
  const f = readyTmuxTarget(t, { prefix: 'p07-cli-', mode: 'single', packageRoot: rootPath });
  const env = { ...f.env, ZYLOS_RUN_ID: f.ready.runId };
  const runDir = path.join(f.root, 'activity-monitor/session-groups/origin');
  const memoryDir = path.join(f.root, 'memory'); fs.mkdirSync(memoryDir);
  fs.writeFileSync(path.join(runDir, 'sync.lock'), JSON.stringify({ runId: env.ZYLOS_RUN_ID, kind: 'global', token, startedAt: Date.now(), expiresAt: Date.now() + 1800000 }));
  const text = renderStateSkeleton({ scope: '*', syncedAt: '2026-10-19T05:30:02Z' });
  fs.writeFileSync(path.join(memoryDir, `state.md.${token}.tmp`), text);
  const invalid = run('sync-files', ['commit', '--token', token], env, '{}');
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /^Error \[INVALID_INPUT\]:/);
  const stale = run('sync-files', ['commit', '--token', 'b'.repeat(32)], env, '{"followedUpIds":[]}');
  assert.equal(stale.status, 3); assert.match(stale.stderr, /^Error \[TOKEN_MISMATCH\]:/);
  const okay = run('sync-files', ['commit', '--token', token], env, '{"followedUpIds":[]}');
  assert.equal(okay.status, 0, okay.stderr); assert.equal(fs.readFileSync(path.join(memoryDir, 'state.md'), 'utf8'), text);
  fs.writeFileSync(path.join(memoryDir, 'identity.md'), 'old');
  const conflict = run('self-write', ['apply', '--kind', 'global', '--token', token], env, JSON.stringify({ path: 'identity.md', expected: 'missing', replacement: 'new' }));
  assert.equal(conflict.status, 4, conflict.stderr); assert.match(conflict.stderr, /^Error \[FRAGMENT_CONFLICT\]:/);
  assert.equal(fs.readFileSync(path.join(memoryDir, 'identity.md'), 'utf8'), 'old');
  const forbidden = run('sync-files', ['list', '--group', 'origin'], env);
  assert.equal(forbidden.status, 1); assert.match(forbidden.stderr, /^Error \[INVALID_INPUT\]:/);
});
