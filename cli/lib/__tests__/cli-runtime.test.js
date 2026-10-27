import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateConfigWithLock } from '../config-lock.js';
import { readConfigStrict } from '../config-store.js';
import { executeRuntimeSwitch, observeRuntimeGroups, runtimeCommand } from '../../commands/runtime.js';

function fixture(overrides = {}) {
  const calls = [];
  const deps = {
    read: () => { calls.push('read'); return { state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }; },
    mode: () => ({ mode: 'multi' }),
    adapter: () => { calls.push('adapter'); return { checkAuth: async () => { calls.push('auth'); return { status: 'success' }; } }; },
    exists: () => { calls.push('exists'); return true; },
    credentials: () => { calls.push('credentials'); return true; },
    hooksReady: () => { calls.push('hooks'); return { ready: true, pendingMigration: false }; },
    write: () => { calls.push('write'); return { previous: { runtime: 'claude' }, config: { runtime: 'codex', session_mode: 'multi' }, changed: true }; },
    observe: async () => { calls.push('observe'); return { groups: [], groupsComplete: true, observationErrors: [] }; },
    identity: async () => ({ present: false }),
    restart: () => { calls.push('restart'); },
    ...overrides,
  };
  return { calls, run: flags => executeRuntimeSwitch('codex', flags || [], deps) };
}

test('IF-47 runtime prechecks are ordered and stop before persistence', async () => {
  const success = fixture();
  assert.equal((await success.run()).data.result, 'saved');
  assert.deepEqual(success.calls, ['adapter', 'read', 'exists', 'hooks', 'auth', 'write', 'observe']);
  for (const [override, code, expected] of [
    [{ exists: () => false }, 'RUNTIME_NOT_INSTALLED', ['adapter', 'read']],
    [{ read: () => ({ state: 'error' }) }, 'CONFIG_UNREADABLE', ['adapter']],
    [{ hooksReady: () => ({ ready: false, pendingMigration: false }) }, 'HOOKS_NOT_READY', ['adapter', 'read', 'exists']],
    [{ adapter: () => ({ checkAuth: async () => ({ status: 'uncertain' }) }) }, 'AUTH_NOT_CONFIRMED', ['read', 'exists', 'hooks']],
  ]) {
    const f = fixture(override); const result = await f.run();
    assert.equal(result.error.code, code); assert.deepEqual(result.error.persisted, []); assert.deepEqual(f.calls, expected);
  }
  const invalid = fixture();
  assert.equal((await invalid.run(['--unknown'])).error.code, 'INVALID_ARGUMENT');
  assert.deepEqual(invalid.calls, []);
});

test('review JSON: full-path credentials/restart and failed precheck emit exactly the final envelope', async () => {
  const original = console.log, previousExit = process.exitCode;
  const lines = []; console.log = text => lines.push(text);
  try {
    for (const failed of [false, true]) {
      const f = fixture(failed ? { hooksReady: () => ({ ready: false, pendingMigration: false }) } : {
        write: () => ({ previous: { runtime: 'claude' }, config: { runtime: 'codex', session_mode: 'single' }, changed: true }),
        restart: ({ logSuccess }) => { logSuccess('progress must stay suppressed'); },
      });
      const result = await runtimeCommand(['codex', '--save-apikey', 'fixture-key', '--json'], { execute: (_runtime, flags) => f.run(flags) });
      assert.equal(lines.length, 1);
      assert.deepEqual(JSON.parse(lines[0]), result);
      assert.equal(result.ok, !failed);
      assert.ok(f.calls.includes('credentials'));
      lines.length = 0;
    }
  } finally { console.log = original; process.exitCode = previousExit; }
});

test('IF-47 auth failure is rejected by the runtime command with exit code 1', async () => {
  const f = fixture({ adapter: () => ({ checkAuth: async () => ({ status: 'failure' }) }) });
  const original = console.log, previousExit = process.exitCode;
  console.log = () => {};
  try {
    const result = await runtimeCommand(['codex', '--json'], { execute: (_runtime, flags) => f.run(flags) });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'AUTH_NOT_CONFIRMED');
    assert.equal(result.error.authStatus, 'failure'); assert.equal(process.exitCode, 1);
    assert.deepEqual(result.error.persisted, []); assert.deepEqual(f.calls, ['read', 'exists', 'hooks']);
  } finally { console.log = original; process.exitCode = previousExit; }
});

test('IF-47 unchanged skips install/hooks/auth/write/restart; no-validate only skips auth', async () => {
  const same = fixture({ read: () => ({ state: 'ok', config: { runtime: 'codex' } }) });
  assert.equal((await same.run()).data.result, 'unchanged');
  assert.deepEqual(same.calls, ['adapter', 'observe']);
  const f = fixture(); const result = await f.run(['--no-validate']);
  assert.equal(result.ok, true); assert.equal(result.data.warnings[0].code, 'AUTH_CHECK_SKIPPED');
  assert.deepEqual(f.calls, ['adapter', 'read', 'exists', 'hooks', 'write', 'observe']);
});

test('IF-47 persistence errors preserve credentials and after-rename uncertainty', async () => {
  for (const phase of ['before_rename', 'after_rename']) {
    const f = fixture({ write: () => { throw Object.assign(new Error('injected'), { code: 'CONFIG_WRITE_FAILED', phase }); } });
    const result = await f.run(['--save-apikey', 'fixture-key']);
    assert.equal(result.error.phase, phase);
    assert.deepEqual(result.error.persisted, phase === 'after_rename' ? null : ['apiKey']);
    if (phase === 'after_rename') assert.deepEqual(result.error.persistedBeforeConfig, ['apiKey']);
    assert.equal(f.calls.includes('observe'), false);
  }
});

test('IF-47 later credential/hook failures retain only confirmed saved credential items', async () => {
  const partial = fixture({ baseUrl: () => false });
  const result = await partial.run(['--save-apikey', 'fixture-key', '--save-base-url', 'https://example.test/v1']);
  assert.equal(result.error.code, 'CREDENTIAL_SAVE_FAILED'); assert.deepEqual(result.error.persisted, ['apiKey']);
  assert.equal(partial.calls.includes('write'), false);
  const hooks = fixture({ hooksReady: () => ({ ready: false, pendingMigration: false }) });
  const failed = await hooks.run(['--save-apikey', 'fixture-key']);
  assert.equal(failed.error.code, 'HOOKS_NOT_READY'); assert.deepEqual(failed.error.persisted, ['apiKey']);
});

test('IF-47 lock-return snapshot determines previous/config/changed, including concurrent writer', async () => {
  for (const changed of [false, true]) {
    const f = fixture({ write: () => ({ previous: { runtime: changed ? 'claude' : 'codex' }, config: { runtime: 'codex', session_mode: 'single' }, changed }) });
    const result = await f.run(['--save-apikey', 'fixture-key']);
    assert.equal(result.data.result, changed ? 'saved' : 'unchanged');
    assert.equal(result.data.previousBaseline, changed ? 'claude' : 'codex');
    assert.equal(result.data.baseline, 'codex');
    assert.equal(f.calls.includes('restart'), false);
  }
});

test('IF-47 saved result survives single identity read errors without restarting services', async () => {
  const f = fixture({ observe: async () => { throw new Error('unavailable'); },
    write: () => ({ previous: {}, config: { runtime: 'codex' }, changed: true }),
    identity: async () => { throw new Error('unavailable'); },
    restart: () => { throw new Error('unavailable'); } });
  const result = await f.run();
  assert.equal(result.ok, true); assert.equal(result.data.groupsComplete, false);
  assert.equal(result.data.groups[0].status, 'unknown');
  assert.deepEqual(result.data.warnings, []);
  assert.equal(f.calls.includes('restart'), false);
});

test('IF-47 group union uses explicit override priority and preserves unknown identities', async () => {
  const result = await observeRuntimeGroups('codex', 'multi', {
    list: async () => ['a', 'b', 'c', 'd', 'e'].map(sessionGroup => ({ sessionGroup })),
    overrides: async () => [{ sessionGroup: 'b', runtime: 'claude' }],
    identity: async group => group === 'd' ? { present: false } : group === 'e'
      ? { present: true, runtime: 'codex', launchConfig: null }
      : { present: true, runtime: group === 'c' ? 'codex' : 'claude', launchConfig: {} },
  });
  assert.deepEqual(result.groups.map(group => [group.sessionGroup, group.status]), [
    ['a', 'pending_reclaim'], ['b', 'override_kept'], ['c', 'effective'], ['d', 'not_running'], ['e', 'unknown'], ['origin', 'pending_reclaim'],
  ]);
  const failed = await observeRuntimeGroups('codex', 'unreadable', {
    list: async () => { throw new Error('tmux'); }, overrides: async () => { throw new Error('busy'); },
    identity: async () => { throw new Error('reader'); },
  });
  assert.equal(failed.groupsComplete, false); assert.equal(failed.groups[0].status, 'unknown');
  assert.deepEqual(failed.observationErrors.map(error => error.source), ['tmux', 'overrides', 'session']);
});

test('IF-47 real IB-46 writer preserves concurrent keys and returns the lock-time baseline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p06-runtime-config-'));
  const file = path.join(dir, 'config.json');
  const save = update => updateConfigWithLock({ configFile: file, lockFile: `${file}.lock`, update });
  try {
    for (const concurrentRuntime of ['codex', 'claude']) {
      fs.writeFileSync(file, JSON.stringify({ runtime: concurrentRuntime === 'codex' ? 'claude' : 'codex', session_mode: 'multi', keep: 1 }));
      const f = fixture({ read: () => readConfigStrict(file), hooksReady: () => {
        save({ set: { runtime: concurrentRuntime, concurrent: 2 } }); return { ready: true, pendingMigration: false };
      }, write: save });
      const result = await f.run(['--save-apikey', 'fixture-key']);
      assert.equal(result.ok, true); assert.equal(result.data.previousBaseline, concurrentRuntime);
      assert.equal(result.data.result, concurrentRuntime === 'codex' ? 'unchanged' : 'saved');
      assert.deepEqual(readConfigStrict(file).config, { runtime: 'codex', session_mode: 'multi', keep: 1, concurrent: 2 });
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
