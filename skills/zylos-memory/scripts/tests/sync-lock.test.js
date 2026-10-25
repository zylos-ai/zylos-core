import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { acquire, release, guard, memoryScope, readSyncMarker, MARKER_TTL_MS } from '../sync-lock.js';
const fixture = group => ({ ZYLOS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sync-marker-')), ZYLOS_RUN_ID: 'run-1', ...(group ? { ZYLOS_SESSION_GROUP: group } : {}) });
const currentRunId = async scope => scope.runId;

// IB-51: acquisition uses the real P02 reader rather than trusting caller env.
test('CLI acquire checks the current isolated tmux identity', t => {
  const f = readyTmuxTarget(t, { prefix: 'sync-lock-live-', ledger: false });
  const env = { ...f.env, ZYLOS_RUN_ID: 'run-1' };
  const script = fileURLToPath(new URL('../sync-lock.js', import.meta.url));
  const run = (args, runtimeEnv = env) => spawnSync(process.execPath, [script, ...args], { env: runtimeEnv, encoding: 'utf8' });
  const first = run(['acquire', '--kind', 'global']);
  assert.equal(first.status, 0, first.stderr); assert.match(first.stdout.trim(), /^[0-9a-f]{32}$/);
  const busy = run(['acquire', '--kind', 'global']);
  assert.equal(busy.status, 2); assert.match(busy.stderr, /^Error \[SYNC_BUSY\]:/);
  const wrong = run(['acquire', '--kind', 'global'], { ...env, ZYLOS_RUN_ID: 'old-run' });
  assert.equal(wrong.status, 1); assert.match(wrong.stderr, /^Error \[SCOPE_UNBOUND\]:/);
  const freed = run(['release', '--kind', 'global', '--token', first.stdout.trim()]);
  assert.equal(freed.status, 0, freed.stderr);
});

// IB-39 / IF-42: exact read shape, stale takeover and obsolete-token refusal.
test('F7 lifecycle, independent origin marker, stale takeover and old release', async () => {
  const env = fixture('origin');
  const scope = await memoryScope(env);
  assert.deepEqual(readSyncMarker({ runDir: scope.runDir, kind: 'group', currentRunId: 'run-1' }),
    { held: false, stale: false, runId: null, expiresAt: null, reason: 'missing' });
  const token = await acquire({ kind: 'group', env }, { currentRunId });
  assert.match(token, /^[a-f0-9]{32}$/);
  const marker = JSON.parse(fs.readFileSync(path.join(scope.runDir, 'sync.lock')));
  assert.equal(marker.expiresAt - marker.startedAt, MARKER_TTL_MS);
  assert.equal(readSyncMarker({ runDir: scope.runDir, kind: 'group', currentRunId: 'run-1' }).held, true);
  await assert.rejects(acquire({ kind: 'group', env }, { currentRunId }), { code: 'SYNC_BUSY', exitCode: 2 });
  const originToken = await acquire({ kind: 'origin', env }, { currentRunId });
  assert.notEqual(token, originToken);
  let mutations = 0;
  await guard({ kind: 'group', token, env }, () => { mutations++; }, { currentRunId });
  const newer = { ...env, ZYLOS_RUN_ID: 'run-2' };
  assert.equal(readSyncMarker({ runDir: scope.runDir, kind: 'group', currentRunId: 'run-2' }).stale, true);
  const next = await acquire({ kind: 'group', env: newer }, { currentRunId });
  await assert.rejects(guard({ kind: 'group', token, env }, () => { mutations++; }, { currentRunId }), { code: 'TOKEN_MISMATCH', exitCode: 3 });
  await release({ kind: 'group', token, env });
  assert.equal(JSON.parse(fs.readFileSync(path.join(scope.runDir, 'sync.lock'))).token, next);
  assert.equal(mutations, 1);
  await release({ kind: 'group', token: next, env: newer });
  await release({ kind: 'origin', token: originToken, env });
});

test('expired markers, invalid marker warning, scope and current-run checks', async () => {
  const env = fixture();
  const scope = await memoryScope(env);
  const token = await acquire({ kind: 'global', env }, { currentRunId, now: () => 1 });
  assert.equal(readSyncMarker({ runDir: scope.runDir, kind: 'global', currentRunId: 'run-1' }).stale, true);
  await acquire({ kind: 'global', env }, { currentRunId });
  await assert.rejects(acquire({ kind: 'group', env }, { currentRunId }), { code: 'SCOPE_UNBOUND' });
  await assert.rejects(acquire({ kind: 'global', env }, { currentRunId: async () => 'replaced' }), { code: 'SCOPE_UNBOUND' });
  fs.writeFileSync(path.join(scope.runDir, 'sync.lock'), '{bad');
  const warnings = [];
  const result = readSyncMarker({ runDir: scope.runDir, kind: 'global', currentRunId: 'run-1' }, { warn: text => warnings.push(text) });
  assert.equal(result.held, false); assert.equal(result.reason, 'invalid'); assert.equal(warnings.length, 1);
  assert.ok(token);
});

// DM-40: marker expiry permits a later takeover, never revokes a held F8.
test('expiry during a guarded operation cannot admit a contender', async () => {
  const env = fixture('lark:oc_b'); const scope = await memoryScope(env);
  const token = await acquire({ kind: 'group', env }, { currentRunId });
  const file = path.join(scope.runDir, 'sync.lock');
  const marker = JSON.parse(fs.readFileSync(file));
  const expiresAt = Date.now() + 30;
  fs.writeFileSync(file, JSON.stringify({ ...marker, startedAt: expiresAt - MARKER_TTL_MS, expiresAt }));
  await guard({ kind: 'group', token, env }, async () => {
    await new Promise(resolve => setTimeout(resolve, 40));
    await assert.rejects(acquire({ kind: 'group', env, waitMs: 80 }, { currentRunId }), { code: 'LOCK_TIMEOUT' });
    assert.equal(JSON.parse(fs.readFileSync(file)).token, token);
  }, { currentRunId });
  const next = await acquire({ kind: 'group', env }, { currentRunId });
  assert.notEqual(next, token);
});

// IB-51/53: each ownership predicate rejects independently; no live tmux read.
test('shared guard checks token, kind and environment runId independently', async () => {
  const env = fixture('origin');
  const scope = await memoryScope(env);
  const token = await acquire({ kind: 'group', env }, { currentRunId });
  const file = path.join(scope.runDir, 'sync.lock');
  const marker = JSON.parse(fs.readFileSync(file));
  for (const changed of [{ token: 'a'.repeat(32) }, { kind: 'origin' }, { runId: 'other-run' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...marker, ...changed }));
    let called = false;
    await assert.rejects(guard({ token, env }, () => { called = true; }), { code: 'TOKEN_MISMATCH' });
    assert.equal(called, false);
  }
  fs.writeFileSync(file, JSON.stringify(marker));
  assert.equal(await guard({ token, env }, ({ marker }) => marker.kind), 'group');
  const origin = await acquire({ kind: 'origin', env }, { currentRunId });
  assert.equal(await guard({ kind: 'auto', token: origin, env }, ({ marker }) => marker.kind), 'origin');
  await assert.rejects(guard({ token: origin, env }, () => assert.fail('origin token entered group write')), { code: 'TOKEN_MISMATCH' });
  // Same run, new token isolates takeover from runId mismatch.
  const next = await acquire({ kind: 'group', env }, { currentRunId, now: () => marker.expiresAt + 1 });
  assert.notEqual(next, token);
  await assert.rejects(guard({ kind: 'group', token, env }, () => assert.fail('old token mutated')), { code: 'TOKEN_MISMATCH' });
});
