import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upgradeRuntime } from '../../../skills/upgrade-claude/scripts/upgrade.js';
import { requestRuntimeRestart } from '../request-runtime-restart.js';

test('runtime upgrade completes installation before submitting restart_all', async () => {
  const calls = [];
  const result = await upgradeRuntime({
    install: async () => { calls.push('install'); await Promise.resolve(); calls.push('installed'); },
    requestRestart: () => requestRuntimeRestart({
      send: async request => { calls.push(request.type); return { kind: 'accepted', reply: { result: 'done_empty', runCount: 0 } }; },
    }),
  });
  assert.deepEqual(calls, ['install', 'installed', 'restart_all']);
  assert.equal(result.data.result, 'done_empty');
});

test('failed installation never requests a runtime restart', async () => {
  await assert.rejects(upgradeRuntime({
    install: () => { throw new Error('install failed'); },
    requestRestart: () => assert.fail('failed installation must not restart'),
  }), /install failed/);
});
