import { runtimeAuthFixture } from './helpers/runtime-auth.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateConfigWithLock } from '../config-lock.js';
import { readConfigStrict } from '../config-store.js';
import { executeRuntimeSwitch } from '../../commands/runtime.js';
import { observeRuntimeGroups } from '../config-restart.js';

for (const name of ['CLAUDE.md', 'AGENTS.md']) {
  fs.writeFileSync(path.join(process.env.ZYLOS_DIR, name), 'Legacy fixture instructions\n');
}

function fixture({ target = 'codex', findExecutable, checkAuth, ...overrides } = {}) {
  const calls = [];
  const deps = {
    read: () => { calls.push('read'); return { state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }; },
    mode: () => ({ mode: 'multi' }),
    runtimeFor: id => {
      calls.push('adapter');
      return runtimeAuthFixture(id, {
        findExecutable: findExecutable ?? (() => { calls.push('exists'); return '/fixture/bin/' + id; }),
        auth: { checkAuth: checkAuth ?? (() => { calls.push('auth'); return { status: 'success' }; }) },
      });
    },
    credentials: () => { calls.push('credentials'); return true; },
    hooksReady: () => { calls.push('hooks'); return { ready: true, pendingMigration: false }; },
    write: () => { calls.push('write'); return { previous: { runtime: 'claude' }, config: { runtime: target, session_mode: 'multi' }, changed: true }; },
    observe: async () => { calls.push('observe'); return { groups: [], groupsComplete: true, observationErrors: [] }; },
    ...overrides,
  };
  return { calls, run: flags => executeRuntimeSwitch(target, flags || [], deps) };
}

test('runtime prechecks are ordered and stop before persistence', async () => {
  const success = fixture();
  assert.equal((await success.run()).data.result, 'saved');
  assert.deepEqual(success.calls, ['adapter', 'read', 'exists', 'hooks', 'auth', 'observe', 'write']);
  for (const [override, code, expected] of [
    [{ findExecutable: () => null, prepareCli: () => { assert.fail('always-installed runtime must not run the installer'); } }, 'RUNTIME_NOT_INSTALLED', ['adapter', 'read']],
    [{ read: () => ({ state: 'error' }) }, 'CONFIG_UNREADABLE', ['adapter']],
    [{ hooksReady: () => ({ ready: false, pendingMigration: false }) }, 'RUNTIME_SETUP_INCOMPLETE', ['adapter', 'read', 'exists']],
    [{ checkAuth: () => ({ status: 'uncertain' }) }, 'AUTH_NOT_CONFIRMED', ['adapter', 'read', 'exists', 'hooks']],
  ]) {
    const f = fixture(override); const result = await f.run();
    if (code === 'RUNTIME_NOT_INSTALLED') assert.equal(result.error.message, 'codex CLI missing; run zylos init');
    assert.equal(result.error.code, code); assert.deepEqual(result.error.persisted, []); assert.deepEqual(f.calls, expected);
  }
  const invalid = fixture();
  assert.equal((await invalid.run(['--unknown'])).error.code, 'INVALID_ARGUMENT');
  assert.deepEqual(invalid.calls, ['adapter']);
});

for (const target of ['claude', 'codex', 'agy']) {
  test(`${target} runtime switch distinguishes rejected credentials from uncertain authentication`, async () => {
    const messages = [];
    for (const [status, code] of [['failure', 'AUTH_FAILED'], ['uncertain', 'AUTH_NOT_CONFIRMED'], ['throws', 'AUTH_NOT_CONFIRMED']]) {
      const result = await executeRuntimeSwitch(target, ['--save-apikey', 'fixture-key'], {
        read: () => ({ state: 'ok', config: { runtime: target === 'claude' ? 'codex' : 'claude', session_mode: 'multi' } }),
        runtimeFor: id => runtimeAuthFixture(id, { auth: { checkAuth: () => {
          if (status === 'throws') throw new Error('private probe error');
          return { status };
        } } }), credentials: () => true, hooksReady: () => ({ ready: true }),
        write: () => { assert.fail('must not save runtime after rejected or uncertain auth'); },
        observe: () => { assert.fail('must not observe sessions after failed precheck'); },
      });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, code);
      assert.equal(result.error.authStatus, status === 'failure' ? 'failure' : 'uncertain');
      assert.deepEqual(result.error.persisted, ['apiKey']);
      messages.push(result.error.message);
      if (status === 'failure') {
        assert.match(result.error.message, /credentials rejected or not logged in/);
        assert.ok(result.error.message.includes(target === 'agy'
          ? 'zylos runtime agy --save-apikey <key>' : `zylos auth ${target}`));
      } else {
        assert.match(result.error.message, /check network\/proxy connectivity, then retry/);
        assert.doesNotMatch(result.error.message, /replace credentials|zylos auth|--save-apikey/);
      }
    }
    assert.notEqual(messages[0], messages[1]);
    assert.equal(messages[1], messages[2]);
  });
}

test('default switch submits confirmed runs after saving and reports each refusal independently', async () => {
  const requests = [];
  const f = fixture({
    observe: async (baseline, mode) => observeRuntimeGroups(baseline, mode, {
      list: () => ['chat:a', 'chat:b', 'chat:explicit', 'chat:starting'].map(sessionGroup => ({ sessionGroup })),
      overrides: () => [{ sessionGroup: 'chat:explicit' }],
      identity: sessionGroup => sessionGroup === 'origin' ? { present: false }
        : { present: true, ready: sessionGroup !== 'chat:starting', runId: `run-${sessionGroup}`, runtime: 'claude', launchConfig: { runtime: 'claude', mode: 'default' } },
    }),
    restart: target => {
      assert.ok(f.calls.includes('write'));
      requests.push(target);
      return target.sessionGroup === 'chat:a' ? { status: 'not_restarted', reason: 'fence_conflict' } : { status: 'accepted' };
    },
  });
  const unconfirmed = await f.run();
  assert.equal(unconfirmed.error.code, 'CONFIRMATION_REQUIRED');
  assert.deepEqual(unconfirmed.error.groups, ['chat:a', 'chat:b']);
  assert.equal(f.calls.includes('write'), false);
  const result = await f.run(['--yes']);
  assert.equal(result.data.result, 'saved');
  assert.deepEqual(requests, [{ sessionGroup: 'chat:a', runId: 'run-chat:a' }, { sessionGroup: 'chat:b', runId: 'run-chat:b' }]);
  assert.deepEqual(result.data.groups.map(row => [row.sessionGroup, row.restart?.reason ?? row.restart?.status ?? row.status]), [
    ['chat:a', 'fence_conflict'], ['chat:b', 'accepted'], ['chat:explicit', 'override_kept'], ['chat:starting', 'not_ready'], ['origin', 'not_running'],
  ]);
});

test('real writer preserves concurrent keys and returns the lock-time baseline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-control-runtime-config-'));
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
