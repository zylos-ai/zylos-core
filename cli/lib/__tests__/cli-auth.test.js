import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeAuth } from '../../commands/auth.js';

test('auth rejects invalid arguments and missing CLI without native writes', { timeout: 5000 }, async () => {
  let spawned = false;
  const deps = { exists: () => false, spawn: () => { spawned = true; } };
  for (const [args, code] of [[[], 'INVALID_ARGUMENT'], [['other'], 'RUNTIME_UNSUPPORTED'], [['codex', '--bad'], 'INVALID_ARGUMENT'], [['codex'], 'RUNTIME_NOT_INSTALLED']]) {
    const result = await executeAuth(args, deps);
    assert.equal(result.error.code, code); assert.deepEqual(result.error.persisted, []);
  }
  assert.equal(spawned, false);
});

test('native auth stdio is interactive with stdout reserved; only confirmed auth succeeds', { timeout: 5000 }, async () => {
  for (const runtime of ['claude', 'codex']) {
    for (const status of ['success', 'failure', 'uncertain']) {
      let calls = 0;
      const result = await executeAuth([runtime, '--json'], { exists: () => true,
        spawn: (command, args, options) => {
          calls++; assert.equal(command, runtime); assert.deepEqual(args, runtime === 'claude' ? ['auth', 'login'] : ['login']);
          assert.deepEqual(options.stdio, ['inherit', 2, 2]); return { status: 0 };
        }, adapter: () => ({ checkAuth: async () => ({ status }) }) });
      assert.equal(calls, 1); assert.equal(result.ok, status === 'success');
      if (!result.ok) {
        assert.equal(result.error.persisted, null); assert.equal(result.error.configChanged, false);
        assert.equal(result.error.code, status === 'failure' ? 'AUTH_FAILED' : 'AUTH_NOT_CONFIRMED');
      }
    }
  }
});

test('review P2: Codex device-code option maps to native device auth without changing browser default', { timeout: 5000 }, async () => {
  for (const flags of [[], ['--device-code']]) {
    const result = await executeAuth(['codex', ...flags, '--json'], { exists: () => true,
      spawn: (name, argv) => { assert.equal(name, 'codex'); assert.deepEqual(argv, ['login', ...(flags.length ? ['--device-auth'] : [])]); return { status: 0 }; },
      adapter: () => ({ checkAuth: () => ({ status: 'success' }) }) });
    assert.equal(result.ok, true);
  }
  assert.equal((await executeAuth(['claude', '--device-code'], {
    exists: () => assert.fail('invalid flags must be rejected before CLI lookup'),
    spawn: () => assert.fail('invalid flags must not start native auth'),
    adapter: () => assert.fail('invalid flags must not probe auth'),
  })).error.code, 'INVALID_ARGUMENT');
});

test('native cancellation/failure preserves credential uncertainty and never probes success', { timeout: 5000 }, async () => {
  for (const native of [{ status: 130 }, { signal: 'SIGINT' }, { status: 1 }, { error: new Error('spawn') }]) {
    const result = await executeAuth(['codex'], { exists: () => true, spawn: () => native,
      adapter: () => { throw new Error('must not probe'); } });
    assert.equal(result.ok, false); assert.equal(result.error.persisted, null); assert.equal(result.error.configChanged, false);
    assert.equal(result.error.code, native.signal || native.status === 130 ? 'AUTH_CANCELLED' : 'AUTH_FAILED');
  }
});
