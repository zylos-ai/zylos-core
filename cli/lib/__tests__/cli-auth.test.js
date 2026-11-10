import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeAuth, authCommand } from '../../commands/auth.js';

const authenticated = {
  exists: () => true, spawn: () => ({ status: 0 }),
  adapter: () => ({ checkAuth: () => ({ status: 'success' }) }),
  syncRelayTraffic: () => true, relayNotice: () => null,
};

test('Claude subscription login behind a saved relay reports the kept relay with the command to go direct', async () => {
  const notice = 'Still using the relay https://relay.example: ...';
  const claude = await executeAuth(['claude'], { ...authenticated, relayNotice: () => notice, notifyRecovery: () => true });
  assert.deepEqual(claude.data.warnings, [{ code: 'RELAY_BASE_URL_KEPT', message: notice }]);
  const none = await executeAuth(['claude'], { ...authenticated, notifyRecovery: () => true });
  assert.deepEqual(none.data.warnings, []);
  let asked = 0;
  const codex = await executeAuth(['codex'], { ...authenticated, relayNotice: () => { asked++; return notice; }, notifyRecovery: () => true });
  assert.deepEqual(codex.data.warnings, []); assert.equal(asked, 0);
  const lines = [], errors = [], log = console.log, err = console.error;
  console.log = line => lines.push(line); console.error = line => errors.push(line);
  try { await authCommand(['claude'], { ...authenticated, relayNotice: () => notice, notifyRecovery: () => true }); }
  finally { console.log = log; console.error = err; }
  assert.ok(errors.includes(`Warning [RELAY_BASE_URL_KEPT]: ${notice}`));
});

test('confirmed Claude subscription login recomputes the relay traffic setting before notifying', async () => {
  for (const runtime of ['claude', 'codex']) {
    const order = [];
    const result = await executeAuth([runtime], { ...authenticated,
      syncRelayTraffic: state => { order.push(['sync', state]); return true; },
      notifyRecovery: () => { order.push(['notify']); return true; } });
    assert.equal(result.ok, true);
    assert.deepEqual(order, runtime === 'claude' ? [['sync', undefined], ['notify']] : [['notify']]);
  }
  for (const native of [{ status: 1 }, { signal: 'SIGINT' }]) {
    let synced = 0;
    await executeAuth(['claude'], { ...authenticated, spawn: () => native, syncRelayTraffic: () => { synced++; return true; } });
    assert.equal(synced, 0, 'no recompute without a confirmed login');
  }
  let notified = 0;
  const failed = await executeAuth(['claude'], { ...authenticated, syncRelayTraffic: () => false, notifyRecovery: () => { notified++; return true; } });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'CREDENTIAL_SAVE_FAILED');
  assert.equal(notified, 0);
});

test('confirmed native authentication notifies the supervisor for the authenticated runtime', async () => {
  for (const runtime of ['claude', 'codex']) {
    let calls = 0;
    const result = await executeAuth([runtime, '--json'], { ...authenticated,
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

test('notification transport failures never change confirmed authentication success', async () => {
  for (const notifyRecovery of [() => false, () => { throw new Error('socket failure'); }]) {
    const result = await executeAuth(['codex', '--json'], { ...authenticated, notifyRecovery });
    assert.equal(result.ok, true);
    assert.equal(result.data.recoveryNotified, false);
  }
});

test('failed or unconfirmed authentication never sends a recovery notification', async () => {
  for (const native of [{ status: 1 }, { signal: 'SIGINT' }, { status: 130 }, { error: new Error('spawn') }]) {
    let calls = 0;
    const result = await executeAuth(['codex'], { ...authenticated, spawn: () => native,
      notifyRecovery: () => { calls++; return true; } });
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
  }
  for (const status of ['failure', 'uncertain', 'throw']) {
    let calls = 0;
    const result = await executeAuth(['codex'], { ...authenticated,
      adapter: () => ({ checkAuth() { if (status === 'throw') throw new Error('check failed'); return { status }; } }),
      notifyRecovery: () => { calls++; return true; } });
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
  }
});

test('auth output reports notification delivery in text and JSON', async t => {
  const lines = [];
  t.mock.method(console, 'log', value => lines.push(value));
  await authCommand(['codex'], { ...authenticated, notifyRecovery: () => false });
  assert.deepEqual(lines, ['OK: codex authenticated', 'Recovery will resume on the next message or when the cooldown expires.']);
  lines.length = 0;
  await authCommand(['codex'], { ...authenticated, notifyRecovery: () => true });
  assert.deepEqual(lines, ['OK: codex authenticated']);
  lines.length = 0;
  await authCommand(['codex', '--json'], { ...authenticated, notifyRecovery: () => true });
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).data.recoveryNotified, true);
});

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
        }, adapter: () => ({ checkAuth: async () => ({ status }) }), syncRelayTraffic: () => true, relayNotice: () => null });
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
