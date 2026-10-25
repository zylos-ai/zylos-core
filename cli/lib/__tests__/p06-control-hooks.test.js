import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enqueueRestartIfNeeded, shouldSyncCodexConfig, syncCodexConfig, desiredClaudeHooks, syncRuntimeHooks } from '../sync-settings-hooks.js';
import { approvePermission } from '../../../skills/activity-monitor/scripts/hook-auth-prompt.js';
import { isCoreCodexHook } from '../codex-hooks.js';

const payload = { hook_event_name: 'PermissionRequest', session_id: 'real-session' };
const env = { ZYLOS_RUN_ID: 'run-1', ZYLOS_MODEL_CONFIG: '{"runtime":"claude"}' };
function authOptions(group = 'origin') {
  const calls = [];
  return { calls, env, readConfig: () => ({ runtime: 'codex', auto_approve_permission: true }),
    scopeReader: async () => ({ sessionGroup: group }),
    identityReader: async () => ({ runtime: 'claude', runId: 'run-1' }),
    exec: (...args) => calls.push(args) };
}

test('P06 2.9: permission approval targets the current Claude run despite a Codex default', async () => {
  const options = authOptions();
  assert.deepEqual(await approvePermission(payload, options), { skipped: false });
  const args = options.calls[0][1];
  for (const [flag, value] of [['--group', 'origin'], ['--target-run', 'run-1'],
    ['--expected-session', 'real-session'], ['--expected-runtime', 'claude'], ['--priority', '0'], ['--available-in', '1']]) {
    assert.equal(args[args.indexOf(flag) + 1], value);
  }
  assert.ok(args.includes('--bypass-state'));
  assert.ok(args.includes('--no-ack-suffix'));
  const single = authOptions(null);
  await approvePermission(payload, single);
  assert.equal(single.calls[0][1].includes('--group'), false);
});

test('P06 2.9: subagents, missing F2, wrong runtime, disabled and malformed policy never enqueue', async () => {
  for (const options of [
    { ...authOptions(), env: {} },
    { ...authOptions(), env: { ...env, ZYLOS_MODEL_CONFIG: '{"runtime":"codex"}' } },
    { ...authOptions(), identityReader: async () => ({ runtime: 'claude', runId: 'replacement' }) },
    { ...authOptions(), readConfig: () => ({ auto_approve_permission: false }) },
  ]) {
    assert.equal((await approvePermission(payload, options)).skipped, true);
    assert.equal(options.calls.length, 0);
  }
  const sub = authOptions();
  assert.equal((await approvePermission({ ...payload, agent_id: 'child' }, sub)).skipped, true);
  assert.equal(sub.calls.length, 0);
  const malformed = { ...authOptions(), readConfig: () => ({ auto_approve_permission: 'true' }) };
  await assert.rejects(approvePermission(payload, malformed), { code: 'CONFIG_UNREADABLE' });
  assert.equal(malformed.calls.length, 0);
});

function restartOptions(config = {}) {
  const calls = [];
  return { calls, readConfig: () => config, readTransition: () => null,
    exec: (...args) => calls.push(args), exists: () => true, log: () => {}, errorLog: () => {} };
}

test('P06 2.10: stable single restart uses require-idle for both default runtimes', async () => {
  for (const runtime of ['claude', 'codex']) {
    const options = restartOptions({ runtime, session_mode: 'single' });
    assert.equal((await enqueueRestartIfNeeded(options)).submitted, true);
    assert.ok(options.calls[0][1].includes('--require-idle'));
    assert.equal(options.calls[0][1].includes('--group'), false);
  }
});

test('P06 2.10: missing P05 dependency, open transition and unreadable config never fall back to exit', async () => {
  for (const options of [restartOptions({ session_mode: 'multi' }),
    { ...restartOptions(), readTransition: () => ({ phase: 'gating' }) },
    restartOptions({ session_mode: 'bad' }),
    { ...restartOptions(), readConfig: () => { throw Object.assign(new Error('unreadable'), { code: 'CONFIG_UNREADABLE' }); } },
    { ...restartOptions(), readTransition: () => { throw new Error('unreadable transition'); } },
  ]) {
    assert.equal((await enqueueRestartIfNeeded(options)).submitted, false);
    assert.equal(options.calls.length, 0);
  }
});

test('P06 2.2: both-runtime preparation is explicit and preserves unrelated hook identity', () => {
  assert.equal(shouldSyncCodexConfig({ cfg: { runtime: 'claude' }, prepareBothRuntimes: true, existsSync: () => false }).shouldSync, true);
  assert.equal(isCoreCodexHook('node /custom/session-start-orchestrator.js', '/instance'), false);
  assert.equal(isCoreCodexHook('node /instance/.claude/skills/activity-monitor/scripts/session-start-orchestrator.js --shard identity', '/instance'), true);
  const desired = desiredClaudeHooks({ zylosDir: '/isolated-instance', existsSync: () => false });
  for (const groups of Object.values(desired)) for (const group of groups) for (const hook of group.hooks) {
    assert.ok(hook.command.startsWith('node /isolated-instance/.claude/'), hook.command);
  }
  const failed = syncCodexConfig({ cfg: { runtime: 'claude' }, prepareBothRuntimes: true,
    projectDir: '/isolated-instance', existsSync: () => false,
    readFileSync: () => 'malformed toml [', log: () => {}, writeConfig: () => false });
  assert.equal(failed.fatal, true);
});

test('P06 2.2/2.11: init hook sync generates both runtime assets idempotently without restart', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p06-hook-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settingsPath = path.join(root, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const userHook = { type: 'command', command: 'node /user/custom-hook.js' };
  fs.writeFileSync(settingsPath, JSON.stringify({ model: 'user-model', hooks: { Stop: [{ hooks: [userHook] }] } }));
  syncRuntimeHooks({ zylosDir: root, stopFailureSupported: true, log: () => {} });
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.model, 'user-model');
  assert.ok(settings.hooks.Stop[0].hooks.some(h => h.command === userHook.command));
  assert.equal(settings.hooks.StopFailure[0].hooks[0].async, false);
  const codexPath = path.join(root, '.codex', 'hooks.json');
  const before = [fs.readFileSync(settingsPath, 'utf8'), fs.readFileSync(codexPath, 'utf8')];
  assert.match(before[1], /session-start-orchestrator\.js --shard c4-conversations/);
  const repeated = syncRuntimeHooks({ zylosDir: root, stopFailureSupported: true, log: () => {} });
  assert.deepEqual(repeated.claude, { added: 0, updated: 0, removed: 0 });
  assert.deepEqual([fs.readFileSync(settingsPath, 'utf8'), fs.readFileSync(codexPath, 'utf8')], before);
  assert.equal(fs.existsSync(path.join(root, 'comm-bridge', 'c4.db')), false);
  assert.equal(fs.existsSync(path.join(root, '.zylos', 'config.json')), false);
});

test('P06 2.11: init hook sync preserves unreadable settings and reports failure before Codex generation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p06-bad-hook-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settingsPath = path.join(root, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  for (const bad of ['{broken', '[]', '{"hooks":[]}']) {
    fs.writeFileSync(settingsPath, bad);
    assert.throws(() => syncRuntimeHooks({ zylosDir: root, stopFailureSupported: false, log: () => {} }), { code: 'SETTINGS_UNREADABLE' });
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), bad);
    assert.equal(fs.existsSync(path.join(root, '.codex', 'hooks.json')), false);
  }
});
