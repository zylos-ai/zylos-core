import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseDotEnv } from 'dotenv';

// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC pairs with the Claude endpoint: on behind
// a relay base URL, absent with the official API or after setup-token login.
// Runs only under a fresh HOME/ZYLOS_DIR; no runtime, network, PM2, tmux or database.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-relay-traffic-'));
const flag = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC';
const touched = ['HOME', 'ZYLOS_DIR', flag, 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
const preserved = Object.fromEntries(touched.map(key => [key, process.env[key]]));
const home = path.join(root, 'home'), zylos = path.join(root, 'zylos');
const settingsFile = path.join(home, '.claude', 'settings.json'), envFile = path.join(zylos, '.env');
for (const dir of [home, zylos, path.dirname(settingsFile)]) fs.mkdirSync(dir, { recursive: true });
process.env.HOME = home;
process.env.ZYLOS_DIR = zylos;
for (const key of touched.slice(2)) delete process.env[key];
console.log('Claude relay setting isolation: ' + JSON.stringify({ HOME: home, ZYLOS_DIR: zylos, settingsFile, envFile }));
const { saveClaudeBaseUrl, saveClaudeBaseUrlToSettingsAndEnv } = await import('../runtime-setup.js');
const { applyBaseUrl, applyCredentials } = await import('../../commands/runtime.js');

const state = () => ({
  env: parseDotEnv(fs.readFileSync(envFile))[flag],
  envLines: fs.readFileSync(envFile, 'utf8').split('\n').filter(line => line.includes(flag + '=')).length,
  settings: JSON.parse(fs.readFileSync(settingsFile, 'utf8')).env?.[flag],
  process: process.env[flag],
});
const ON = { env: '1', envLines: 1, settings: '1', process: '1' };
const OFF = { env: undefined, envLines: 0, settings: undefined, process: undefined };

beforeEach(() => {
  for (const key of touched.slice(2)) delete process.env[key];
  fs.writeFileSync(settingsFile, JSON.stringify({ env: { KEEP: 'unchanged' }, theme: 'dark' }));
  fs.writeFileSync(envFile, '# Other settings\nKEEP=unchanged\n');
});
after(() => {
  for (const [key, value] of Object.entries(preserved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('configuring a relay base URL turns the relay traffic setting on in .env, settings and process', () => {
  assert.deepEqual(state(), OFF);
  assert.equal(saveClaudeBaseUrlToSettingsAndEnv('https://relay.example.test/v1'), true);
  assert.deepEqual(state(), ON);
  assert.equal(saveClaudeBaseUrlToSettingsAndEnv('https://relay.example.test/v1'), true, 'saving the same relay again is safe');
  assert.deepEqual(state(), ON);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).theme, 'dark');
});

test('configuring the official base URL removes the relay traffic setting everywhere', () => {
  fs.writeFileSync(settingsFile, JSON.stringify({ env: { KEEP: 'unchanged', [flag]: '1' } }));
  fs.writeFileSync(envFile, `KEEP=unchanged\n${flag}=1\nexport ${flag}=1\n`);
  process.env[flag] = '1';
  assert.equal(saveClaudeBaseUrlToSettingsAndEnv('https://api.anthropic.com'), true);
  assert.deepEqual(state(), OFF);
  assert.equal(parseDotEnv(fs.readFileSync(envFile)).KEEP, 'unchanged');
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).env.KEEP, 'unchanged');
});

test('zylos runtime base URL changes relay, official, relay keep the setting in step', () => {
  for (const [url, expected] of [['https://relay.example.test', ON], ['https://api.anthropic.com/', OFF], ['https://relay-2.example.test/api', ON]]) {
    assert.equal(applyBaseUrl('claude', url), true);
    assert.deepEqual(state(), expected, url);
  }
});

test('the process-only base URL used during init follows relay and official endpoints', () => {
  assert.equal(saveClaudeBaseUrl('https://relay.example.test'), true);
  assert.equal(process.env[flag], '1');
  assert.equal(saveClaudeBaseUrl('https://api.anthropic.com'), true);
  assert.equal(process.env[flag], undefined);
});

test('setup-token login through zylos runtime removes the setting; a relay base URL turns it back on', () => {
  assert.equal(applyBaseUrl('claude', 'https://relay.example.test'), true);
  assert.deepEqual(state(), ON);
  assert.equal(applyCredentials('claude', { setupToken: 'sk-ant-oat01-' + randomBytes(16).toString('hex') }), true);
  assert.deepEqual(state(), OFF);
  assert.equal(applyBaseUrl('claude', 'https://relay.example.test'), true);
  assert.deepEqual(state(), ON);
});
