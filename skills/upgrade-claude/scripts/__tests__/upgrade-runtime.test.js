import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Calling the real upgrade orchestrator with an installer dependency must not
// inspect unrelated runtime processes or launch a polling delay.
mock.module('child_process', {
  namedExports: {
    execSync: () => assert.fail('upgrade orchestration must not shell out'),
    execFileSync: () => assert.fail('upgrade orchestration must not inspect processes'),
  },
});
mock.module('../../../activity-monitor/scripts/core-modules.js', {
  namedExports: { loadCoreModule: async () => ({}) },
});
mock.module('../../../comm-bridge/scripts/c4-db.js', {
  namedExports: { getModeTransition: () => null },
});
const { upgradeRuntime } = await import('../upgrade.js');

test('single-session orchestration installs and queues without checking runtime processes', async () => {
  const calls = [];
  const result = await upgradeRuntime({
    readMode: () => ({ mode: 'single' }), readTransition: () => null,
    install: () => calls.push('install'),
    enqueue: () => { calls.push('enqueue'); return { checkControlId: 1, exitControlId: 2 }; },
  });
  assert.deepEqual(calls, ['install', 'enqueue']);
  assert.equal(result.data.result, 'exit_enqueued');
});

test('queue failure is reported after one successful installation without retrying', async () => {
  let installed = 0, queued = 0;
  await assert.rejects(upgradeRuntime({
    readMode: () => ({ mode: 'single' }), readTransition: () => null,
    install: () => { installed++; },
    enqueue: () => { queued++; throw new Error('queue unavailable'); },
  }), /queue unavailable/);
  assert.equal(installed, 1);
  assert.equal(queued, 1);
});
