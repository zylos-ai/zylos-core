import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { AgyAdapter } from '../agy.js';
import { getSessionAdapter, SUPPORTED_RUNTIMES } from '../index.js';
import { buildRuntimeArgs, launchEnvironment, validateLaunchConfig } from '../session-command.js';
import { readTargetRuntime } from '../session-target.js';
import { modelThreshold, thresholdLimit } from '../../model-rotation-thresholds.js';
import { applyUpgradePrompt } from '../upgrade-context.js';
import { agyConfigurationPaths, isAgyConfigReady } from '../../agy-setup.js';

function probeExecutor({ status = 200, error = null, inspect = () => {} } = {}) {
  return (command, args, options, callback) => {
    const stdin = new PassThrough();
    let input = '';
    stdin.on('data', chunk => { input += chunk; });
    stdin.on('finish', () => {
      inspect({ command, args, options, input });
      callback(error, String(status));
    });
    return { stdin };
  };
}

async function fixture(t, contents = '') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-adapter-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (contents) await fs.writeFile(path.join(root, '.env'), contents);
  // Unit probes must never fall back to a real curl if their transport seam
  // changes. Only explicitly injected executors can make a request here.
  const bin = path.join(root, 'empty-bin');
  await fs.mkdir(bin);
  return { root, env: { HOME: root, PATH: bin } };
}

test('registry selects agy without changing existing runtime selection', () => {
  assert.ok(SUPPORTED_RUNTIMES.includes('agy'));
  assert.ok(getSessionAdapter('agy') instanceof AgyAdapter);
  assert.equal(getSessionAdapter('claude').runtimeId, 'claude');
  assert.equal(getSessionAdapter('codex').runtimeId, 'codex');
});

test('agy launch trusts only its workspace and supplies a startup kick', () => {
  const root = '/isolated root/quote"$';
  const config = { runtime: 'agy', mode: 'default' };
  assert.equal(validateLaunchConfig('agy', config), true);
  const args = buildRuntimeArgs('agy', config, { root });
  assert.equal(args[0], '--dangerously-skip-permissions');
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { modelProvider: 'gemini', trustedWorkspaces: [root] });
  assert.equal(args[args.indexOf('-i') + 1], 'System startup trigger, not a user message. Continue with startup context.');
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.throws(() => validateLaunchConfig('agy', { runtime: 'agy', mode: 'override', model: 'gemini', effort: 'high' }, ' --model MODEL '), { code: 'MODEL_CONFIG_REJECTED' });
});

test('agy upgrade recovery replaces or appends only its kick value', () => {
  const args = buildRuntimeArgs('agy', { runtime: 'agy', mode: 'default' }, { root: '/isolated' });
  const replaced = applyUpgradePrompt(args, 'recovery', args.length - 1);
  assert.deepEqual(replaced.slice(0, -1), args.slice(0, -1));
  assert.equal(replaced.at(-1), 'recovery');
  assert.ok(applyUpgradePrompt(args, 'recovery', args.length - 1, { append: true }).at(-1).endsWith('\n\nrecovery'));
});

for (const clean of [true, false]) test(`agy environment carries API mode through clean=${clean}`, async t => {
  const f = await fixture(t, `ZYLOS_CLEAN_ENV=${clean}\nGEMINI_API_KEY=saved-key\nHTTPS_PROXY=https://saved-proxy.invalid\nAGY_CLI_DISABLE_AUTO_UPDATE=false\n`);
  const inherited = { ...f.env, GEMINI_API_KEY: 'inherited-key', HTTPS_PROXY: 'https://inherited.invalid', AGY_CLI_DISABLE_AUTO_UPDATE: 'false' };
  const env = launchEnvironment(f.root, inherited, { runtime: 'agy' });
  assert.equal(env.GEMINI_API_KEY, 'saved-key');
  assert.equal(env.HTTPS_PROXY, 'https://saved-proxy.invalid');
  assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
  assert.equal(inherited.GEMINI_API_KEY, 'inherited-key');
});

test('agy environment accepts inherited API key and omits an unset proxy', async t => {
  const f = await fixture(t);
  const env = launchEnvironment(f.root, { ...f.env, GEMINI_API_KEY: 'inherited-key' }, { runtime: 'agy' });
  assert.equal(env.GEMINI_API_KEY, 'inherited-key');
  assert.equal(Object.hasOwn(env, 'HTTPS_PROXY'), false);
  await fs.writeFile(path.join(f.root, '.env'), 'GEMINI_API_KEY=\nHTTPS_PROXY=\n');
  const empty = launchEnvironment(f.root, { ...f.env, GEMINI_API_KEY: 'stale', HTTPS_PROXY: 'stale' }, { runtime: 'agy' });
  assert.equal(Object.hasOwn(empty, 'GEMINI_API_KEY'), false);
  assert.equal(Object.hasOwn(empty, 'HTTPS_PROXY'), false);
});

for (const status of [200, 400, 401, 403, 429, 500]) test(`agy auth classifies HTTP ${status} without exposing the credential`, async t => {
  const f = await fixture(t, 'GEMINI_API_KEY=test-secret\n');
  let calls = 0;
  const adapter = new AgyAdapter({ ...f, execFile: probeExecutor({ status, inspect: ({ command, args, options, input }) => {
    calls++;
    assert.equal(command, 'curl');
    assert.equal(args[0], '-q');
    assert.equal(args[args.indexOf('--url') + 1], 'https://generativelanguage.googleapis.com/v1beta/models');
    assert.equal(args[args.indexOf('--header') + 1], '@-');
    assert.equal(args.includes('--location'), false);
    assert.equal(JSON.stringify(args).includes('test-secret'), false);
    assert.equal(input, 'x-goog-api-key: test-secret\n');
    assert.equal(options.timeout, 11_000);
    assert.equal(options.env.GEMINI_API_KEY, 'test-secret');
  } }) });
  const result = await adapter.checkAuth();
  assert.equal(result.status, status === 200 ? 'success' : [400, 401, 403].includes(status) ? 'failure' : 'uncertain');
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
  assert.equal(calls, 1);
});

test('agy auth missing key, network failure and unreadable configuration are bounded and sanitized', async t => {
  const f = await fixture(t);
  let calls = 0;
  const adapter = new AgyAdapter({ ...f, execFile: probeExecutor({ error: new Error('credential: test-secret'), inspect: () => calls++ }) });
  assert.deepEqual(await adapter.checkAuth(), { status: 'failure', reason: 'api_key_missing' });
  assert.equal(calls, 0);
  await fs.writeFile(path.join(f.root, '.env'), 'GEMINI_API_KEY=test-secret\n');
  assert.deepEqual(await adapter.checkAuth(), { status: 'uncertain', reason: 'http_probe_network_error' });
  await fs.rm(path.join(f.root, '.env'));
  await fs.mkdir(path.join(f.root, '.env'));
  assert.deepEqual(await adapter.checkAuth(), { status: 'uncertain', reason: 'environment_unreadable' });
});

test('agy launch refuses a missing API key before creating any tmux resource', async t => {
  const f = await fixture(t);
  const adapter = new AgyAdapter({ ...f, dependencies: { openTmuxConnection: () => assert.fail('No tmux before credential preflight') } });
  await assert.rejects(adapter.launch({}), { code: 'LAUNCH_FAILED', message: 'Antigravity requires GEMINI_API_KEY; account login is not supported' });
  await assert.rejects(fs.stat(path.join(f.root, '.gemini')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.root, 'AGENTS.md')), { code: 'ENOENT' });
});

test('agy group launch prepares its first HOME configuration before touching tmux', async t => {
  const f = await fixture(t, 'GEMINI_API_KEY=test-key\n');
  await fs.writeFile(path.join(f.root, 'AGENTS.md'), '# Shared complete instructions\n');
  const adapter = new AgyAdapter({ ...f, paths: { tmuxNameForGroup: () => 'isolated-agy' }, dependencies: {
    openTmuxConnection: async () => {
      assert.equal(isAgyConfigReady({ home: f.root, zylosDir: f.root }), true);
      const paths = agyConfigurationPaths(f.root);
      const hooks = JSON.parse(await fs.readFile(paths.hooks, 'utf8'));
      assert.ok(hooks.zylos.SessionStart);
      assert.ok(hooks.zylos.PreInvocation);
      assert.ok(hooks.zylos.Stop);
      const mcp = JSON.parse(await fs.readFile(paths.mcp, 'utf8'));
      assert.ok(mcp.mcpServers['zylos-memory']);
      return { close() {} };
    },
    observeSessionTarget: async () => ({ present: true }),
  } });
  // A conflict proves preflight reached tmux only after preparing this new HOME.
  await assert.rejects(adapter.launch({ sessionGroup: 'telegram:agy', runId: 'test-run', sessionMode: 'multi', launchConfig: { runtime: 'agy', mode: 'default' } }), { code: 'NAME_CONFLICT' });
  assert.equal(await fs.readFile(path.join(f.root, 'AGENTS.md'), 'utf8'), '# Shared complete instructions\n');
});

test('agy group launch without a key rejects before setup or tmux', async t => {
  const f = await fixture(t);
  const adapter = new AgyAdapter({ ...f, dependencies: { openTmuxConnection: () => assert.fail('No tmux without a key') } });
  await assert.rejects(adapter.launch({ sessionGroup: 'telegram:agy', runId: 'test-run', sessionMode: 'multi', launchConfig: { runtime: 'agy', mode: 'default' } }), { code: 'LAUNCH_FAILED' });
  for (const file of Object.values(agyConfigurationPaths(f.root))) await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('agy launch rejects malformed configuration before any tmux work', async t => {
  const f = await fixture(t, 'GEMINI_API_KEY=test-key\n');
  const settings = agyConfigurationPaths(f.root).settings;
  await fs.mkdir(path.dirname(settings), { recursive: true });
  await fs.writeFile(settings, '{malformed');
  const adapter = new AgyAdapter({ ...f, dependencies: { openTmuxConnection: () => assert.fail('No tmux with malformed settings') } });
  await assert.rejects(adapter.launch({ sessionGroup: 'telegram:agy' }), { code: 'AGY_CONFIG_UNREADABLE' });
  assert.equal(await fs.readFile(settings, 'utf8'), '{malformed');
});

test('agy auth gives curl the same saved proxy environment as runtime launch', async t => {
  const f = await fixture(t, 'GEMINI_API_KEY=test-secret\nHTTPS_PROXY=http://saved-proxy.invalid:3128\n');
  const env = { ...f.env, HTTPS_PROXY: 'http://inherited-proxy.invalid:8080', https_proxy: 'http://stale-alias.invalid:8080' };
  let calls = 0;
  const adapter = new AgyAdapter({ ...f, env, execFile: probeExecutor({ inspect: ({ options }) => {
    calls++;
    assert.equal(options.env.HTTPS_PROXY, launchEnvironment(f.root, env, { runtime: 'agy' }).HTTPS_PROXY);
    assert.equal(options.env.HTTPS_PROXY, 'http://saved-proxy.invalid:3128');
    assert.equal(options.env.https_proxy, 'http://saved-proxy.invalid:3128');
  } }) });
  assert.equal((await adapter.checkAuth()).status, 'success');
  assert.equal(calls, 1);
});

for (const separator of ['\r', '\n', '\r\n']) test(`agy auth rejects ${JSON.stringify(separator)} key headers before starting a request`, async t => {
  const f = await fixture(t);
  let calls = 0;
  const adapter = new AgyAdapter({ ...f, env: { ...f.env, GEMINI_API_KEY: `key${separator}Injected: value` }, execFile: () => { calls++; } });
  assert.deepEqual(await adapter.checkAuth(), { status: 'uncertain', reason: 'http_probe_network_error' });
  assert.equal(calls, 0);
});

test('agy always uses one guarded bracketed paste even when the caller disables it', async () => {
  const calls = [];
  let file;
  const connection = {
    commandBatch: async commands => {
      file = commands[0][3];
      assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\nthree');
      assert.equal(commands[1][0], 'paste-buffer');
      assert.equal(commands[1].includes('-p'), true);
      calls.push('paste');
    },
    cleanupBuffer: async () => calls.push('cleanup'),
  };
  const adapter = new AgyAdapter({ dependencies: { revalidateSessionTarget: async () => calls.push('guard') } });
  await adapter.sendText({ target: { paneId: '%1' }, connection, text: 'one\ntwo\nthree', bracketedPaste: false });
  assert.deepEqual(calls, ['guard', 'paste', 'cleanup']);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('agy configured identity is accepted without process-tree inference', async () => {
  const config = { runtime: 'agy', mode: 'default' };
  const identity = await readTargetRuntime({ rawF2: { ZYLOS_MODEL_CONFIG: JSON.stringify(config) }, readProcessTree: () => assert.fail('Configured identity needs no process scan') });
  assert.equal(identity.runtime, 'agy');
  assert.deepEqual(identity.launchConfig, config);
});

test('agy rotation uses the one-million-token policy before a usage sample exists', () => {
  assert.equal(thresholdLimit({ runtime: 'agy' }), 40);
  assert.equal(modelThreshold({}, { runtime: 'agy', model: 'gemini' }), 40);
  assert.equal(modelThreshold({ model_rotation_thresholds: { agy: { gemini: 90 } } }, { runtime: 'agy', model: 'gemini' }), 40);
  assert.equal(modelThreshold({ model_rotation_thresholds: { agy: { gemini: 25 } } }, { runtime: 'agy', model: 'gemini' }), 25);
});
