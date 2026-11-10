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
const { applyBaseUrl, applyCredentials, parseRuntimeFlags, validateRuntimeFlags, relayNoticeAfterSave,
  settingsOverrideAfterSave } = await import('../../commands/runtime.js');
const { persistInitCredentials, runClaudeSubscriptionLogin, verifySetupToken } = await import('../../commands/init.js');
const setupToken = () => 'sk-ant-oat01-' + randomBytes(16).toString('hex');

// A hand-configured settings.json, unusually formatted so any rewrite shows.
const SETTINGS_TEXT = JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-api03-hand-configured', ANTHROPIC_BASE_URL: 'https://hand-relay.example.test',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', KEEP: 'unchanged' }, theme: 'dark' }, null, 4) + '\n\n';
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

// .env lines are read with dotenv, so `export KEY=` sets KEY: a save must
// rewrite that line too, leaving exactly one line for the key.
const keyLines = key => fs.readFileSync(envFile, 'utf8').split('\n').filter(line => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(line));

test('saving a base URL over `export ANTHROPIC_BASE_URL=` leaves one line with the new value', () => {
  fs.writeFileSync(envFile, 'export ANTHROPIC_BASE_URL=https://old-relay.example.test\nKEEP=unchanged\n');
  assert.equal(applyBaseUrl('claude', relayUrl), true);
  assert.deepEqual(keyLines('ANTHROPIC_BASE_URL'), [`ANTHROPIC_BASE_URL=${relayUrl}`]);
  const env = parseDotEnv(fs.readFileSync(envFile));
  assert.equal(env.ANTHROPIC_BASE_URL, relayUrl);
  assert.equal(env.KEEP, 'unchanged', 'the line after the rewritten one is intact');
});

test('saving an API key over an export-prefixed and a bare line leaves one line with the new key', () => {
  const key = apiKey();
  fs.writeFileSync(envFile, '  export ANTHROPIC_API_KEY=sk-ant-api03-old-exported\nKEEP=unchanged\nANTHROPIC_API_KEY=sk-ant-api03-old-bare\n');
  assert.equal(applyCredentials('claude', { apiKey: key }), true);
  assert.deepEqual(keyLines('ANTHROPIC_API_KEY'), [`ANTHROPIC_API_KEY=${key}`]);
  const env = parseDotEnv(fs.readFileSync(envFile));
  assert.equal(env.ANTHROPIC_API_KEY, key);
  assert.equal(env.KEEP, 'unchanged', 'the line after the rewritten one is intact');
});

test('saving a setup token removes every API key line, bare and export-prefixed', () => {
  const token = setupToken();
  fs.writeFileSync(envFile, 'ANTHROPIC_API_KEY=sk-ant-api03-old-bare\nKEEP=unchanged\nexport ANTHROPIC_API_KEY=sk-ant-api03-old-exported\n');
  applyCredentials('claude', { setupToken: token });
  const env = parseDotEnv(fs.readFileSync(envFile));
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, token);
  assert.equal(env.KEEP, 'unchanged');
});

test('saving a setup token removes an API key written as `ANTHROPIC_API_KEY: value`', () => {
  const token = setupToken();
  fs.writeFileSync(envFile, 'KEEP=unchanged\nANTHROPIC_API_KEY: sk-ant-api03-old-colon\n');
  assert.equal(parseDotEnv(fs.readFileSync(envFile)).ANTHROPIC_API_KEY, 'sk-ant-api03-old-colon', 'dotenv reads the colon form');
  applyCredentials('claude', { setupToken: token });
  const env = parseDotEnv(fs.readFileSync(envFile));
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, token);
  assert.equal(env.KEEP, 'unchanged');
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
  assert.equal(lines.some(line => line.includes('Still using the relay')), false, 'no kept-relay notice on the official API');
});

// settings.json override warning: after a Claude save, zylos reads (never writes)
// ~/.claude/settings.json and names the built-in keys whose value there would
// override what it just saved to .env. Key names only, never values; one warning
// per command run; nothing for a missing, env-less or unparseable file.
const overrideKeys = message => {
  assert.ok(message, 'a warning is expected');
  assert.ok(message.includes(settingsFile), 'the warning names the settings.json path');
  assert.match(message, /Claude Code uses those values instead of the ones zylos gives it/);
  assert.match(message, /remove th(?:at key|ose keys) from .* by hand/);
  return message.match(/ sets (.+) in its env block/)[1].split(', ');
};
// No 8-character slice of any secret may appear in the output.
const leaksNothing = (output, ...secrets) => {
  for (const secret of secrets) for (let i = 0; i + 8 <= secret.length; i++) {
    if (output.includes(secret.slice(i, i + 8))) assert.fail(`output contains part of a secret (offset ${i})`);
  }
};
const writeSettings = (text, mode = 0o644) => { fs.writeFileSync(settingsFile, text); fs.chmodSync(settingsFile, mode); return text; };
const settingsUnchanged = (text, mode = 0o644) => {
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), text, 'settings.json is byte-identical');
  assert.equal(fs.statSync(settingsFile).mode & 0o777, mode, 'settings.json mode is unchanged');
};
const handSecret = () => 'sk-ant-api03-hand-' + randomBytes(16).toString('hex');

test('zylos runtime --save-apikey: a different settings.json API key is named, without either value', () => {
  const hand = handSecret(), saved = apiKey();
  const text = writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: hand, KEEP: 'x' } }));
  assert.equal(applyCredentials('claude', { apiKey: saved }), true);
  const message = settingsOverrideAfterSave('claude', { apiKey: saved });
  assert.deepEqual(overrideKeys(message), ['ANTHROPIC_API_KEY']);
  leaksNothing(message, hand, saved);
  settingsUnchanged(text);
});

test('zylos runtime --save-setup-token: settings.json credentials zylos does not set are named', () => {
  const hand = handSecret(), oldToken = setupToken(), saved = setupToken();
  const text = writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: hand, CLAUDE_CODE_OAUTH_TOKEN: oldToken } }));
  assert.equal(applyCredentials('claude', { setupToken: saved }), true);
  const message = settingsOverrideAfterSave('claude', { setupToken: saved });
  assert.deepEqual(overrideKeys(message), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  leaksNothing(message, hand, oldToken, saved);
  settingsUnchanged(text);
});

test('zylos runtime --save-base-url: a different settings.json relay address and switch are named', () => {
  const text = writeSettings(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://hand-relay.example.test', [flag]: '0' } }));
  assert.equal(applyBaseUrl('claude', relayUrl), true);
  assert.equal(parseDotEnv(fs.readFileSync(envFile))[flag], '1', 'zylos turned the switch on');
  assert.deepEqual(overrideKeys(settingsOverrideAfterSave('claude', { baseUrl: relayUrl })), ['ANTHROPIC_BASE_URL', flag]);
  settingsUnchanged(text);
});

test('going direct while settings.json keeps a relay and the switch on: both are named', () => {
  assert.equal(applyCredentials('claude', { setupToken: setupToken() }), true);
  const text = writeSettings(JSON.stringify({ env: { ANTHROPIC_BASE_URL: relayUrl, [flag]: '1' } }));
  const parsed = parseRuntimeFlags(['--save-base-url', officialUrl]);
  assert.equal(applyBaseUrl('claude', parsed.baseUrl), true);
  assert.equal(parseDotEnv(fs.readFileSync(envFile))[flag], undefined, 'zylos turned the switch off');
  assert.deepEqual(overrideKeys(settingsOverrideAfterSave('claude', parsed)), ['ANTHROPIC_BASE_URL', flag]);
  settingsUnchanged(text);
});

test('the switch alone: left on in settings.json while zylos turns it off is named; equal is not', () => {
  const text = writeSettings(JSON.stringify({ env: { [flag]: '1' } }));
  assert.equal(applyBaseUrl('claude', officialUrl), true);
  assert.equal(parseDotEnv(fs.readFileSync(envFile))[flag], undefined);
  assert.deepEqual(overrideKeys(settingsOverrideAfterSave('claude', { baseUrl: officialUrl })), [flag]);
  assert.equal(applyBaseUrl('claude', relayUrl), true);
  assert.equal(settingsOverrideAfterSave('claude', { baseUrl: relayUrl }), null, 'zylos turned it on: same value');
  settingsUnchanged(text);
});

test('init persistence warns once, on the init warning stream, naming every overriding key', () => {
  const hand = handSecret(), saved = apiKey();
  const text = writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: hand, ANTHROPIC_BASE_URL: 'https://hand-relay.example.test', [flag]: '1' } }), 0o600);
  for (const values of [{ apiKey: saved, claudeBaseUrl: relayUrl }, { setupToken: setupToken() }, { subscriptionLogin: true, claudeBaseUrl: officialUrl }]) {
    const lines = [];
    persistInitCredentials(values, { log: line => lines.push(line) });
    const warnings = lines.filter(line => line.includes('settings.json'));
    assert.equal(warnings.length, 1, `one warning per run: ${Object.keys(values).join()}`);
    assert.ok(warnings[0].includes('⚠'), 'printed as an init warning');
    assert.ok(overrideKeys(warnings[0]).length > 0);
    leaksNothing(lines.join('\n'), hand, saved);
  }
  settingsUnchanged(text, 0o600);
});

test('init: a Codex-only save or values equal to .env print no settings.json warning', () => {
  writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: handSecret() } }));
  const lines = [];
  persistInitCredentials({ codexApiKey: 'sk-codex-' + randomBytes(8).toString('hex') }, { log: line => lines.push(line) });
  assert.equal(lines.some(line => line.includes('settings.json')), false, 'nothing Claude was saved');
  const saved = apiKey();
  persistInitCredentials({ apiKey: saved, claudeBaseUrl: relayUrl }, { log: () => {} });
  writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: saved, ANTHROPIC_BASE_URL: relayUrl, [flag]: '1', OTHER: 'x' } }));
  persistInitCredentials({ apiKey: saved, claudeBaseUrl: relayUrl }, { log: line => lines.push(line) });
  assert.equal(lines.some(line => line.includes('settings.json')), false, 'equal values');
});

test('one warning for a run that saves a credential and a base URL; none for Codex', () => {
  writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: handSecret(), ANTHROPIC_BASE_URL: 'https://hand-relay.example.test' } }));
  const saved = apiKey();
  assert.equal(applyCredentials('claude', { apiKey: saved }), true);
  assert.equal(applyBaseUrl('claude', relayUrl), true);
  const message = settingsOverrideAfterSave('claude', { apiKey: saved, baseUrl: relayUrl });
  assert.deepEqual(overrideKeys(message), ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);
  assert.equal(message.match(/settings\.json sets/g).length, 1, 'a single message');
  assert.equal(settingsOverrideAfterSave('codex', { apiKey: saved }), null);
  assert.equal(settingsOverrideAfterSave('claude', {}), null, 'nothing saved in this run');
});

test('missing, env-less and unparseable settings.json print nothing and saving still succeeds', () => {
  for (const text of [null, '{"theme":"dark"}', '{"env":null}', '{"env":["ANTHROPIC_API_KEY"]}', '{"env": {"ANTHROPIC_API_KEY": "x"', 'not json']) {
    if (text === null) fs.rmSync(settingsFile, { force: true }); else writeSettings(text);
    assert.equal(applyCredentials('claude', { apiKey: apiKey() }), true);
    assert.equal(settingsOverrideAfterSave('claude', { apiKey: 'x' }), null, String(text));
    const lines = [];
    persistInitCredentials({ apiKey: apiKey() }, { log: line => lines.push(line) });
    assert.equal(lines.length, 0, String(text));
    if (text === null) assert.equal(fs.existsSync(settingsFile), false, 'settings.json is not created');
    else settingsUnchanged(text);
  }
});

test('init with a subscription login only (no base URL) names an API key left in settings.json', () => {
  fs.writeFileSync(envFile, `KEEP=unchanged\nANTHROPIC_BASE_URL=${officialUrl}\n`);
  const hand = handSecret();
  const text = writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: hand } }));
  const lines = [];
  persistInitCredentials({ subscriptionLogin: true }, { log: line => lines.push(line) });
  const warnings = lines.filter(line => line.includes('settings.json'));
  assert.equal(warnings.length, 1);
  assert.deepEqual(overrideKeys(warnings[0]), ['ANTHROPIC_API_KEY']);
  leaksNothing(lines.join('\n'), hand);
  settingsUnchanged(text);
});

// init checks a setup token with `claude -p` in this process before saving it;
// Claude Code takes settings.json `env` over the process values there. A failed
// check names any overriding key (read only); a passing one says nothing.
// The claude here is a stand-in that only exits; no network.
const checkSetupToken = (t, exit) => {
  const bin = fs.mkdtempSync(path.join(root, 'bin-')), before = process.env.PATH;
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n${exit ? 'echo "401 unauthorized" >&2\n' : ''}exit ${exit}\n`, { mode: 0o755 });
  t.after(() => { process.env.PATH = before; });
  process.env.PATH = bin;
  const lines = [], log = console.log;
  console.log = line => lines.push(String(line));
  try { return { result: verifySetupToken(), lines }; } finally { console.log = log; process.env.PATH = before; }
};

test('init: a failed setup token check names a settings.json key that overrides it', t => {
  const hand = handSecret();
  const text = writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: hand } }));
  assert.equal(saveSetupToken(setupToken()), true);
  const { result, lines } = checkSetupToken(t, 1);
  assert.equal(result.valid, false);
  const warnings = lines.filter(line => line.includes('settings.json'));
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('⚠'), 'printed as an init warning');
  assert.deepEqual(overrideKeys(warnings[0]), ['ANTHROPIC_API_KEY']);
  leaksNothing(lines.join('\n') + JSON.stringify(result), hand);
  settingsUnchanged(text);
});

test('init: a setup token check reports nothing when it passes or when settings.json matches the checked token', t => {
  writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: handSecret() } }));
  assert.equal(saveSetupToken(setupToken()), true);
  const passed = checkSetupToken(t, 0);
  assert.equal(passed.result.valid, true);
  assert.equal(passed.lines.some(line => line.includes('settings.json')), false, 'a passing check');
  // settings.json holds the very token being checked: equal to the checked value
  // (process env), although .env does not have it yet.
  const token = setupToken();
  writeSettings(JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: token } }));
  assert.equal(saveSetupToken(token), true);
  const failed = checkSetupToken(t, 1);
  assert.equal(failed.result.valid, false);
  assert.equal(failed.lines.some(line => line.includes('settings.json')), false, 'compared with the checked token, not .env');
});
