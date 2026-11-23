import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestConfigRestart } from '../../../../cli/lib/config-restart.js';
import { fixture as storeFixture } from './c4-v2-test-helpers.js';
import { createConfigHandler } from '../c4-config-handler.js';

function fixture(t, overrides = {}) {
  const { db, store } = storeFixture(t);
  store.insertConversation('in', 'chat', 'e', 'hello', { groupName: 'A' });
  const handler = createConfigHandler({ store, validateComponent: () => true, readSessionMode: () => 'multi', observeRunning: () => ({ hasProcess: false }), ...overrides });
  return { store, db, handler };
}
test('CLI keeps a running group unchanged until confirmed, then reports a rejected restart after saving', async t => {
  let observation = { hasProcess: true, identityVerified: true, ready: true, runId: 'run-a', launchConfig: { runtime: 'claude', mode: 'default' } };
  const targets = [];
  const { store, handler } = fixture(t, {
    observeRunning: () => observation,
    restart: target => requestConfigRestart(target, async request => {
      targets.push({ sessionGroup: request.sessionGroup, runId: request.expectedRunId });
      assert.equal(store.getSessionRuntimeConfig({ sessionGroup: 'chat:A' }).runtime, 'codex');
      return { kind: 'rejected', sent: true, reply: { reason: 'fence_conflict' } };
    }),
  });
  const set = { action: 'set', sessionGroup: 'chat:A', runtime: 'codex' };
  await assert.rejects(handler('runtime', set), { code: 'CONFIRMATION_REQUIRED', message: /chat:A/, persisted: [] });
  assert.equal(store.getSessionRuntimeConfig({ sessionGroup: 'chat:A' }).mode, 'inherit');
  const sameRuntime = await handler('runtime', { ...set, runtime: 'claude' });
  assert.deepEqual(sameRuntime.data.desired, { mode: 'override', runtime: 'claude' });
  assert.equal(sameRuntime.data.restart, undefined);
  assert.deepEqual(targets, []);
  const { data } = await handler('runtime', { ...set, yes: true });
  assert.deepEqual(data.restart, { status: 'not_restarted', reason: 'fence_conflict' });
  assert.deepEqual(targets, [{ sessionGroup: 'chat:A', runId: 'run-a' }]);
  observation = { ...observation, identityVerified: false };
  const model = { action: 'set', sessionGroup: 'chat:A', runtime: 'codex', model: 'fixture', effort: 'high' };
  const unverified = await handler('model', { ...model, yes: true });
  assert.deepEqual(unverified.data.restart, { status: 'not_restarted', reason: 'identity_unavailable' });
  assert.equal(targets.length, 1, 'unverified identity must never submit a restart');
  const reset = { action: 'reset', sessionGroup: 'chat:A' };
  observation = {};
  await assert.rejects(handler('runtime', reset), { code: 'CONFIRMATION_REQUIRED', message: /Could not verify whether chat:A is running/ });
  assert.equal(store.getSessionRuntimeConfig({ sessionGroup: 'chat:A' }).runtime, 'codex');
  observation = { hasProcess: false };
  const offline = await handler('runtime', reset);
  assert.equal(offline.data.changed, true);
  assert.equal(offline.data.restart, undefined);
  assert.equal(targets.length, 1);
});
test('write error remains an error and preserves existing config', async t => {
  const { handler, store, db } = fixture(t);
  db.exec("CREATE TRIGGER reject_override BEFORE INSERT ON group_runtime_overrides BEGIN SELECT RAISE(ABORT,'fixture'); END");
  await assert.rejects(() => handler('runtime', { action: 'set', sessionGroup: 'chat:A', runtime: 'codex' }), { code: 'CONFIG_STORE_FAILED' });
  assert.deepEqual(store.getSessionRuntimeConfig({ sessionGroup: 'chat:A' }), { mode: 'inherit' });
});
test('model wrapper reads and writes exact pairs, rejects partial replacement', async t => {
  const { handler, store } = fixture(t);
  const request = { action: 'set', sessionGroup: 'chat:A', runtime: 'codex', model: 'm', effort: 'high' };
  assert.equal((await handler('model', request)).data.changed, true);
  assert.equal((await handler('model', request)).data.changed, false);
  assert.equal((await handler('model', request)).data.running, null);
  await assert.rejects(() => handler('model', { ...request, effort: null }), { code: 'MODEL_PAIR_REQUIRED' });
  assert.equal(store.getSessionModelConfig({ sessionGroup: 'chat:A', runtime: 'codex' }).effort, 'high');
});
