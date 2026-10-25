import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

function sockFixture(outcome, lookup = 'unknown') {
  const submits = [], lookups = [];
  return { ...restartOptions({ session_mode: 'multi' }), submits, lookups,
    now: () => 1000, requestId: () => 'upgrade-1000-aabbccddeeff', deadlineAt: 11000,
    loadSockClient: async () => ({
      submit: async (...args) => { submits.push(args); return outcome; },
      validateReply: (request, reply) => reply?.requestId === request.requestId,
      lookupRestartRequest: async (...args) => { lookups.push(args); return lookup; },
    }) };
}

test('IB-40/43 hook consumer uses draft P05 submit names, frozen envelope and accepted results', async () => {
  for (const result of ['accepted', 'already_accepted', 'done_empty']) {
    const runCount = result === 'done_empty' ? 0 : 3;
    const options = sockFixture({ kind: 'accepted', sent: true,
      reply: { requestId: 'upgrade-1000-aabbccddeeff', result, runCount } });
    if (result === 'already_accepted') {
      options.readConfig = () => ({ session_mode: 'single' });
      options.readTransition = () => ({ phase: 'gating' });
    }
    const actual = await enqueueRestartIfNeeded(options);
    assert.deepEqual(actual, { submitted: true, requestId: 'upgrade-1000-aabbccddeeff', result, runCount });
    assert.equal(options.submits.length, 1);
    assert.deepEqual(options.submits[0][0], { version: 1, type: 'restart_all', requestId: 'upgrade-1000-aabbccddeeff', reason: 'upgrade' });
    assert.equal(options.submits[0][1].deadlineAt, 11000);
    assert.equal(options.submits[0][1].replyMaxMs, 10000);
    assert.equal(options.submits[0][1].connectRetryEveryMs, undefined);
    assert.match(options.submits[0][1].socketPath, /activity-monitor\/am\.sock$/);
    assert.equal(options.lookups.length, 0); assert.equal(options.calls.length, 0);
  }
});

test('IB-40/43 definitive rejection and sent:false never look up, resubmit or fall back to exit', async () => {
  for (const code of ['single_mode', 'manual_restart_pending', 'requests_unreadable', 'request_conflict', 'invalid_request', 'entry_not_open']) {
    const options = sockFixture({ kind: 'rejected', sent: true, reply: { requestId: 'upgrade-1000-aabbccddeeff', code } });
    const actual = await enqueueRestartIfNeeded(options);
    assert.equal(actual.submitted, false); assert.equal(actual.code, code);
    assert.deepEqual(actual.persisted, []);
    assert.equal(actual.category, ['manual_restart_pending', 'entry_not_open'].includes(code) ? 'T' : 'R');
    assert.equal(options.lookups.length, 0); assert.equal(options.submits.length, 1); assert.equal(options.calls.length, 0);
  }
  for (const kind of ['connect_failed', 'deadline_exceeded']) {
    const options = sockFixture({ kind, sent: false });
    assert.equal((await enqueueRestartIfNeeded(options)).category, 'T');
    assert.equal(options.lookups.length, 0); assert.equal(options.submits.length, 1); assert.equal(options.calls.length, 0);
  }
});

test('IB-40 single_mode falls back only after fresh stable single reads and keeps require-idle', async () => {
  const rejection = { kind: 'rejected', sent: true, reply: { requestId: 'upgrade-1000-aabbccddeeff', code: 'single_mode' } };
  const options = sockFixture(rejection);
  let reads = 0, transitions = 0;
  options.readConfig = () => ({ session_mode: ++reads === 1 ? 'multi' : 'single' });
  options.readTransition = () => { transitions++; return null; };
  assert.deepEqual(await enqueueRestartIfNeeded(options), { submitted: true });
  assert.equal(reads, 2); assert.equal(transitions, 2);
  assert.equal(options.calls.length, 1);
  assert.deepEqual(options.calls[0][1].slice(1), ['enqueue', '--content', '/exit', '--priority', '1', '--require-idle', '--no-ack-suffix']);
  assert.equal(options.submits.length, 1); assert.equal(options.lookups.length, 0);

  for (const current of ['multi', 'invalid', 'transition', 'config_error', 'transition_error']) {
    const rejected = sockFixture(rejection);
    let configReads = 0, transitionReads = 0;
    rejected.readConfig = () => {
      if (++configReads === 1) return { session_mode: 'multi' };
      if (current === 'config_error') throw new Error('unreadable config');
      return { session_mode: ['multi', 'invalid'].includes(current) ? current : 'single' };
    };
    rejected.readTransition = () => {
      if (++transitionReads === 1) return null;
      if (current === 'transition_error') throw new Error('unreadable transition');
      return current === 'transition' ? { phase: 'gating' } : null;
    };
    assert.equal((await enqueueRestartIfNeeded(rejected)).submitted, false, current);
    assert.equal(rejected.calls.length, 0, current);
    assert.equal(rejected.lookups.length, 0, current);
  }
  const invalid = sockFixture({ ...rejection, reply: { ...rejection.reply, requestId: 'other' } });
  invalid.readConfig = () => ({ session_mode: 'multi' });
  assert.equal((await enqueueRestartIfNeeded(invalid)).category, 'U');
  assert.equal(invalid.calls.length, 0);
});

test('IB-40/43 all uncertain outcomes use one same-deadline lookup and never resubmit', async () => {
  for (const kind of ['no_reply', 'invalid_reply', 'timeout', 'deadline_exceeded']) {
    for (const lookup of ['accepted', 'done', 'unknown', 'deadline_exceeded']) {
      const options = sockFixture({ kind, sent: true }, lookup);
      const actual = await enqueueRestartIfNeeded(options);
      assert.equal(actual.category, 'U'); assert.equal(actual.persisted, null); assert.equal(actual.lookup, lookup);
      assert.equal(actual.submitted, ['accepted', 'done'].includes(lookup) ? true : null);
      assert.deepEqual(options.lookups, [['upgrade-1000-aabbccddeeff', { deadlineAt: 11000 }]]);
      assert.equal(options.submits.length, 1); assert.equal(options.calls.length, 0);
    }
  }
});

test('IB-40/43 bad accepted reply, lookup failure and exhausted budget remain fail closed', async () => {
  const bad = sockFixture({ kind: 'accepted', sent: true, reply: { requestId: 'wrong-request' } });
  assert.equal((await enqueueRestartIfNeeded(bad)).code, 'invalid_reply');
  assert.equal(bad.lookups.length, 1); assert.equal(bad.calls.length, 0);
  const failed = sockFixture();
  failed.loadSockClient = async () => ({ submit: () => { throw Error('unexpected'); }, validateReply: () => false,
    lookupRestartRequest: () => { throw Error('unreadable'); } });
  const actual = await enqueueRestartIfNeeded(failed);
  assert.equal(actual.category, 'U'); assert.equal(actual.lookup, 'unknown'); assert.equal(actual.submitted, null);
  const expired = sockFixture(); expired.deadlineAt = 1000;
  assert.equal((await enqueueRestartIfNeeded(expired)).sent, false);
  assert.equal(expired.submits.length, 0); assert.equal(expired.lookups.length, 0); assert.equal(expired.calls.length, 0);
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

test('P06 review: upgrade refreshes stale Codex hooks with unchanged TOML and dry-run preserves them', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p06-upgrade-hooks-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'zylos');
  fs.mkdirSync(path.join(root, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(root, '.zylos', 'config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'single' }));
  const script = new URL('../sync-settings-hooks.js', import.meta.url);
  const run = (...args) => {
    const result = spawnSync(process.execPath, [script.pathname, ...args], {
      env: { ...process.env, HOME: home, ZYLOS_DIR: root }, encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  run();
  const tomlPaths = [path.join(home, '.codex', 'config.toml'), path.join(root, '.codex', 'config.toml')];
  const beforeToml = tomlPaths.map(file => fs.readFileSync(file, 'utf8'));
  const hooksPath = path.join(root, '.codex', 'hooks.json');
  const userHook = { type: 'command', command: 'node /user/custom-hook.js' };
  const stale = JSON.stringify({ hooks: { SessionStart: [{ hooks: [userHook, {
    type: 'command', command: `node ${root}/.claude/skills/activity-monitor/scripts/session-start-orchestrator.js --shard state`,
  }] }] } });
  fs.writeFileSync(hooksPath, stale);
  run('--dry-run');
  assert.equal(fs.readFileSync(hooksPath, 'utf8'), stale);
  assert.match(run(), /Codex hooks refreshed/);
  assert.deepEqual(tomlPaths.map(file => fs.readFileSync(file, 'utf8')), beforeToml);
  const refreshed = fs.readFileSync(hooksPath, 'utf8');
  assert.doesNotMatch(refreshed, /--shard state/);
  assert.match(refreshed, /--shard c4-conversations/);
  assert.match(refreshed, /\/user\/custom-hook.js/);
  assert.match(run(), /all up to date/);
  assert.equal(fs.readFileSync(hooksPath, 'utf8'), refreshed);
});
