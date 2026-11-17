import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upgradeRuntime } from '../../../skills/upgrade-claude/scripts/upgrade.js';

test('multi and transitioning upgrades install before one supervisor request', async () => {
  for (const [mode, transition] of [['multi', null], ['single', { phase: 'gating' }]]) {
    const calls = [];
    const result = await upgradeRuntime({
      readMode: () => ({ mode }), readTransition: () => transition,
      install: async () => calls.push('install'),
      requestRestart: () => { calls.push('restart'); return { ok: false, error: { code: 'restart_result_unknown' } }; },
      enqueue: () => assert.fail('single-session enqueue must not run'),
    });
    assert.deepEqual(calls, ['install', 'restart']);
    assert.equal(result.error.code, 'restart_result_unknown');
  }
});

test('single-session upgrade waits for installation to finish before queueing its check and exit', async () => {
  const calls = [];
  const controls = { checkControlId: 7, exitControlId: 8 };
  const result = await upgradeRuntime({
    readMode: () => ({ mode: 'single' }), readTransition: () => null,
    install: async () => { calls.push('install'); await Promise.resolve(); calls.push('installed'); },
    enqueue: () => { calls.push('enqueue'); return controls; },
    requestRestart: () => assert.fail('single mode must not contact the supervisor'),
  });
  assert.deepEqual(calls, ['install', 'installed', 'enqueue']);
  assert.equal(result.ok, true);
  assert.equal(result.data.result, 'exit_enqueued');
  assert.equal(result.data.checkControlId, controls.checkControlId);
  assert.equal(result.data.exitControlId, controls.exitControlId);
});

test('failed installation never requests restart or queues exit in either mode', async () => {
  for (const mode of ['single', 'multi']) {
    await assert.rejects(upgradeRuntime({
      readMode: () => ({ mode }), readTransition: () => null,
      install: () => { throw new Error('install failed'); },
      requestRestart: () => assert.fail('failed install must not restart'),
      enqueue: () => assert.fail('failed install must not queue exit'),
    }), /install failed/);
  }
});
