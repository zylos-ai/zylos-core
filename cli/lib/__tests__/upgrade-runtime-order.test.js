import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upgradeRuntime } from '../../../skills/upgrade-claude/scripts/upgrade.js';
import { requestRuntimeRestart } from '../request-runtime-restart.js';

test('runtime upgrade completes installation before the shared restart producer selects its mode', async () => {
  for (const [mode, keyPresent, transition] of [
    ['single', false, null], ['multi', true, null],
    ['single', false, { phase: 'gating' }],
  ]) {
    const calls = [];
    const controls = { checkControlId: 7, exitControlId: 8 };
    const result = await upgradeRuntime({
      install: async () => { calls.push('install'); await Promise.resolve(); calls.push('installed'); },
      requestRestart: () => requestRuntimeRestart({
        readMode: () => { calls.push('mode'); return { mode, keyPresent }; }, readTransition: () => transition,
        enqueueExit: () => { calls.push('enqueue'); return controls; },
        send: async () => { calls.push('restart_all'); return { kind: 'accepted', reply: { result: 'accepted' } }; },
      }),
    });
    assert.deepEqual(calls, ['install', 'installed', 'mode', !keyPresent && !transition ? 'enqueue' : 'restart_all']);
    assert.equal(result.ok, true);
    if (!keyPresent && !transition) {
      assert.equal(result.data.result, 'exit_enqueued');
      assert.equal(result.data.checkControlId, controls.checkControlId);
      assert.equal(result.data.exitControlId, controls.exitControlId);
    } else assert.equal(result.data.result, 'accepted');
  }
});

test('failed installation never requests a runtime restart', async () => {
  await assert.rejects(upgradeRuntime({
    install: () => { throw new Error('install failed'); },
    requestRestart: () => assert.fail('failed installation must not restart'),
  }), /install failed/);
});

test('restart refusal or uncertain result is returned without another installation or submission', async () => {
  for (const code of ['manual_restart_pending', 'restart_result_unknown']) {
    let installs = 0, restarts = 0;
    const result = { ok: false, error: { code } };
    assert.equal(await upgradeRuntime({
      install: () => { installs++; }, requestRestart: () => { restarts++; return result; },
    }), result);
    assert.equal(installs, 1); assert.equal(restarts, 1);
  }
});

test('queue failure after installation does not retry installation or restart', async () => {
  let installs = 0, restarts = 0;
  await assert.rejects(upgradeRuntime({
    install: () => { installs++; },
    requestRestart: () => { restarts++; throw new Error('queue unavailable'); },
  }), /queue unavailable/);
  assert.equal(installs, 1); assert.equal(restarts, 1);
});
