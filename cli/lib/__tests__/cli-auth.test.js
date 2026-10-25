import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeAuth } from '../../commands/auth.js';

test('IF-47 auth rejects invalid arguments and missing CLI without native writes', async () => {
  let spawned = false;
  const deps = { exists: () => false, spawn: () => { spawned = true; } };
  for (const [args, code] of [[[], 'INVALID_ARGUMENT'], [['other'], 'RUNTIME_UNSUPPORTED'], [['codex', '--bad'], 'INVALID_ARGUMENT'], [['codex'], 'RUNTIME_NOT_INSTALLED']]) {
    const result = await executeAuth(args, deps);
    assert.equal(result.error.code, code); assert.deepEqual(result.error.persisted, []);
  }
  assert.equal(spawned, false);
});

test('IF-47 native auth stdio is interactive with stdout reserved; only confirmed auth succeeds', async () => {
  for (const runtime of ['claude', 'codex']) {
    for (const status of ['success', 'failure', 'uncertain']) {
      let calls = 0;
      const result = await executeAuth([runtime, '--json'], { exists: () => true,
        spawn: (command, args, options) => {
          calls++; assert.equal(command, runtime); assert.deepEqual(args, runtime === 'claude' ? ['auth', 'login'] : ['login']);
          assert.deepEqual(options.stdio, ['inherit', 2, 2]); return { status: 0 };
        }, adapter: () => ({ checkAuth: async () => ({ status }) }) });
      assert.equal(calls, 1); assert.equal(result.ok, status === 'success');
      if (!result.ok) { assert.equal(result.error.persisted, null); assert.equal(result.error.configChanged, false); }
    }
  }
});

test('IF-47 native cancellation/failure preserves credential uncertainty and never probes success', async () => {
  for (const native of [{ status: 130 }, { signal: 'SIGINT' }, { status: 1 }, { error: new Error('spawn') }]) {
    const result = await executeAuth(['codex'], { exists: () => true, spawn: () => native,
      adapter: () => { throw new Error('must not probe'); } });
    assert.equal(result.ok, false); assert.equal(result.error.persisted, null); assert.equal(result.error.configChanged, false);
    assert.equal(result.error.code, native.signal || native.status === 130 ? 'AUTH_CANCELLED' : 'AUTH_FAILED');
  }
});
