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

// acquisition uses the real reader rather than trusting caller env.
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

// Integration boundary: real kernel locking and marker lifecycle in a temporary
// group root; currentRunId is supplied, so no tmux server or DB is contacted.
// Run for Sync guard/marker changes; skip for unrelated changes. The test removes
// its root after all acquired locks and guarded actions have completed.
test('Sync lifecycle, independent origin marker, stale takeover and old release', async t => {
  const env = fixture('origin');
  t.after(() => fs.rmSync(env.ZYLOS_DIR, { recursive: true, force: true }));
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
  await guard({ kind: 'group', token, env }, () => { mutations++; });
  const newer = { ...env, ZYLOS_RUN_ID: 'run-2' };
  assert.equal(readSyncMarker({ runDir: scope.runDir, kind: 'group', currentRunId: 'run-2' }).stale, true);
  const next = await acquire({ kind: 'group', env: newer }, { currentRunId });
  await assert.rejects(guard({ kind: 'group', token, env }, () => { mutations++; }), { code: 'TOKEN_MISMATCH', exitCode: 3 });
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

// marker expiry permits a later takeover, never revokes a held .
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
  });
  const next = await acquire({ kind: 'group', env }, { currentRunId });
  assert.notEqual(next, token);
});

test('guard reports a missing or malformed token as input and keeps the marker for a retry', async t => {
  const env = fixture('lark:oc_token');
  t.after(() => fs.rmSync(env.ZYLOS_DIR, { recursive: true, force: true }));
  const scope = await memoryScope(env);
  const token = await acquire({ kind: 'group', env }, { currentRunId });
  const file = path.join(scope.runDir, 'sync.lock'), held = fs.readFileSync(file, 'utf8');
  let calls = 0;
  for (const value of [undefined, '', token.toUpperCase(), token.slice(1), `${token}0`, [token]]) {
    await assert.rejects(guard({ kind: 'group', token: value, env }, () => { calls++; }),
      { code: 'INVALID_INPUT', exitCode: 1, message: 'token is required: pass the T printed by sync-lock.js acquire' });
    assert.equal(fs.readFileSync(file, 'utf8'), held);
  }
  await assert.rejects(guard({ kind: 'group', token: 'c'.repeat(32), env }, () => { calls++; }), { code: 'TOKEN_MISMATCH', exitCode: 3 });
  assert.equal(fs.readFileSync(file, 'utf8'), held);
  assert.equal(calls, 0);
  assert.equal(await guard({ kind: 'group', token, env }, ({ marker }) => marker.token), token);
  await release({ kind: 'group', token, env });
});

// Integration boundary: real marker files and the real release CLI in a temporary
// group root; currentRunId is supplied, so no tmux server or DB is contacted. Run
// for release/guard/marker changes; skip otherwise. t.after removes the root.
test('release after TOKEN_MISMATCH leaves the new owner marker; the owner release removes its own', async t => {
  const env = fixture('lark:oc_takeover');
  t.after(() => fs.rmSync(env.ZYLOS_DIR, { recursive: true, force: true }));
  const scope = await memoryScope(env), file = path.join(scope.runDir, 'sync.lock');
  const script = fileURLToPath(new URL('../sync-lock.js', import.meta.url));
  const cli = (args, runtimeEnv) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, ...runtimeEnv }, encoding: 'utf8', timeout: 15000 });
  const a = await acquire({ kind: 'group', env }, { currentRunId });
  const newer = { ...env, ZYLOS_RUN_ID: 'run-2' };
  const b = await acquire({ kind: 'group', env: newer }, { currentRunId });
  const owned = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(owned).token, b);
  await assert.rejects(guard({ kind: 'group', token: a, env }, () => assert.fail('old owner mutated')), { code: 'TOKEN_MISMATCH', exitCode: 3 });
  await release({ kind: 'group', token: a, env });
  assert.equal(fs.readFileSync(file, 'utf8'), owned);
  const viaCli = cli(['release', '--kind', 'group', '--token', a], env);
  assert.equal(viaCli.status, 0, viaCli.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), owned);
  assert.equal(await guard({ kind: 'group', token: b, env: newer }, ({ marker }) => marker.token), b);
  // Control: while the marker is still the caller's, the same release removes it.
  const own = cli(['release', '--kind', 'group', '--token', b], newer);
  assert.equal(own.status, 0, own.stderr);
  assert.equal(fs.existsSync(file), false);
});

// each ownership predicate rejects independently; no live tmux read.
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
  await assert.rejects(guard({ kind: 'auto', token, env: { ...env, ZYLOS_SESSION_GROUP: '../bad' } }, () => assert.fail('invalid binding mutated')), { code: 'SCOPE_UNBOUND' });
  await assert.rejects(guard({ kind: 'auto', token, env: { ZYLOS_DIR: env.ZYLOS_DIR } }, () => assert.fail('unbound scope mutated')), { code: 'SCOPE_UNBOUND' });
  // Same run, new token isolates takeover from runId mismatch.
  const next = await acquire({ kind: 'group', env }, { currentRunId, now: () => marker.expiresAt + 1 });
  assert.notEqual(next, token);
  await assert.rejects(guard({ kind: 'group', token, env }, () => assert.fail('old token mutated')), { code: 'TOKEN_MISMATCH' });
});
