import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseDotEnv } from 'dotenv';

// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC pairing rule, computed from the saved
// state only: on behind a relay base URL or with an Anthropic API key / Bearer
// token; absent for a setup token or no saved credential (subscription login) on
// the official API. Saved credentials win over a subscription login.
// Only ~/zylos/.env is read and written: a hand-configured ~/.claude/settings.json
// (with its own credential and relay address) must stay byte-identical.
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
const { saveClaudeBaseUrl, computeRelayTraffic, relayLoginNotice, syncClaudeRelayTraffic,
  saveApiKey, saveSetupToken } = await import('../runtime-setup.js');
const { applyBaseUrl, applyCredentials, parseRuntimeFlags, validateRuntimeFlags, relayNoticeAfterSave } = await import('../../commands/runtime.js');
const { persistInitCredentials, runClaudeSubscriptionLogin } = await import('../../commands/init.js');
const setupToken = () => 'sk-ant-oat01-' + randomBytes(16).toString('hex');

// A hand-configured settings.json, unusually formatted so any rewrite shows.
const SETTINGS_TEXT = JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-api03-hand-configured', ANTHROPIC_BASE_URL: 'https://hand-relay.example.test',
  KEEP: 'unchanged' }, theme: 'dark' }, null, 4) + '\n\n';
const state = () => ({
  env: parseDotEnv(fs.readFileSync(envFile))[flag],
  envLines: fs.readFileSync(envFile, 'utf8').split('\n').filter(line => line.includes(flag + '=')).length,
  process: process.env[flag],
  settingsUntouched: fs.readFileSync(settingsFile, 'utf8') === SETTINGS_TEXT,
});
const ON = { env: '1', envLines: 1, process: '1', settingsUntouched: true };
const OFF = { env: undefined, envLines: 0, process: undefined, settingsUntouched: true };

beforeEach(() => {
  for (const key of touched.slice(2)) delete process.env[key];
  fs.writeFileSync(settingsFile, SETTINGS_TEXT);
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

test('pairing rule: relay or API credential on; setup token or no credential on the official API off', () => {
  for (const [baseUrl, credential, on] of [
    [officialUrl, 'apiKey', true], [officialUrl, 'authToken', true], [undefined, 'apiKey', true],
    [officialUrl, 'setupToken', false], [officialUrl, 'none', false], [undefined, undefined, false],
    ...['apiKey', 'authToken', 'setupToken', 'none'].map(credential => [relayUrl, credential, true]),
  ]) assert.equal(computeRelayTraffic({ baseUrl, credential }), on, `${baseUrl} ${credential}`);
});

test('configuring a relay base URL turns the relay traffic setting on in .env and process', () => {
  assert.deepEqual(state(), OFF);
  assert.equal(applyBaseUrl('claude', relayUrl + '/v1'), true);
  assert.deepEqual(state(), ON);
  assert.equal(applyBaseUrl('claude', relayUrl + '/v1'), true, 'saving the same relay again is safe');
  assert.deepEqual(state(), ON);
});

test('configuring a relay base URL rewrites a wrong or duplicated existing value to a single 1', () => {
  fs.writeFileSync(envFile, `KEEP=unchanged\n${flag}=0\nexport ${flag}=1\n`);
  assert.equal(applyBaseUrl('claude', relayUrl), true);
  assert.deepEqual(state(), ON);
  assert.equal(parseDotEnv(fs.readFileSync(envFile)).KEEP, 'unchanged');
});

test('configuring the official base URL without a credential removes the relay traffic setting from .env and process', () => {
  fs.writeFileSync(envFile, `KEEP=unchanged\n${flag}=1\nexport ${flag}=1\n`);
  process.env[flag] = '1';
  assert.equal(applyBaseUrl('claude', officialUrl), true);
  assert.deepEqual(state(), OFF);
  assert.equal(parseDotEnv(fs.readFileSync(envFile)).KEEP, 'unchanged');
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

test('a saved API key wins over a claude.ai login file: --save-apikey then --save-base-url official keeps the setting on', t => {
  const loginFile = path.join(home, '.claude', '.credentials.json');
  t.after(() => fs.rmSync(loginFile, { force: true }));
  fs.writeFileSync(loginFile, JSON.stringify({ claudeAiOauth: { refreshToken: 'synthetic-refresh' } }));
  assert.equal(applyCredentials('claude', { apiKey: apiKey() }), true);
  assert.deepEqual(state(), ON, 'after --save-apikey');
  assert.equal(applyBaseUrl('claude', officialUrl), true);
  assert.deepEqual(state(), ON, 'after --save-base-url https://api.anthropic.com');
  assert.ok(parseDotEnv(fs.readFileSync(envFile)).ANTHROPIC_API_KEY, 'the API key is still saved');
});

test('an API key saved next to a setup token wins (Claude Code precedence): the setting is on', () => {
  assert.equal(applyBaseUrl('claude', officialUrl), true);
  assert.equal(applyCredentials('claude', { setupToken: setupToken() }), true);
  assert.deepEqual(state(), OFF, 'setup token only');
  assert.equal(applyCredentials('claude', { apiKey: apiKey() }), true);
  const saved = parseDotEnv(fs.readFileSync(envFile));
  assert.ok(saved.CLAUDE_CODE_OAUTH_TOKEN && saved.ANTHROPIC_API_KEY, 'both credentials are saved');
  assert.deepEqual(state(), ON);
});

test('a Bearer token saved in .env keeps the setting on with the official base URL', () => {
  fs.writeFileSync(envFile, `KEEP=unchanged\nANTHROPIC_AUTH_TOKEN=${apiKey()}\n`);
  delete process.env[flag];
  assert.equal(applyBaseUrl('claude', officialUrl), true);
  assert.deepEqual(state(), ON);
});

test('the setting ignores settings.json: its API key and relay address do not count when .env has none', () => {
  fs.writeFileSync(envFile, `KEEP=unchanged\n${flag}=1\n`);
  process.env[flag] = '1';
  assert.equal(syncClaudeRelayTraffic(), true);
  assert.deepEqual(state(), OFF, 'settings.json has a relay base URL and an API key, .env has neither');
  assert.equal(applyBaseUrl('claude', officialUrl), true);
  assert.deepEqual(state(), OFF, 'official URL saved, settings.json API key ignored');
});

// Every save entry point, run once against an existing settings.json and once
// with none: settings.json stays byte-identical, and none is created.
const saveEverything = () => {
  assert.equal(saveApiKey(apiKey()), true);
  assert.equal(saveSetupToken(setupToken()), true);
  assert.equal(saveClaudeBaseUrl(relayUrl), true);
  assert.equal(applyCredentials('claude', { apiKey: apiKey() }), true);
  assert.equal(applyCredentials('claude', { setupToken: setupToken() }), true);
  assert.equal(applyBaseUrl('claude', relayUrl), true);
  assert.equal(applyBaseUrl('claude', officialUrl), true);
  persistInitCredentials({ apiKey: apiKey(), claudeBaseUrl: relayUrl });
  persistInitCredentials({ setupToken: setupToken() }, { log: () => {} });
  persistInitCredentials({ subscriptionLogin: true, claudeBaseUrl: officialUrl }, { log: () => {} });
  assert.equal(syncClaudeRelayTraffic(), true);
};

for (const [what, text] of [['a hand-configured settings.json', SETTINGS_TEXT], ['a settings.json without env', '{"theme":"dark"}']]) {
  test(`every Claude save entry point leaves ${what} byte-identical`, () => {
    fs.writeFileSync(settingsFile, text);
    saveEverything();
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), text);
  });
}

test('no Claude save entry point creates settings.json', () => {
  fs.rmSync(settingsFile);
  saveEverything();
  assert.equal(fs.existsSync(settingsFile), false);
  fs.writeFileSync(settingsFile, SETTINGS_TEXT);
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

test('`zylos runtime claude --save-base-url https://api.anthropic.com` sets the official URL in .env and the process and turns the switch off', () => {
  assert.equal(applyBaseUrl('claude', relayUrl), true);
  assert.equal(applyCredentials('claude', { setupToken: setupToken() }), true);
  assert.deepEqual(state(), ON);
  const parsed = parseRuntimeFlags(['--save-base-url', 'https://api.anthropic.com']);
  assert.equal(validateRuntimeFlags('claude', parsed), null);
  assert.equal(applyBaseUrl('claude', parsed.baseUrl), true);
  assert.equal(parseDotEnv(fs.readFileSync(envFile)).ANTHROPIC_BASE_URL, officialUrl);
  assert.equal(process.env.ANTHROPIC_BASE_URL, officialUrl);
  assert.deepEqual(state(), OFF, 'switch off; settings.json, with its own relay address, untouched');
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
// A previous install: the setting on, the given saved base URL and, unless
// leftoverKey is false, an API key still saved in .env.
const seedPreviousInstall = (baseUrl, { leftoverKey = true } = {}) => {
  fs.writeFileSync(envFile, `KEEP=unchanged\n${baseUrl ? `ANTHROPIC_BASE_URL=${baseUrl}\n` : ''}${leftoverKey ? `ANTHROPIC_API_KEY=${apiKey()}\n` : ''}${flag}=1\n`);
  process.env[flag] = '1';
};

for (const [where, baseUrl, leftoverKey, expected] of [
  ['without a base URL, with a leftover API key', undefined, true, ON],
  ['on the official API, with a leftover API key', officialUrl, true, ON],
  ['behind a saved relay, with a leftover API key', relayUrl, true, ON],
  ['without a base URL or saved credential', undefined, false, OFF],
  ['on the official API without a saved credential', officialUrl, false, OFF],
  ['behind a saved relay without a saved credential', relayUrl, false, ON],
]) {
  test(`init subscription login ${where} leaves the relay traffic setting ${expected === ON ? 'on' : 'off'}`, () => {
    seedPreviousInstall(baseUrl, { leftoverKey });
    const login = loginStub(true);
    assert.deepEqual(login, { claudeAuthenticated: true, subscriptionLogin: true });
    persistInitCredentials({ subscriptionLogin: login.subscriptionLogin });
    assert.deepEqual(state(), expected);
  });
}

test('init subscription login that does not complete leaves the relay traffic setting alone', () => {
  seedPreviousInstall(officialUrl, { leftoverKey: false });
  const login = loginStub(false);
  assert.deepEqual(login, { claudeAuthenticated: false, subscriptionLogin: false });
  persistInitCredentials({ subscriptionLogin: login.subscriptionLogin });
  assert.deepEqual(state(), ON);
});

test('init saving only a base URL recomputes the setting (relay on, then official off)', () => {
  seedPreviousInstall(undefined, { leftoverKey: false });
  fs.writeFileSync(envFile, 'KEEP=unchanged\n');
  delete process.env[flag];
  persistInitCredentials({ claudeBaseUrl: relayUrl });
  assert.deepEqual(state(), ON, 'zylos init --base-url <relay> on a logged-in machine');
  persistInitCredentials({ claudeBaseUrl: officialUrl });
  assert.deepEqual(state(), OFF);
});

test('init setup token and API key on the official API: setup token off, API key on, relay in the same run on', () => {
  seedPreviousInstall(officialUrl, { leftoverKey: false });
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
