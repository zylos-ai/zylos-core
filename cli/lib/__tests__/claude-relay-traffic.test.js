import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseDotEnv } from 'dotenv';

// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC pairing rule: on behind a relay base URL
// or with an Anthropic API key; absent for subscription login, setup token or no
// credential on the official API.
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
const { saveClaudeBaseUrl, computeRelayTraffic, relayLoginNotice } = await import('../runtime-setup.js');
const { applyBaseUrl, applyCredentials, parseRuntimeFlags, validateRuntimeFlags, relayNoticeAfterSave } = await import('../../commands/runtime.js');
const { persistInitCredentials, runClaudeSubscriptionLogin } = await import('../../commands/init.js');
const setupToken = () => 'sk-ant-oat01-' + randomBytes(16).toString('hex');

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

const officialUrl = 'https://api.anthropic.com', relayUrl = 'https://relay.example.test';
const apiKey = () => 'sk-ant-api03-' + randomBytes(16).toString('hex');

test('pairing rule: relay or API credential on; subscription, setup token or none on the official API off', () => {
  for (const [baseUrl, credential, on] of [
    [officialUrl, 'apiKey', true], [officialUrl, 'authToken', true], [undefined, 'apiKey', true],
    [officialUrl, 'setupToken', false], [officialUrl, 'subscription', false], [officialUrl, 'none', false], [undefined, undefined, false],
    ...['apiKey', 'authToken', 'setupToken', 'subscription', 'none'].map(credential => [relayUrl, credential, true]),
  ]) assert.equal(computeRelayTraffic({ baseUrl, credential }), on, `${baseUrl} ${credential}`);
});

test('configuring a relay base URL turns the relay traffic setting on in .env, settings and process', () => {
  assert.deepEqual(state(), OFF);
  assert.equal(applyBaseUrl('claude', relayUrl + '/v1'), true);
  assert.deepEqual(state(), ON);
  assert.equal(applyBaseUrl('claude', relayUrl + '/v1'), true, 'saving the same relay again is safe');
  assert.deepEqual(state(), ON);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).theme, 'dark');
});

test('configuring a relay base URL rewrites a wrong or duplicated existing value to a single 1', () => {
  fs.writeFileSync(settingsFile, JSON.stringify({ env: { KEEP: 'unchanged', [flag]: '0' } }));
  fs.writeFileSync(envFile, `KEEP=unchanged\n${flag}=0\nexport ${flag}=1\n`);
  assert.equal(applyBaseUrl('claude', relayUrl), true);
  assert.deepEqual(state(), ON);
  assert.equal(parseDotEnv(fs.readFileSync(envFile)).KEEP, 'unchanged');
});

test('configuring the official base URL without a credential removes the relay traffic setting everywhere', () => {
  fs.writeFileSync(settingsFile, JSON.stringify({ env: { KEEP: 'unchanged', [flag]: '1' } }));
  fs.writeFileSync(envFile, `KEEP=unchanged\n${flag}=1\nexport ${flag}=1\n`);
  process.env[flag] = '1';
  assert.equal(applyBaseUrl('claude', officialUrl), true);
  assert.deepEqual(state(), OFF);
  assert.equal(parseDotEnv(fs.readFileSync(envFile)).KEEP, 'unchanged');
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).env.KEEP, 'unchanged');
});

test('zylos runtime: API key on the official API turns the setting on; setup token turns it off', () => {
  assert.equal(applyBaseUrl('claude', officialUrl), true);
  assert.deepEqual(state(), OFF);
  assert.equal(applyCredentials('claude', { apiKey: apiKey() }), true);
  assert.deepEqual(state(), ON, 'API key + official');
  assert.equal(applyCredentials('claude', { setupToken: setupToken() }), true);
  assert.deepEqual(state(), OFF, 'setup token + official');
});

test('zylos runtime: switching base URL and credential recomputes the setting each time', () => {
  for (const [step, expected] of [
    [() => applyBaseUrl('claude', relayUrl), ON],
    [() => applyCredentials('claude', { setupToken: setupToken() }), ON],
    [() => applyBaseUrl('claude', officialUrl), OFF],
    [() => applyCredentials('claude', { apiKey: apiKey() }), ON],
    [() => applyBaseUrl('claude', 'https://relay-2.example.test/api'), ON],
    [() => applyCredentials('claude', { setupToken: setupToken() }), ON],
    [() => applyBaseUrl('claude', officialUrl + '/'), OFF],
  ]) {
    assert.equal(step(), true);
    assert.deepEqual(state(), expected, step.toString());
  }
});

test('a claude.ai login with a leftover API key counts as subscription when the official URL is saved', t => {
  const loginFile = path.join(home, '.claude', '.credentials.json');
  t.after(() => fs.rmSync(loginFile, { force: true }));
  assert.equal(applyCredentials('claude', { apiKey: apiKey() }), true);
  fs.writeFileSync(loginFile, JSON.stringify({ claudeAiOauth: { refreshToken: 'synthetic-refresh' } }));
  assert.equal(applyBaseUrl('claude', officialUrl), true);
  assert.deepEqual(state(), OFF);
});

test('a login behind a saved relay keeps the relay and gets a notice with the command to go direct', () => {
  assert.equal(applyBaseUrl('claude', relayUrl), true);
  assert.equal(applyCredentials('claude', { setupToken: setupToken() }), true);
  assert.deepEqual(state(), ON, 'the switch follows the kept relay');
  assert.equal(parseDotEnv(fs.readFileSync(envFile)).ANTHROPIC_BASE_URL, relayUrl, 'the relay URL is not removed');
  const notice = relayNoticeAfterSave('claude', { setupToken: 'x' });
  assert.match(notice, /Still using the relay https:\/\/relay\.example\.test/);
  assert.match(notice, /zylos runtime claude --save-base-url https:\/\/api\.anthropic\.com/);
  assert.equal(relayNoticeAfterSave('claude', { setupToken: 'x', baseUrl: relayUrl }), null, 'a base URL in the same command');
  assert.equal(relayNoticeAfterSave('claude', { apiKey: 'x' }), null, 'API key save');
  assert.equal(relayNoticeAfterSave('codex', { setupToken: 'x' }), null);
});

test('`zylos runtime claude --save-base-url https://api.anthropic.com` sets the official URL everywhere and turns the switch off', () => {
  assert.equal(applyBaseUrl('claude', relayUrl), true);
  assert.equal(applyCredentials('claude', { setupToken: setupToken() }), true);
  assert.deepEqual(state(), ON);
  const parsed = parseRuntimeFlags(['--save-base-url', 'https://api.anthropic.com']);
  assert.equal(validateRuntimeFlags('claude', parsed), null);
  assert.equal(applyBaseUrl('claude', parsed.baseUrl), true);
  assert.equal(parseDotEnv(fs.readFileSync(envFile)).ANTHROPIC_BASE_URL, officialUrl);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).env.ANTHROPIC_BASE_URL, officialUrl);
  assert.equal(process.env.ANTHROPIC_BASE_URL, officialUrl);
  assert.deepEqual(state(), OFF);
  assert.equal(relayLoginNotice(), null);
});

test('the process-only base URL used during init follows the pairing rule', () => {
  assert.equal(saveClaudeBaseUrl(relayUrl), true);
  assert.equal(process.env[flag], '1');
  assert.equal(saveClaudeBaseUrl(officialUrl), true);
  assert.equal(process.env[flag], undefined);
  process.env.ANTHROPIC_API_KEY = apiKey();
  assert.equal(saveClaudeBaseUrl(officialUrl), true);
  assert.equal(process.env[flag], '1', 'API key + official');
});

// init: subscription login and setup-token login, then the post-template save step.
const loginStub = authenticated => {
  const launches = [];
  const result = runClaudeSubscriptionLogin({ launch: (cmd, args) => { launches.push([cmd, ...args]); },
    status: () => authenticated, platform: 'linux', log: () => {} });
  assert.deepEqual(launches, [['claude']]);
  return result;
};
// A previous install: the setting on, the given saved base URL and a leftover API key.
const seedPreviousInstall = baseUrl => {
  const saved = baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {};
  fs.writeFileSync(settingsFile, JSON.stringify({ env: { KEEP: 'unchanged', ...saved, [flag]: '1' } }));
  fs.writeFileSync(envFile, `KEEP=unchanged\n${baseUrl ? `ANTHROPIC_BASE_URL=${baseUrl}\n` : ''}ANTHROPIC_API_KEY=${apiKey()}\n${flag}=1\n`);
  process.env[flag] = '1';
};

for (const [where, baseUrl, expected] of [['without a base URL', undefined, OFF], ['on the official API', officialUrl, OFF], ['behind a saved relay', relayUrl, ON]]) {
  test(`init subscription login ${where} leaves the relay traffic setting ${expected === ON ? 'on' : 'off'}, even with a leftover API key`, () => {
    seedPreviousInstall(baseUrl);
    const login = loginStub(true);
    assert.deepEqual(login, { claudeAuthenticated: true, subscriptionLogin: true });
    persistInitCredentials({ subscriptionLogin: login.subscriptionLogin });
    assert.deepEqual(state(), expected);
  });
}

test('init subscription login that does not complete leaves the relay traffic setting alone', () => {
  seedPreviousInstall(officialUrl);
  const login = loginStub(false);
  assert.deepEqual(login, { claudeAuthenticated: false, subscriptionLogin: false });
  persistInitCredentials({ subscriptionLogin: login.subscriptionLogin });
  assert.deepEqual(state(), ON);
});

test('init setup token and API key on the official API: setup token off, API key on, relay in the same run on', () => {
  seedPreviousInstall(officialUrl);
  persistInitCredentials({ setupToken: setupToken() });
  assert.deepEqual(state(), OFF, 'setup token + official');
  persistInitCredentials({ apiKey: apiKey() });
  assert.deepEqual(state(), ON, 'API key + official');
  persistInitCredentials({ setupToken: setupToken() });
  assert.deepEqual(state(), OFF, 'back to setup token');
  persistInitCredentials({ subscriptionLogin: true, claudeBaseUrl: relayUrl });
  assert.deepEqual(state(), ON, 'subscription + relay in the same run');
});

test('init login without a new base URL prints the kept-relay notice; a base URL in the same run suppresses it', () => {
  for (const [values, expected] of [
    [{ setupToken: setupToken() }, true],
    [{ subscriptionLogin: true }, true],
    [{ setupToken: setupToken(), claudeBaseUrl: relayUrl }, false],
    [{ apiKey: apiKey() }, false],
  ]) {
    seedPreviousInstall(relayUrl);
    const lines = [];
    persistInitCredentials(values, { log: line => lines.push(line) });
    const notice = lines.find(line => line.includes(`Still using the relay ${relayUrl}`));
    assert.equal(!!notice, expected, Object.keys(values).join());
    if (expected) assert.match(notice, /zylos runtime claude --save-base-url https:\/\/api\.anthropic\.com/);
  }
  seedPreviousInstall(officialUrl);
  const lines = [];
  persistInitCredentials({ subscriptionLogin: true }, { log: line => lines.push(line) });
  assert.deepEqual(lines, [], 'no notice on the official API');
});
