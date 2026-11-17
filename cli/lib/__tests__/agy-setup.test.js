import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncAgyConfig, agyConfigurationPaths, isAgyConfigReady, hasAgyZylosHooks } from '../agy-setup.js';
import { saveAgyApiKey } from '../runtime-setup.js';
import { ZYLOS_DIR } from '../config.js';
import { applyCredentials, validateRuntimeFlags, parseRuntimeFlags } from '../../commands/runtime.js';
import { executeAuth } from '../../commands/auth.js';
import { prepareInitRuntimeClis, prepareInitRuntimeAssets, runInitAuthentication, validateInitOptions } from '../../commands/init.js';
import { prepareUpgradeRuntimeClis } from '../upgrade-runtime-preparation.js';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-setup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, zylosDir: path.join(home, 'zylos') };
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('Antigravity setup merges user settings, hooks, MCP servers and onboarding state', t => {
  const f = fixture(t), files = agyConfigurationPaths(f.home);
  for (const file of Object.values(files)) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(files.settings, JSON.stringify({ theme: 'dark', statusLine: { stack_with_default: true } }));
  fs.writeFileSync(files.hooks, JSON.stringify({ custom: { Stop: [{ command: './keep.sh' }] } }));
  fs.writeFileSync(files.mcp, JSON.stringify({ mcpServers: { custom: { command: 'keep' } }, custom: true }));
  fs.writeFileSync(files.onboarding, JSON.stringify({ enterpriseOnboardingComplete: false, custom: true }));
  assert.equal(hasAgyZylosHooks(f.home), false);
  assert.equal(syncAgyConfig(f).files.length, 4);
  assert.equal(hasAgyZylosHooks(f.home), true);
  assert.equal(read(files.settings).theme, 'dark');
  assert.equal(read(files.settings).modelProvider, 'gemini');
  assert.equal(read(files.settings).userDataCollectionForceDisabled, true);
  assert.equal(read(files.settings).statusLine.stack_with_default, true);
  const hooks = read(files.hooks);
  assert.equal(hooks.custom.Stop[0].command, './keep.sh');
  for (const event of ['SessionStart', 'PreInvocation', 'Stop']) {
    assert.equal(hooks.zylos[event][0].timeout, 60);
    assert.match(hooks.zylos[event][0].command, new RegExp(`agy-hooks\\.js' ${event}$`));
  }
  assert.equal(read(files.mcp).mcpServers.custom.command, 'keep');
  assert.match(read(files.mcp).mcpServers['zylos-memory'].args[0], /memory-mcp-server\.js$/);
  assert.deepEqual(read(files.onboarding), { enterpriseOnboardingComplete: false, custom: true, consumerOnboardingComplete: true, onboardingComplete: true });
  assert.equal(syncAgyConfig(f).changed, false);
  assert.equal(isAgyConfigReady(f), true);
});

test('Antigravity setup refuses malformed user JSON before any writes', t => {
  const f = fixture(t), files = agyConfigurationPaths(f.home);
  fs.mkdirSync(path.dirname(files.hooks), { recursive: true });
  fs.writeFileSync(files.hooks, 'broken');
  assert.throws(() => syncAgyConfig(f), { code: 'AGY_CONFIG_UNREADABLE' });
  assert.equal(fs.existsSync(files.settings), false);
  assert.equal(fs.readFileSync(files.hooks, 'utf8'), 'broken');
  assert.equal(isAgyConfigReady(f), false);
});

test('Antigravity setup dry run writes no files', t => {
  const f = fixture(t);
  assert.equal(syncAgyConfig({ ...f, dryRun: true }).changed, true);
  assert.equal(fs.existsSync(path.join(f.home, '.gemini')), false);
});

test('Antigravity API key save replaces duplicate dotenv entries and stays private', t => {
  const file = path.join(ZYLOS_DIR, '.env');
  fs.mkdirSync(ZYLOS_DIR, { recursive: true });
  const prior = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const priorKey = process.env.GEMINI_API_KEY;
  t.after(() => { if (prior) fs.writeFileSync(file, prior); else fs.rmSync(file, { force: true }); if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey; });
  fs.writeFileSync(file, 'KEEP=yes\nGEMINI_API_KEY=old\nexport GEMINI_API_KEY = duplicate\n');
  assert.equal(applyCredentials('agy', { apiKey: 'isolated-fake-key' }), true);
  const content = fs.readFileSync(file, 'utf8');
  assert.equal(content.split('\n').filter(line => /^GEMINI_API_KEY=/.test(line)).length, 1);
  assert.match(content, /KEEP=yes/);
  assert.equal(process.env.GEMINI_API_KEY, 'isolated-fake-key');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(saveAgyApiKey('bad\nkey'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
});

test('Antigravity CLI flags allow API keys and reject subscription and base URL modes', () => {
  assert.equal(validateRuntimeFlags('agy', parseRuntimeFlags(['--save-apikey', 'fake'])), null);
  assert.match(validateRuntimeFlags('agy', parseRuntimeFlags(['--save-setup-token', 'fake'])).error, /requires claude/);
  assert.match(validateRuntimeFlags('agy', parseRuntimeFlags(['--save-base-url', 'https://example.com'])).error, /not supported/);
  assert.equal(validateInitOptions({ runtime: 'agy' }), null);
});

test('Antigravity auth checks saved API key without opening native login', async () => {
  let native = 0, notified = 0;
  const result = await executeAuth(['agy'], { exists: () => true, spawn: async () => { native++; }, adapter: () => ({ checkAuth: async () => ({ status: 'success' }) }), notifyRecovery: async () => { notified++; return true; } });
  assert.equal(result.ok, true);
  assert.equal(native, 0);
  assert.equal(notified, 1);
  const failed = await executeAuth(['agy'], { exists: () => true, adapter: () => ({ checkAuth: async () => ({ status: 'failure' }) }) });
  assert.equal(failed.error.code, 'AUTH_FAILED');
  assert.match(failed.error.message, /save-apikey/);
});

test('Antigravity init prepares only explicit runtimes and never installs an unknown package', async () => {
  const missing = await prepareInitRuntimeClis({ runtimes: ['agy'], exists: () => false });
  assert.equal(missing.failed[0].item, 'agy.cli');
  const present = await prepareInitRuntimeClis({ runtimes: ['agy'], exists: () => true });
  assert.deepEqual(present.completed, ['agy.cli']);
  const calls = [];
  const assets = await prepareInitRuntimeAssets({ runtimes: ['agy'], instruction: name => { calls.push(name); return 'instructions'; }, hooks: { agy: () => calls.push('hooks') }, exists: () => true });
  assert.deepEqual(calls, ['agy', 'hooks']);
  assert.equal(assets.failed.length, 0);
  const result = await runInitAuthentication({}, { runtime: 'agy', exists: () => true, agyAuth: async () => ({ status: 'success' }), nativeLogin: () => { throw Error('native login forbidden'); } });
  assert.equal(result.agyAuthenticated, true);
});

test('Antigravity upgrade requires its installed CLI for baseline and overrides', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.zylosDir, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(f.zylosDir, '.zylos/config.json'), JSON.stringify({ runtime: 'agy', session_mode: 'multi' }));
  const result = await prepareUpgradeRuntimeClis({ zylosDir: f.zylosDir }, { exists: () => true, listRuntimeOverrides: () => [{ runtime: 'agy' }] });
  assert.ok(result.completed.includes('agy.cli'));
  await assert.rejects(prepareUpgradeRuntimeClis({ zylosDir: f.zylosDir }, { exists: name => name !== 'agy', listRuntimeOverrides: () => [] }), { code: 'RUNTIME_PREPARATION_INCOMPLETE' });
});
