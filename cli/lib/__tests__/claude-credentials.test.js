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
const preserved = Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PATH', ...keys].map(key => [key, process.env[key]]));
const home = path.join(root, 'home'), zylos = path.join(root, 'zylos'), bin = path.join(root, 'bin');
const settingsFile = path.join(home, '.claude', 'settings.json'), envFile = path.join(zylos, '.env');
for (const dir of [home, zylos, bin, path.dirname(settingsFile)]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf "fixture-version\\n"\n', { mode: 0o755 });
process.env.HOME = home;
process.env.ZYLOS_DIR = zylos;
process.env.PATH = bin;
for (const key of keys) delete process.env[key];
console.log('Claude credential isolation: ' + JSON.stringify({ HOME: home, ZYLOS_DIR: zylos,
  PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, settingsFile, envFile }));
const { saveApiKey, saveApiKeyToEnv, saveAuthToken, saveAuthTokenToEnv,
  saveSetupToken, saveSetupTokenToEnv, isValidBaseUrl } = await import('../runtime-setup.js');
const { readEnvFile } = await import('../env.js');
const modes = [
  ['API key', 'ANTHROPIC_API_KEY', saveApiKey, saveApiKeyToEnv],
  ['Bearer token', 'ANTHROPIC_AUTH_TOKEN', saveAuthToken, saveAuthTokenToEnv],
  ['setup token', 'CLAUDE_CODE_OAUTH_TOKEN', saveSetupToken, saveSetupTokenToEnv],
];
const secret = () => randomBytes(24).toString('hex');
const sameSecret = (actual, expected) => assert.equal(actual === expected, true, 'credential value round-trips without being logged');

beforeEach(() => {
  for (const key of keys) delete process.env[key];
  fs.writeFileSync(settingsFile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://relay.example.test', KEEP: 'unchanged' }, permissions: { allow: ['Read'] }, theme: 'dark' }));
  fs.writeFileSync(envFile, '# Other settings\nKEEP=unchanged\nANTHROPIC_BASE_URL=https://relay.example.test\n');
});
after(() => {
  for (const [key, value] of Object.entries(preserved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

for (const [label, selected, save, saveEnv] of modes) {
  test(`${label} replaces competing settings and process credentials without touching unrelated settings`, () => {
    const value = secret(), settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    for (const key of keys) { settings.env[key] = secret(); process.env[key] = secret(); }
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    const beforeEnv = fs.readFileSync(envFile, 'utf8');
    assert.equal(save(value), true);
    const stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.deepEqual(Object.keys(stored.env).filter(key => keys.includes(key)), [selected]);
    sameSecret(stored.env[selected], value);
    assert.deepEqual(keys.filter(key => process.env[key] !== undefined), [selected]);
    sameSecret(process.env[selected], value);
    assert.equal(stored.env.KEEP, 'unchanged');
    assert.equal(stored.env.ANTHROPIC_BASE_URL, 'https://relay.example.test');
    assert.deepEqual(stored.permissions.allow, ['Read']);
    assert.equal(stored.theme, 'dark');
    assert.equal(fs.readFileSync(envFile, 'utf8') === beforeEnv, true, 'pre-template save must not write a partial Zylos env');
  });
  test(`${label} env save removes all duplicate, exported and spaced competing assignments`, () => {
    const value = secret(), unrelated = '# Other settings\nKEEP=unchanged\nANTHROPIC_BASE_URL=https://relay.example.test\n';
    const stale = keys.flatMap(key => [`${key}=${secret()}`, ` export ${key} = ${secret()}`, `\t${key}\t=\t${secret()}\r`, `\u00a0${key}\u00a0=\u00a0${secret()}`, `\u00a0export\u00a0${key}\u00a0=\u00a0${secret()}`]);
    fs.writeFileSync(envFile, unrelated + stale.join('\n'));
    assert.deepEqual(Object.keys(parseDotEnv(fs.readFileSync(envFile))).filter(key => keys.includes(key)), keys, 'dotenv recognizes the seeded Unicode-spaced credential assignments');
    assert.equal(saveEnv(value), true);
    const content = fs.readFileSync(envFile, 'utf8');
    assert.ok(content.includes(unrelated), 'unrelated env entries are preserved');
    const authLines = content.split(/\r?\n/).filter(line => /^[^\S\r\n]*(?:export[^\S\r\n]+)?(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)[^\S\r\n]*=/.test(line));
    assert.equal(authLines.length, 1);
    assert.deepEqual(Object.keys(parseDotEnv(content)).filter(key => keys.includes(key)), [selected]);
    sameSecret(authLines[0], `${selected}=${value}`);
    assert.equal(saveEnv(value), true, 'repeating persistence is safe');
    assert.equal(fs.readFileSync(envFile, 'utf8').split('\n').filter(line => line.startsWith(selected + '=')).length, 1);
  });
  test(`${label} rejects credential line breaks before either settings or env is changed`, () => {
    for (const suffix of ['\nINJECTED=1', '\rINJECTED=1', '\0', '\x1b']) {
      const settingsBefore = fs.readFileSync(settingsFile, 'utf8'), envBefore = fs.readFileSync(envFile, 'utf8');
      assert.equal(save(secret() + suffix), false);
      assert.equal(saveEnv(secret() + suffix), false);
      assert.equal(fs.readFileSync(settingsFile, 'utf8') === settingsBefore, true, 'settings remain unchanged');
      assert.equal(fs.readFileSync(envFile, 'utf8') === envBefore, true, 'env remains unchanged');
    }
  });
}

test('changing from Bearer to API key and setup token leaves one selected method in both stores', () => {
  for (const [, key, save, saveEnv] of [modes[1], modes[0], modes[2], modes[1]]) {
    const value = secret();
    assert.equal(save(value), true); assert.equal(saveEnv(value), true);
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.deepEqual(Object.keys(settings.env).filter(name => keys.includes(name)), [key]);
    sameSecret(settings.env[key], value);
    const authNames = [...fs.readFileSync(envFile, 'utf8').matchAll(/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)=/gm)].map(match => match[1]);
    assert.deepEqual(authNames, [key]);
  }
});

test('printable credentials round-trip through dotenv and native env readers without adding escape bytes', () => {
  const suffixes = ['#fragment', ' space suffix', '$value', '"quoted"', "'quoted'", '\\backslash', '\\n\\r', ' #with space', "'\"both-quotes", "'\"\\all-but-hash"];
  for (const [, key, save, saveEnv] of modes) for (const suffix of suffixes) {
    const value = secret() + suffix;
    assert.equal(save(value), true); assert.equal(saveEnv(value), true);
    sameSecret(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).env[key], value);
    sameSecret(parseDotEnv(fs.readFileSync(envFile))[key], value);
    sameSecret(readEnvFile().get(key), value);
  }
});

test('credentials with no lossless env representation fail before any store is changed', () => {
  for (const [, , save, saveEnv] of modes) {
    const value = secret() + "'\"#unrepresentable";
    const settingsBefore = fs.readFileSync(settingsFile, 'utf8'), envBefore = fs.readFileSync(envFile, 'utf8');
    assert.equal(save(value), false); assert.equal(saveEnv(value), false);
    assert.equal(fs.readFileSync(settingsFile, 'utf8') === settingsBefore, true, 'settings remain unchanged');
    assert.equal(fs.readFileSync(envFile, 'utf8') === envBefore, true, 'env remains unchanged');
  }
});

test('base URL validation accepts HTTP paths and rejects credentials, queries, fragments and other schemes', () => {
  for (const value of ['https://relay.example.test', 'https://relay.example.test/prefix/', 'http://127.0.0.1:12345']) assert.equal(isValidBaseUrl(value), true);
  for (const value of ['https://name:password@relay.example.test', 'https://relay.example.test/?token=value', 'https://relay.example.test/#value', 'file:///tmp/socket', 'not a url']) assert.equal(isValidBaseUrl(value), false);
  for (const control of ['\r', '\n', '\0', '\t', '\x1b', '\x7f']) assert.equal(isValidBaseUrl(`https://relay.example.test/${control}suffix`), false);
});
