import { runtimeAuthFixture } from './helpers/runtime-auth.js';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseDotEnv } from 'dotenv';

// Credential persistence is tested only under a fresh HOME/ZYLOS_DIR. No runtime,
// network, PM2, tmux or database is started. Run when auth method/storage changes.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-credentials-'));
const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
const relayFlag = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC';
const preserved = Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PATH', relayFlag, ...keys].map(key => [key, process.env[key]]));
const home = path.join(root, 'home'), zylos = path.join(root, 'zylos'), bin = path.join(root, 'bin');
const settingsFile = path.join(home, '.claude', 'settings.json'), envFile = path.join(zylos, '.env');
for (const dir of [home, zylos, bin, path.dirname(settingsFile)]) fs.mkdirSync(dir, { recursive: true });
for (const name of ['CLAUDE.md', 'AGENTS.md']) {
  fs.writeFileSync(path.join(zylos, name), 'Legacy fixture instructions\n');
}
fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf "fixture-version\\n"\n', { mode: 0o755 });
process.env.HOME = home;
process.env.ZYLOS_DIR = zylos;
process.env.PATH = bin;
for (const key of [...keys, relayFlag]) delete process.env[key];
console.log('Claude credential isolation: ' + JSON.stringify({ HOME: home, ZYLOS_DIR: zylos,
  PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, settingsFile, envFile }));
const { saveApiKey, saveApiKeyToEnv, saveAuthToken, saveAuthTokenToEnv,
  saveSetupToken, saveSetupTokenToEnv,
  saveClaudeBaseUrl, computeRelayTraffic, syncClaudeRelayTraffic } = await import('../runtime/claude/auth.js');
const { getRuntime } = await import('../runtime/index.js');
const claude = await getRuntime('claude');

const { applyBaseUrl, applyCredentials } = await import('../../commands/runtime.js');
const { executeAuth } = await import('../../commands/auth.js');
const { persistInitCredentials } = await import('../../commands/init.js');
const { readEnvFile } = await import('../env.js');
const modes = [
  ['API key', 'ANTHROPIC_API_KEY', saveApiKey, saveApiKeyToEnv],
  ['Bearer token', 'ANTHROPIC_AUTH_TOKEN', saveAuthToken, saveAuthTokenToEnv],
  ['setup token', 'CLAUDE_CODE_OAUTH_TOKEN', saveSetupToken, saveSetupTokenToEnv],
];
const secret = () => randomBytes(24).toString('hex');
const sameSecret = (actual, expected) => assert.equal(actual === expected, true, 'credential value round-trips without being logged');

// A hand-configured settings.json with its own credentials and relay address,
// unusually formatted so any rewrite shows. zylos must never change it.
const SETTINGS_TEXT = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://hand-relay.example.test', ANTHROPIC_API_KEY: 'sk-ant-api03-hand-configured',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-hand-configured', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', KEEP: 'unchanged' }, permissions: { allow: ['Read'] }, theme: 'dark' }, null, 4) + '\n\n';
const settingsUntouched = () => fs.readFileSync(settingsFile, 'utf8') === SETTINGS_TEXT;
beforeEach(() => {
  for (const key of [...keys, relayFlag]) delete process.env[key];
  fs.writeFileSync(settingsFile, SETTINGS_TEXT);
  fs.writeFileSync(envFile, '# Other settings\nKEEP=unchanged\nANTHROPIC_BASE_URL=https://relay.example.test\n');
});
after(() => {
  for (const [key, value] of Object.entries(preserved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

for (const [label, selected, save, saveEnv] of modes) {
  test(`${label} replaces competing process credentials and leaves settings.json byte-identical`, () => {
    const value = secret();
    for (const key of keys) process.env[key] = secret();
    const beforeEnv = fs.readFileSync(envFile, 'utf8');
    assert.equal(save(value), true);
    assert.deepEqual(keys.filter(key => process.env[key] !== undefined), [selected]);
    sameSecret(process.env[selected], value);
    assert.equal(settingsUntouched(), true, 'settings.json, with its own credentials, is not rewritten');
    assert.equal(fs.readFileSync(envFile, 'utf8') === beforeEnv, true, 'pre-template save must not write a partial Zylos env');
  });
  test(`${label} rejects credential line breaks before either settings or env is changed`, () => {
    fs.appendFileSync(envFile, 'export ANTHROPIC_API_KEY: stale-fixture\n');
    for (const suffix of ['\nINJECTED=1', '\rINJECTED=1', '\0', '\x1b']) {
      const settingsBefore = fs.readFileSync(settingsFile, 'utf8'), envBefore = fs.readFileSync(envFile, 'utf8');
      assert.equal(save(secret() + suffix), false);
      assert.equal(saveEnv(secret() + suffix), false);
      assert.equal(fs.readFileSync(settingsFile, 'utf8') === settingsBefore, true, 'settings remain unchanged');
      assert.equal(fs.readFileSync(envFile, 'utf8') === envBefore, true, 'env remains unchanged');
    }
  });
}


const officialUrl = 'https://api.anthropic.com', relayUrl = 'https://relay.example.test';

test('pairing rule: relay or API credential on; setup token or no credential on the official API off', () => {
  for (const [baseUrl, credential, on] of [
    [officialUrl, 'apiKey', true], [officialUrl, 'authToken', true], [undefined, 'apiKey', true],
    [officialUrl, 'setupToken', false], [officialUrl, 'none', false], [undefined, undefined, false],
    ...['apiKey', 'authToken', 'setupToken', 'none'].map(credential => [relayUrl, credential, true]),
  ]) assert.equal(computeRelayTraffic({ baseUrl, credential }), on, `${baseUrl} ${credential}`);
});

// Every Claude save entry point, against an existing settings.json and with none:
// settings.json stays byte-identical, and none is created.
async function saveEverything() {
  const quiet = { log: () => {}, reportError: () => {} };
  assert.equal(saveApiKey('sk-ant-api03-' + secret()), true);
  assert.equal(saveAuthToken('bearer-' + secret()), true);
  assert.equal(saveSetupToken('sk-ant-oat01-' + secret()), true);
  assert.equal(saveClaudeBaseUrl(relayUrl), true);
  assert.equal(applyCredentials(claude, { apiKey: 'sk-ant-api03-' + secret() }), true);
  assert.equal(applyCredentials(claude, { setupToken: 'sk-ant-oat01-' + secret() }), true);
  assert.equal(applyBaseUrl(claude, relayUrl), true);
  assert.equal(applyBaseUrl(claude, officialUrl), true);
  assert.equal(await persistInitCredentials({ claude: { authToken: 'bearer-' + secret(), baseUrl: relayUrl } }, quiet), true);
  assert.equal(await persistInitCredentials({ claude: { apiKey: 'sk-ant-api03-' + secret() } }, quiet), true);
  assert.equal(await persistInitCredentials({ claude: { setupToken: 'sk-ant-oat01-' + secret() } }, quiet), true);
  assert.equal(await persistInitCredentials({ claude: { subscriptionLogin: true, baseUrl: officialUrl } }, quiet), true);
  const auth = await executeAuth(['claude'], { spawn: () => ({ status: 0 }),
    findRuntime: runtimeAuthFixture, notifyRecovery: () => true });
  assert.equal(auth.ok, true);
  assert.equal(syncClaudeRelayTraffic(), true);
}

for (const [what, text] of [['a hand-configured settings.json', SETTINGS_TEXT], ['a settings.json without env', '{"theme":"dark"}']]) {
  test(`every Claude save entry point leaves ${what} byte-identical`, async () => {
    fs.writeFileSync(settingsFile, text);
    await saveEverything();
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), text);
  });
}

test('printable credentials round-trip through dotenv and native env readers without adding escape bytes', () => {
  const suffixes = ['#fragment', ' space suffix', '$value', '"quoted"', "'quoted'", '\\backslash', '\\n\\r', ' #with space', "'\"both-quotes", "'\"\\all-but-hash"];
  for (const [, key, save, saveEnv] of modes) for (const suffix of suffixes) {
    const value = secret() + suffix;
    assert.equal(save(value), true); assert.equal(saveEnv(value), true);
    sameSecret(process.env[key], value);
    sameSecret(parseDotEnv(fs.readFileSync(envFile))[key], value);
    sameSecret(readEnvFile().get(key), value);
  }
});
