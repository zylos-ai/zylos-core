import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { guardDatabase } from '../sqlite-schema.js';
import * as schema from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';
import { createConfigHandler, classifyConfigRunning, parseConfigArgs } from '../c4-config-handler.js';

function fixture(t, overrides = {}) {
  const db = new Database(':memory:');
  t.after(() => db.close()); guardDatabase(db, schema);
  const store = createStore(db, { validateComponent: () => true, readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }), validateModel: () => true });
  store.insertConversation('in', 'chat', 'e', 'hello', { groupName: 'A' });
  const handler = createConfigHandler({ store, validateComponent: () => true, readSessionMode: () => 'multi', observeRunning: () => ({ hasProcess: false }), ...overrides });
  return { store, db, handler };
}
test('pure CLI parser rejects conflicts, duplicates, excess flags and missing model runtime', () => {
  for (const args of [[], ['get', '--group', 'origin', '--channel', 'chat'], ['get', '--group', 'origin', '--runtime', 'codex'], ['reset', '--group', 'origin', '--model', 'm'], ['get', '--group', 'origin', '--group', 'origin'], ['get', '--group'], ['get', '--session-group', 'A'], ['get', '--group', 'origin', '--json', '--json']]) {
    assert.throws(() => parseConfigArgs('runtime', args), { code: 'INVALID_ARGS' });
  }
  assert.throws(() => parseConfigArgs('model', ['get', '--group', 'origin']), { code: 'INVALID_ARGS' });
  assert.deepEqual(parseConfigArgs('model', ['set', '--channel', 'chat', '--session-group', 'A', '--runtime', 'codex', '--model', 'm', '--effort', 'high', '--json']), { json: true, request: { action: 'set', componentName: 'chat', groupName: 'A', runtime: 'codex', model: 'm', effort: 'high' } });
});
test('selectors only read existing namespaces and groups; exact values and unknown args rejected', t => {
  const { handler, db } = fixture(t);
  const before = db.prepare('SELECT count(*) AS n FROM channel_namespaces').get().n;
  for (const request of [{ action: 'get', componentName: 'absent' }, { action: 'get', componentName: 'chat', groupName: 'B' }]) assert.throws(() => handler('runtime', request), { code: 'SESSION_GROUP_NOT_FOUND' });
  for (const groupName of ['', undefined, null]) assert.throws(() => handler('runtime', { action: 'get', componentName: 'chat', groupName }), { code: 'SESSION_GROUP_INVALID' });
  assert.throws(() => handler('runtime', { action: 'get', sessionGroup: 'chat:A', surprise: true }), { code: 'INVALID_ARGS' });
  assert.throws(() => handler('runtime', { action: 'get', sessionGroup: 'chat:' + 'a'.repeat(96) }), { code: 'SESSION_GROUP_TOO_LONG' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM channel_namespaces').get().n, before);
  const result = handler('runtime', { action: 'set', componentName: 'chat', groupName: 'A', runtime: 'codex' });
  assert.equal(result.data.sessionGroup, 'chat:A'); assert.equal(result.data.running.status, 'not_running');
});
test('explicit group validation preserves invalid-versus-too-long errors before store access', t => {
  const { handler, db } = fixture(t), before = db.prepare('SELECT total_changes() AS n').get().n;
  for (const [sessionGroup, code, message] of [
    ['BAD:' + 'a'.repeat(96), 'SESSION_GROUP_INVALID', 'Invalid namespace'],
    ['chat:' + 'a'.repeat(96), 'SESSION_GROUP_TOO_LONG', /over the 95-char limit/],
    ['chat:', 'SESSION_GROUP_INVALID', /at position 0/],
    ['chat:-bad', 'SESSION_GROUP_INVALID', /at position 0/],
    ['chat:a bad', 'SESSION_GROUP_INVALID', /at position 1/],
    [null, 'SESSION_GROUP_INVALID', 'Invalid session group'],
  ]) assert.throws(() => handler('runtime', { action: 'get', sessionGroup }), { code, message, persisted: [] });
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
});
test('saved changed and desired survive failed F1 or running observation; no fence or model loss', t => {
  for (const overrides of [{ readSessionMode: () => { throw new Error('F1 failed'); } }, { observeRunning: () => { throw new Error('P02 unconnected'); } }]) {
    const { store, handler } = fixture(t, overrides);
    store.setSessionModelConfig({ sessionGroup: 'chat:A', runtime: 'codex', model: 'm', effort: 'high' });
    const request = { action: 'set', sessionGroup: 'chat:A', runtime: 'codex' };
    const first = handler('runtime', request);
    assert.equal(first.ok, true); assert.equal(first.data.changed, true);
    assert.deepEqual(first.data.desired, { mode: 'override', runtime: 'codex' });
    assert.equal(first.data.running.status, 'unknown'); assert.ok(first.data.running.reason);
    assert.equal(handler('runtime', request).data.changed, false);
    assert.equal(handler('runtime', { action: 'reset', sessionGroup: 'chat:A' }).data.changed, true);
    assert.equal(store.getSessionModelConfig({ sessionGroup: 'chat:A', runtime: 'codex' }).mode, 'override');
    assert.equal(store.getDrainFence('chat:A'), null);
  }
});
test('write error remains an error and preserves existing config', t => {
  const { handler, store, db } = fixture(t);
  db.exec("CREATE TRIGGER reject_override BEFORE INSERT ON group_runtime_overrides BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(() => handler('runtime', { action: 'set', sessionGroup: 'chat:A', runtime: 'codex' }), { code: 'CONFIG_STORE_FAILED' });
  assert.deepEqual(store.getSessionRuntimeConfig({ sessionGroup: 'chat:A' }), { mode: 'inherit' });
});
test('four-state priority returns null before sampling single or non-current runtime', () => {
  const resolved = { runtime: 'claude', mode: 'default' };
  const base = { kind: 'model', runtime: 'claude', sessionMode: 'multi', resolved, observation: { hasProcess: true, identityVerified: true, ready: true, runId: 'run1', launchConfig: resolved } };
  const check = (patch, status) => assert.equal(classifyConfigRunning({ ...base, ...patch }).status, status);
  assert.equal(classifyConfigRunning({ ...base, sessionMode: 'single', fence: { reason: 'model_config' } }), null);
  assert.equal(classifyConfigRunning({ ...base, runtime: 'codex', fence: { reason: 'model_config' } }), null);
  check({ fence: { reason: 'model_config' }, observation: { hasProcess: false } }, 'pending');
  check({ observation: { hasProcess: false } }, 'not_running');
  check({ observation: { ...base.observation, identityVerified: false } }, 'unknown');
  check({ observation: { ...base.observation, launchConfig: null } }, 'unknown');
  check({ observation: { ...base.observation, ready: undefined } }, 'unknown');
  check({ observation: { ...base.observation, ready: false } }, 'pending');
  check({ observation: { ...base.observation, launchConfig: { runtime: 'codex', mode: 'default' } } }, 'pending');
  check({}, 'applied');
  check({ kind: 'runtime', runtime: 'codex' }, 'applied');
});
test('postcommit resolution can see later writer without replacing saved desired', t => {
  const { store } = fixture(t);
  const handler = createConfigHandler({ store, validateComponent: () => true,
    readSessionMode: () => { store.setSessionRuntimeConfig({ sessionGroup: 'chat:A', runtime: 'claude' }); return 'multi'; },
    observeRunning: () => ({ hasProcess: false }),
  });
  const result = handler('runtime', { action: 'set', sessionGroup: 'chat:A', runtime: 'codex' });
  assert.equal(result.data.changed, true);
  assert.equal(result.data.desired.runtime, 'codex');
  assert.equal(result.data.resolved.runtime, 'claude');
});
test('model wrapper reads and writes exact pairs, rejects partial replacement', t => {
  const { handler, store } = fixture(t);
  const request = { action: 'set', sessionGroup: 'chat:A', runtime: 'codex', model: 'm', effort: 'high' };
  assert.equal(handler('model', request).data.changed, true);
  assert.equal(handler('model', request).data.changed, false);
  assert.equal(handler('model', request).data.running, null);
  assert.throws(() => handler('model', { ...request, effort: null }), { code: 'MODEL_PAIR_REQUIRED' });
  assert.equal(store.getSessionModelConfig({ sessionGroup: 'chat:A', runtime: 'codex' }).effort, 'high');
});

test('single and non-current model return mode/resolved and skip fence/process sampling', t => {
  for (const sessionMode of ['single', 'multi']) {
    const { store } = fixture(t);
    const originalFence = store.getDrainFence;
    store.getDrainFence = () => { throw new Error('must not read fence'); };
    const handler = createConfigHandler({ store, validateComponent: () => true,
      readSessionMode: () => sessionMode,
      observeRunning: () => { throw new Error('must not sample process'); },
    });
    for (const action of ['get', 'set', 'reset']) {
      const request = { action, sessionGroup: 'chat:A', runtime: 'codex',
        ...(action === 'set' ? { model: 'm', effort: 'high' } : {}) };
      const { data } = handler('model', request);
      assert.equal(data.sessionMode, sessionMode);
      assert.deepEqual(data.resolved, { runtime: 'claude', mode: 'default' });
      assert.equal(data.running, null);
      assert.equal(data.runtime, 'codex');
      assert.ok(data.desired);
    }
    if (sessionMode === 'single') {
      const { data } = handler('runtime', { action: 'get', sessionGroup: 'chat:A' });
      assert.equal(data.sessionMode, 'single');
      assert.deepEqual(data.resolved, { runtime: 'claude', mode: 'default' });
      assert.equal(data.running, null);
    }
    store.getDrainFence = originalFence;
  }
});
test('current model exposes resolved input and all four running statuses at handler boundary', t => {
  const resolved = { runtime: 'claude', mode: 'default' };
  for (const [observation, expected] of [
    [{ hasProcess: false }, 'not_running'],
    [{ hasProcess: true, identityVerified: false }, 'unknown'],
    [{ hasProcess: true, identityVerified: true, ready: false, runId: 'run', launchConfig: resolved }, 'pending'],
    [{ hasProcess: true, identityVerified: true, ready: true, runId: 'run', launchConfig: resolved }, 'applied'],
  ]) {
    const { handler } = fixture(t, { observeRunning: () => observation });
    const { data } = handler('model', { action: 'get', sessionGroup: 'chat:A', runtime: 'claude' });
    assert.equal(data.sessionMode, 'multi');
    assert.deepEqual(data.resolved, resolved);
    assert.equal(data.running.status, expected);
  }
});
