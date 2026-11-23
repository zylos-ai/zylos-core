import { runtimeAuthFixture } from './helpers/runtime-auth.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeAuth } from '../../commands/auth.js';

function authenticated({ afterLogin = () => ({ ok: true, warnings: [] }), checkAuth, findExecutable } = {}) {
  return {
    findRuntime: id => runtimeAuthFixture(id, {
      findExecutable,
      auth: {
        checkAuth: checkAuth ?? (() => ({ status: 'success' })),
        ...(id === 'claude' ? { afterLogin, overrideWarnings: () => [] } : {}),
      },
    }),
    spawn: () => ({ status: 0 }),
  };
}

test('confirmed native authentication notifies the supervisor for the authenticated runtime', async () => {
  for (const runtime of ['claude', 'codex']) {
    let calls = 0;
    const result = await executeAuth([runtime, '--json'], { ...authenticated(),
      notifyRecovery: notifiedRuntime => {
        calls++;
        assert.equal(notifiedRuntime, runtime);
        return true;
      }
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.data.authStatus, 'success');
    assert.equal(result.data.recoveryNotified, true);
  }
});

test('failed or unconfirmed authentication never sends a recovery notification', async () => {
  for (const native of [{ status: 1 }, { signal: 'SIGINT' }, { status: 130 }, { error: new Error('spawn') }]) {
    let calls = 0;
    const result = await executeAuth(['codex'], { ...authenticated(), spawn: () => native,
      notifyRecovery: () => { calls++; return true; } });
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
  }
  for (const status of ['failure', 'uncertain', 'throw']) {
    let calls = 0;
    const result = await executeAuth(['codex'], { ...authenticated({ checkAuth() { if (status === 'throw') throw new Error('check failed'); return { status }; } }),
      notifyRecovery: () => { calls++; return true; } });
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
  }
});
