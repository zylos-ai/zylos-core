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
fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf "fixture-version\\n"\n', { mode: 0o755 });
process.env.HOME = home;
process.env.ZYLOS_DIR = zylos;
process.env.PATH = bin;
for (const key of [...keys, relayFlag]) delete process.env[key];
console.log('Claude credential isolation: ' + JSON.stringify({ HOME: home, ZYLOS_DIR: zylos,
  PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, settingsFile, envFile }));
const { saveApiKey, saveApiKeyToEnv, saveAuthToken, saveAuthTokenToEnv,
  saveSetupToken, saveSetupTokenToEnv, isValidBaseUrl,
  saveClaudeBaseUrl, computeRelayTraffic, relayLoginNotice, syncClaudeRelayTraffic } = await import('../runtime-setup.js');
const { launchEnvironment } = await import('../runtime/session-command.js');
const { applyBaseUrl, applyCredentials, parseRuntimeFlags, validateRuntimeFlags, executeRuntimeSwitch, runtimeCommand } = await import('../../commands/runtime.js');
const { executeAuth, authCommand } = await import('../../commands/auth.js');
const { persistInitCredentials, runInitAuthentication } = await import('../../commands/init.js');
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

test('saving any credential keeps CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC in .env and process and leaves settings.json alone', () => {
  // The setting is passed to the auth probe beside the credentials but is not one;
  // replacing a credential must never remove it.
  const name = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', saved = process.env[name];
  try {
    for (const [label, , save, saveEnv] of modes) {
      fs.writeFileSync(envFile, fs.readFileSync(envFile, 'utf8') + `${name}=1\n`);
      process.env[name] = '1';
      assert.equal(save(secret()), true);
      assert.equal(saveEnv(secret()), true);
      assert.equal(settingsUntouched(), true, `${label}: settings.json untouched`);
      assert.equal(parseDotEnv(fs.readFileSync(envFile))[name], '1', `${label}: .env keeps it`);
      assert.equal(process.env[name], '1', `${label}: process env keeps it`);
    }
  } finally {
    if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
  }
});

// The relay traffic setting, computed from the saved state only: on behind a relay
// base URL or with an API key / Bearer token; absent for a setup token or no saved
// credential (subscription login) on the official API. Saved credentials win.
// Only ~/zylos/.env and the process change; settings.json stays byte-identical.
const relayFlagState = () => ({
  env: parseDotEnv(fs.readFileSync(envFile))[relayFlag],
  envLines: fs.readFileSync(envFile, 'utf8').split('\n').filter(line => line.includes(relayFlag + '=')).length,
  process: process.env[relayFlag],
  settingsUntouched: settingsUntouched(),
});
const RELAY_ON = { env: '1', envLines: 1, process: '1', settingsUntouched: true };
const RELAY_OFF = { env: undefined, envLines: 0, process: undefined, settingsUntouched: true };

const officialUrl = 'https://api.anthropic.com', relayUrl = 'https://relay.example.test';
const seedRelayFlagOn = () => {
  fs.writeFileSync(envFile, fs.readFileSync(envFile, 'utf8') + `export ${relayFlag}=1\n${relayFlag} = 1\n`);
  process.env[relayFlag] = '1';
};

test('pairing rule: relay or API credential on; setup token or no credential on the official API off', () => {
  for (const [baseUrl, credential, on] of [
    [officialUrl, 'apiKey', true], [officialUrl, 'authToken', true], [undefined, 'apiKey', true],
    [officialUrl, 'setupToken', false], [officialUrl, 'none', false], [undefined, undefined, false],
    ...['apiKey', 'authToken', 'setupToken', 'none'].map(credential => [relayUrl, credential, true]),
  ]) assert.equal(computeRelayTraffic({ baseUrl, credential }), on, `${baseUrl} ${credential}`);
});

test('configuring a relay base URL turns the relay traffic setting on in .env and process', () => {
  assert.deepEqual(relayFlagState(), RELAY_OFF);
  assert.equal(applyBaseUrl('claude', relayUrl + '/v1'), true);
  assert.deepEqual(relayFlagState(), RELAY_ON);
  assert.equal(applyBaseUrl('claude', relayUrl + '/v1'), true, 'saving the same relay again is safe');
  assert.deepEqual(relayFlagState(), RELAY_ON);
});

test('configuring a relay base URL rewrites a wrong or duplicated existing value to a single 1', () => {
  fs.writeFileSync(envFile, fs.readFileSync(envFile, 'utf8') + `${relayFlag}=0\nexport ${relayFlag}=1\n`);
  assert.equal(applyBaseUrl('claude', relayUrl), true);
  assert.deepEqual(relayFlagState(), RELAY_ON);
  assert.equal(parseDotEnv(fs.readFileSync(envFile)).KEEP, 'unchanged');
});

test('configuring the official base URL without a credential removes the relay traffic setting from .env and process', () => {
  seedRelayFlagOn();
  assert.equal(applyBaseUrl('claude', officialUrl), true);
  assert.deepEqual(relayFlagState(), RELAY_OFF);
  assert.equal(parseDotEnv(fs.readFileSync(envFile)).KEEP, 'unchanged');
});

test('zylos runtime: API key on the official API turns the setting on; setup token turns it off', () => {
  assert.equal(applyBaseUrl('claude', officialUrl), true);
  assert.deepEqual(relayFlagState(), RELAY_OFF);
  assert.equal(applyCredentials('claude', { apiKey: 'sk-ant-api03-' + secret() }), true);
  assert.deepEqual(relayFlagState(), RELAY_ON, 'API key + official');
  assert.equal(applyCredentials('claude', { setupToken: 'sk-ant-oat01-' + secret() }), true);
  assert.deepEqual(relayFlagState(), RELAY_OFF, 'setup token + official');
});

test('zylos runtime: switching base URL and credential recomputes the setting each time', () => {
  for (const [step, expected] of [
    [() => applyBaseUrl('claude', relayUrl), RELAY_ON],
    [() => applyCredentials('claude', { setupToken: 'sk-ant-oat01-' + secret() }), RELAY_ON],
    [() => applyBaseUrl('claude', officialUrl), RELAY_OFF],
    [() => applyCredentials('claude', { apiKey: 'sk-ant-api03-' + secret() }), RELAY_ON],
    [() => applyBaseUrl('claude', 'https://relay-2.example.test/api'), RELAY_ON],
    [() => applyCredentials('claude', { setupToken: 'sk-ant-oat01-' + secret() }), RELAY_ON],
    [() => applyBaseUrl('claude', officialUrl + '/'), RELAY_OFF],
  ]) {
    assert.equal(step(), true);
    assert.deepEqual(relayFlagState(), expected, step.toString());
  }
});

test('a saved API key wins over a claude.ai login file: --save-apikey then --save-base-url official keeps the setting on', t => {
  const loginFile = path.join(home, '.claude', '.credentials.json');
  t.after(() => fs.rmSync(loginFile, { force: true }));
  fs.writeFileSync(loginFile, JSON.stringify({ claudeAiOauth: { refreshToken: 'synthetic-refresh' } }));
  assert.equal(applyCredentials('claude', { apiKey: 'sk-ant-api03-' + secret() }), true);
  assert.deepEqual(relayFlagState(), RELAY_ON, 'after --save-apikey');
  assert.equal(applyBaseUrl('claude', officialUrl), true);
  assert.deepEqual(relayFlagState(), RELAY_ON, 'after --save-base-url https://api.anthropic.com');
  assert.ok(parseDotEnv(fs.readFileSync(envFile)).ANTHROPIC_API_KEY, 'the API key is still saved');
});

for (const [form, officialLine] of [['an export line', `export ANTHROPIC_BASE_URL=${officialUrl}`], ['a KEY: value line', `ANTHROPIC_BASE_URL: ${officialUrl}`]]) {
  test(`the setting reads .env as the session does: a relay line followed by an official URL in ${form} keeps the relay and the setting on`, () => {
    fs.writeFileSync(envFile, `KEEP=unchanged\nANTHROPIC_BASE_URL=${relayUrl}\n${officialLine}\n`);
    delete process.env[relayFlag];
    assert.equal(launchEnvironment(zylos, { PATH: bin, HOME: home }, { runtime: 'claude' }).ANTHROPIC_BASE_URL, relayUrl, 'the session uses the relay');
    assert.equal(syncClaudeRelayTraffic(), true);
    assert.deepEqual(relayFlagState(), RELAY_ON);
  });
}

test('the setting ignores settings.json: its API key and relay address do not count when .env has none', () => {
  fs.writeFileSync(envFile, `KEEP=unchanged\n${relayFlag}=1\n`);
  process.env[relayFlag] = '1';
  assert.equal(syncClaudeRelayTraffic(), true);
  assert.deepEqual(relayFlagState(), RELAY_OFF, 'settings.json has a relay base URL and an API key, .env has neither');
  assert.equal(applyBaseUrl('claude', officialUrl), true);
  assert.deepEqual(relayFlagState(), RELAY_OFF, 'official URL saved, settings.json API key ignored');
});

// Every Claude save entry point, against an existing settings.json and with none:
// settings.json stays byte-identical, and none is created.
async function saveEverything() {
  const quiet = { log: () => {}, reportError: () => {} };
  assert.equal(saveApiKey('sk-ant-api03-' + secret()), true);
  assert.equal(saveAuthToken('bearer-' + secret()), true);
  assert.equal(saveSetupToken('sk-ant-oat01-' + secret()), true);
  assert.equal(saveClaudeBaseUrl(relayUrl), true);
  assert.equal(applyCredentials('claude', { apiKey: 'sk-ant-api03-' + secret() }), true);
  assert.equal(applyCredentials('claude', { setupToken: 'sk-ant-oat01-' + secret() }), true);
  assert.equal(applyBaseUrl('claude', relayUrl), true);
  assert.equal(applyBaseUrl('claude', officialUrl), true);
  assert.equal(persistInitCredentials({ authToken: 'bearer-' + secret(), claudeBaseUrl: relayUrl }, quiet), true);
  assert.equal(persistInitCredentials({ apiKey: 'sk-ant-api03-' + secret() }, quiet), true);
  assert.equal(persistInitCredentials({ setupToken: 'sk-ant-oat01-' + secret() }, quiet), true);
  assert.equal(persistInitCredentials({ subscriptionLogin: true, claudeBaseUrl: officialUrl }, quiet), true);
  const auth = await executeAuth(['claude'], { exists: () => true, spawn: () => ({ status: 0 }),
    adapter: () => ({ checkAuth: async () => ({ status: 'success' }) }), notifyRecovery: () => true });
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

test('no Claude save entry point creates settings.json', async () => {
  fs.rmSync(settingsFile);
  await saveEverything();
  assert.equal(fs.existsSync(settingsFile), false);
  fs.writeFileSync(settingsFile, SETTINGS_TEXT);
});

for (const [leftover, expected] of [[true, 'on'], [false, 'off']]) {
  test(`zylos auth claude subscription login on the official API ${leftover ? 'with' : 'without'} a leftover .env API key leaves the setting ${expected}`, async t => {
    const loginFile = path.join(home, '.claude', '.credentials.json');
    t.after(() => fs.rmSync(loginFile, { force: true }));
    assert.equal(applyBaseUrl('claude', officialUrl), true);
    if (leftover) fs.appendFileSync(envFile, `ANTHROPIC_API_KEY=sk-ant-api03-${secret()}\n`);
    seedRelayFlagOn();
    const result = await executeAuth(['claude'], { exists: () => true,
      spawn: () => { fs.writeFileSync(loginFile, JSON.stringify({ claudeAiOauth: { refreshToken: 'synthetic-refresh' } })); return { status: 0 }; },
      adapter: () => ({ checkAuth: async () => ({ status: 'success' }) }), notifyRecovery: () => true });
    assert.equal(result.ok, true);
    assert.deepEqual(relayFlagState(), leftover ? RELAY_ON : RELAY_OFF);
  });
}

test('a login behind a saved relay keeps the relay and gets a notice with the command to go direct', () => {
  assert.equal(applyBaseUrl('claude', relayUrl), true);
  assert.equal(applyCredentials('claude', { setupToken: 'sk-ant-oat01-' + secret() }), true);
  assert.deepEqual(relayFlagState(), RELAY_ON, 'the switch follows the kept relay');
  const notice = relayLoginNotice();
  assert.match(notice, /Still using the relay https:\/\/relay\.example\.test/);
  assert.match(notice, /zylos runtime claude --save-base-url https:\/\/api\.anthropic\.com/);
  assert.equal(parseDotEnv(fs.readFileSync(envFile)).ANTHROPIC_BASE_URL, relayUrl, 'the relay URL is not removed');
});

test('`zylos runtime claude --save-base-url https://api.anthropic.com` sets the official URL in .env and the process and turns the switch off', () => {
  assert.equal(applyBaseUrl('claude', relayUrl), true);
  assert.equal(applyCredentials('claude', { setupToken: 'sk-ant-oat01-' + secret() }), true);
  assert.deepEqual(relayFlagState(), RELAY_ON);
  const parsed = parseRuntimeFlags(['--save-base-url', 'https://api.anthropic.com']);
  assert.equal(validateRuntimeFlags('claude', parsed), null);
  assert.equal(applyBaseUrl('claude', parsed.baseUrl), true);
  assert.equal(parseDotEnv(fs.readFileSync(envFile)).ANTHROPIC_BASE_URL, officialUrl);
  assert.equal(process.env.ANTHROPIC_BASE_URL, officialUrl);
  assert.deepEqual(relayFlagState(), RELAY_OFF);
  assert.equal(relayLoginNotice(), null);
});

test('the process-only base URL used during init follows the pairing rule', () => {
  assert.equal(saveClaudeBaseUrl(relayUrl), true);
  assert.equal(process.env[relayFlag], '1');
  assert.equal(saveClaudeBaseUrl(officialUrl), true);
  assert.equal(process.env[relayFlag], undefined);
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-' + secret();
  assert.equal(saveClaudeBaseUrl(officialUrl), true);
  assert.equal(process.env[relayFlag], '1', 'API key + official');
});

test('changing from Bearer to API key and setup token leaves one selected method in .env and the process', () => {
  for (const [, key, save, saveEnv] of [modes[1], modes[0], modes[2], modes[1]]) {
    const value = secret();
    assert.equal(save(value), true); assert.equal(saveEnv(value), true);
    assert.deepEqual(keys.filter(name => process.env[name] !== undefined), [key]);
    sameSecret(process.env[key], value);
    assert.equal(settingsUntouched(), true);
    const authNames = [...fs.readFileSync(envFile, 'utf8').matchAll(/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)=/gm)].map(match => match[1]);
    assert.deepEqual(authNames, [key]);
  }
});

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

// settings.json override warning: after a Claude save, zylos reads (never writes)
// ~/.claude/settings.json and names the built-in keys whose value there would
// override what it just saved to .env. Key names only, never values; one warning
// per command run on that command's warning list; the command still succeeds.
// Nothing for a missing, env-less or unparseable file.
const OVERRIDE = 'CLAUDE_SETTINGS_OVERRIDE';
const overrideKeys = message => {
  assert.ok(message, 'a warning is expected');
  assert.ok(message.includes(settingsFile), 'the warning names the settings.json path');
  assert.match(message, /Claude Code uses those values instead of the ones zylos gives it/);
  assert.match(message, /remove th(?:at key|ose keys) from .* by hand/);
  return message.match(/ sets (.+) in its env block/)[1].split(', ');
};
// No 8-character slice of any secret may appear in the output.
const leaksNothing = (output, ...secrets) => {
  for (const value of secrets) for (let i = 0; i + 8 <= value.length; i++) {
    if (output.includes(value.slice(i, i + 8))) assert.fail(`output contains part of a secret (offset ${i})`);
  }
};
const writeSettings = (text, mode = 0o644) => { fs.writeFileSync(settingsFile, text); fs.chmodSync(settingsFile, mode); return text; };
const settingsUnchanged = (text, mode = 0o644) => {
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), text, 'settings.json is byte-identical');
  assert.equal(fs.statSync(settingsFile).mode & 0o777, mode, 'settings.json mode is unchanged');
};
const handSecret = () => 'sk-ant-api03-hand-' + secret();
// Seeded owner-only: a zylos runtime save already restricts a world-readable
// settings.json to 0600 (credential file permission check), separate from this warning.
const PRIVATE = 0o600;
// zylos runtime with its real credential and base URL saves; everything after the save is stubbed.
const runtimeDeps = (target = 'claude', changes = {}) => ({
  read: () => ({ state: 'ok', config: { runtime: target, session_mode: 'multi' } }), mode: () => ({ mode: 'multi' }),
  adapter: () => ({ checkAuth: async () => ({ status: 'success' }) }), exists: () => true,
  hooksReady: () => ({ ready: true, pendingMigration: false }),
  write: () => ({ previous: { runtime: target }, config: { runtime: target, session_mode: 'multi' }, changed: false }),
  observe: async () => ({ groups: [], groupsComplete: true, observationErrors: [] }), identity: async () => ({ present: false }), ...changes });
const runtimeSave = (flags, { target = 'claude', ...changes } = {}) => executeRuntimeSwitch(target, flags, runtimeDeps(target, changes));
const overrideWarnings = result => {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.data.warnings.filter(item => item.code === OVERRIDE);
};
const loginSave = (runtime = 'claude') => executeAuth([runtime], { exists: () => true, spawn: () => ({ status: 0 }),
  adapter: () => ({ checkAuth: async () => ({ status: 'success' }) }), notifyRecovery: () => true });

test('zylos runtime --save-apikey: a different settings.json API key is named once, without either value', async () => {
  const hand = handSecret(), saved = 'sk-ant-api03-' + secret();
  const text = writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: hand, ANTHROPIC_BASE_URL: 'https://relay.example.test' } }), PRIVATE);
  const result = await runtimeSave(['--save-apikey', saved]);
  const warnings = overrideWarnings(result);
  assert.equal(warnings.length, 1);
  assert.deepEqual(overrideKeys(warnings[0].message), ['ANTHROPIC_API_KEY'], 'the equal relay address is not named');
  leaksNothing(JSON.stringify(result), hand, saved);
  settingsUnchanged(text, PRIVATE);
});

test('zylos runtime --save-setup-token: settings.json credentials zylos does not set are named', async () => {
  const hand = handSecret(), bearer = 'bearer-' + secret(), oldToken = 'sk-ant-oat01-' + secret(), saved = 'sk-ant-oat01-' + secret();
  const text = writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: hand, ANTHROPIC_AUTH_TOKEN: bearer, CLAUDE_CODE_OAUTH_TOKEN: oldToken } }), PRIVATE);
  const result = await runtimeSave(['--save-setup-token', saved]);
  const [warning] = overrideWarnings(result);
  assert.deepEqual(overrideKeys(warning.message), ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);
  leaksNothing(JSON.stringify(result), hand, bearer, oldToken, saved);
  settingsUnchanged(text, PRIVATE);
});

test('zylos runtime --save-base-url: a different relay address and switch value in settings.json are named', async () => {
  const text = writeSettings(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://hand-relay.example.test', [relayFlag]: '0' } }), PRIVATE);
  const [warning] = overrideWarnings(await runtimeSave(['--save-base-url', 'https://relay-2.example.test']));
  assert.equal(parseDotEnv(fs.readFileSync(envFile))[relayFlag], '1', 'zylos turned the switch on');
  assert.deepEqual(overrideKeys(warning.message), ['ANTHROPIC_BASE_URL', relayFlag]);
  settingsUnchanged(text, PRIVATE);
});

test('the go-direct command while settings.json keeps a relay and the switch on: both are named', async () => {
  assert.equal(applyCredentials('claude', { setupToken: 'sk-ant-oat01-' + secret() }), true);
  const text = writeSettings(JSON.stringify({ env: { ANTHROPIC_BASE_URL: relayUrl, [relayFlag]: '1' } }), PRIVATE);
  const [warning] = overrideWarnings(await runtimeSave(['--save-base-url', officialUrl]));
  assert.equal(parseDotEnv(fs.readFileSync(envFile))[relayFlag], undefined, 'zylos turned the switch off');
  assert.deepEqual(overrideKeys(warning.message), ['ANTHROPIC_BASE_URL', relayFlag]);
  settingsUnchanged(text, PRIVATE);
});

test('one warning for a run that saves a credential and a base URL', async () => {
  writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: handSecret(), ANTHROPIC_BASE_URL: 'https://hand-relay.example.test' } }));
  const warnings = overrideWarnings(await runtimeSave(['--save-apikey', 'sk-ant-api03-' + secret(), '--save-base-url', relayUrl]));
  assert.equal(warnings.length, 1);
  assert.deepEqual(overrideKeys(warnings[0].message), ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);
});

test('zylos auth claude: the switch left on in settings.json while zylos turns it off is named; equal is not', async () => {
  fs.writeFileSync(envFile, `KEEP=unchanged\nANTHROPIC_BASE_URL=${officialUrl}\n${relayFlag}=1\n`);
  const text = writeSettings(JSON.stringify({ env: { [relayFlag]: '1' } }));
  const result = await loginSave();
  assert.equal(parseDotEnv(fs.readFileSync(envFile))[relayFlag], undefined, 'zylos turned the switch off');
  const [warning] = overrideWarnings(result);
  assert.deepEqual(overrideKeys(warning.message), [relayFlag]);
  fs.writeFileSync(envFile, `KEEP=unchanged\nANTHROPIC_BASE_URL=${relayUrl}\n`);
  assert.deepEqual(overrideWarnings(await loginSave()), [], 'zylos turned it on: same value');
  settingsUnchanged(text);
});

test('init persistence (API key, Bearer token, setup token, login) warns once on the init warning stream', () => {
  const hand = handSecret(), key = 'sk-ant-api03-' + secret(), bearer = 'bearer-' + secret();
  const text = writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: hand, ANTHROPIC_BASE_URL: 'https://hand-relay.example.test', [relayFlag]: '1' } }), 0o600);
  for (const values of [{ apiKey: key, claudeBaseUrl: relayUrl }, { authToken: bearer }, { setupToken: 'sk-ant-oat01-' + secret() },
    { subscriptionLogin: true, claudeBaseUrl: officialUrl }]) {
    const lines = [];
    assert.equal(persistInitCredentials(values, { log: line => lines.push(line), reportError: line => lines.push(line) }), true);
    const warnings = lines.filter(line => line.includes('settings.json'));
    assert.equal(warnings.length, 1, `one warning per run: ${Object.keys(values).join()}`);
    assert.ok(warnings[0].includes('⚠'), 'printed as an init warning');
    assert.ok(overrideKeys(warnings[0]).length > 0);
    leaksNothing(lines.join('\n'), hand, key, bearer);
  }
  settingsUnchanged(text, 0o600);
});

test('values equal to .env print no settings.json warning on any path', async () => {
  const key = 'sk-ant-api03-' + secret();
  assert.equal(persistInitCredentials({ apiKey: key, claudeBaseUrl: relayUrl }, { log: () => {} }), true);
  writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: relayUrl, [relayFlag]: '1', OTHER: 'x' } }));
  const lines = [];
  assert.equal(persistInitCredentials({ apiKey: key, claudeBaseUrl: relayUrl }, { log: line => lines.push(line) }), true);
  assert.deepEqual(lines, []);
  assert.deepEqual(overrideWarnings(await runtimeSave(['--save-apikey', key, '--save-base-url', relayUrl])), []);
  assert.deepEqual(overrideWarnings(await loginSave()), []);
});

test('missing, env-less and unparseable settings.json print nothing and every save still succeeds', async () => {
  for (const text of [null, '{"theme":"dark"}', '{"env":null}', '{"env":["ANTHROPIC_API_KEY"]}', '{"env": {"ANTHROPIC_API_KEY": "x"', 'not json']) {
    if (text === null) fs.rmSync(settingsFile, { force: true }); else writeSettings(text, PRIVATE);
    assert.deepEqual(overrideWarnings(await runtimeSave(['--save-apikey', 'sk-ant-api03-' + secret()])), [], String(text));
    assert.deepEqual(overrideWarnings(await loginSave()), [], String(text));
    const lines = [];
    assert.equal(persistInitCredentials({ authToken: 'bearer-' + secret() }, { log: line => lines.push(line) }), true);
    assert.deepEqual(lines, [], String(text));
    if (text === null) assert.equal(fs.existsSync(settingsFile), false, 'settings.json is not created');
    else settingsUnchanged(text, PRIVATE);
  }
});

// The case the warning exists for: the auth probe runs Claude Code, which takes
// the overriding settings.json key and fails. The save already happened, so the
// failure result still carries the warning (error.warnings) and the text output
// prints it before the error.
for (const [name, changes, code] of [
  ['the auth probe fails', { adapter: () => ({ checkAuth: async () => ({ status: 'failure' }) }) }, 'AUTH_NOT_CONFIRMED'],
  ['hooks are not ready', { hooksReady: () => ({ ready: false }) }, 'HOOKS_NOT_READY'],
  ['the config write fails', { write: () => { throw Object.assign(new Error('config write failed'), { code: 'CONFIG_WRITE_FAILED' }); } }, 'CONFIG_WRITE_FAILED'],
]) test(`zylos runtime --save-apikey keeps the settings.json warning when ${name} after the save`, async () => {
  const hand = handSecret(), saved = 'sk-ant-api03-' + secret();
  const text = writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: hand } }), PRIVATE);
  const result = await runtimeSave(['--save-apikey', saved], changes);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  assert.deepEqual(result.error.persisted, ['apiKey']);
  const warnings = (result.error.warnings ?? []).filter(item => item.code === OVERRIDE);
  assert.equal(warnings.length, 1, 'exactly one settings.json warning on the failure result');
  assert.deepEqual(overrideKeys(warnings[0].message), ['ANTHROPIC_API_KEY']);
  leaksNothing(JSON.stringify(result), hand, saved);
  settingsUnchanged(text, PRIVATE);
});

test('zylos runtime text output prints the settings.json warning before the error when the probe fails', async () => {
  const hand = handSecret(), saved = 'sk-ant-api03-' + secret();
  const text = writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: hand } }), PRIVATE);
  const failing = runtimeDeps('claude', { adapter: () => ({ checkAuth: async () => ({ status: 'failure' }) }) });
  const errors = [], logs = [], original = { error: console.error, log: console.log }, exitCode = process.exitCode;
  console.error = line => errors.push(String(line)); console.log = line => logs.push(String(line));
  let result;
  try { result = await runtimeCommand(['claude', '--save-apikey', saved], { execute: (target, flags) => executeRuntimeSwitch(target, flags, failing) }); }
  finally { console.error = original.error; console.log = original.log; process.exitCode = exitCode; }
  assert.equal(result.ok, false);
  const warning = errors.findIndex(line => line.startsWith(`Warning [${OVERRIDE}]: `));
  const failure = errors.findIndex(line => line.startsWith('Error [AUTH_NOT_CONFIRMED]: '));
  assert.ok(warning >= 0, 'the warning is printed on stderr');
  assert.ok(failure > warning, 'the warning comes before the error');
  assert.deepEqual(overrideKeys(errors[warning].slice(`Warning [${OVERRIDE}]: `.length)), ['ANTHROPIC_API_KEY']);
  leaksNothing([...errors, ...logs].join('\n'), hand, saved);
  settingsUnchanged(text, PRIVATE);
});

test('Codex saves never report the Claude settings.json warning', async () => {
  const text = writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: handSecret(), ANTHROPIC_BASE_URL: 'https://hand-relay.example.test', [relayFlag]: '0' } }), PRIVATE);
  const saved = await runtimeSave(['--save-apikey', 'sk-codex-' + secret()], { target: 'codex' });
  assert.equal(saved.ok, true, JSON.stringify(saved.error));
  assert.equal(saved.data.warnings.some(item => item.code === OVERRIDE), false, 'zylos runtime codex --save-apikey');
  const failed = await runtimeSave(['--save-apikey', 'sk-codex-' + secret()], { target: 'codex', adapter: () => ({ checkAuth: async () => ({ status: 'failure' }) }) });
  assert.equal(failed.ok, false);
  assert.equal((failed.error.warnings ?? []).some(item => item.code === OVERRIDE), false, 'failed zylos runtime codex --save-apikey');
  const login = await loginSave('codex');
  assert.equal(login.ok, true, JSON.stringify(login.error));
  assert.equal(login.data.warnings.some(item => item.code === OVERRIDE), false, 'zylos auth codex');
  settingsUnchanged(text, PRIVATE);
});

test('init with a subscription login only (no base URL) names an API key left in settings.json', () => {
  fs.writeFileSync(envFile, `KEEP=unchanged\nANTHROPIC_BASE_URL=${officialUrl}\n`);
  const hand = handSecret();
  const text = writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: hand } }));
  const lines = [];
  assert.equal(persistInitCredentials({ subscriptionLogin: true }, { log: line => lines.push(line), reportError: line => lines.push(line) }), true);
  const warnings = lines.filter(line => line.includes('settings.json'));
  assert.equal(warnings.length, 1);
  assert.deepEqual(overrideKeys(warnings[0]), ['ANTHROPIC_API_KEY']);
  leaksNothing(lines.join('\n'), hand);
  settingsUnchanged(text);
});

// When a Claude auth check fails, the check itself ran Claude Code, which takes
// settings.json `env` over the values zylos passed. The failure names any key
// there that overrides the values the check used (read only), even though
// nothing was saved yet. Codex and successful checks are unchanged.
const failedLogin = (runtime = 'claude', status = 'failure') => executeAuth([runtime], { exists: () => true, spawn: () => ({ status: 0 }),
  adapter: () => ({ checkAuth: async () => ({ status }) }), notifyRecovery: () => true });
const failureOverrides = result => {
  assert.equal(result.ok, false);
  return (result.error.warnings ?? []).filter(item => item.code === OVERRIDE);
};

for (const [status, code] of [['failure', 'AUTH_FAILED'], ['uncertain', 'AUTH_NOT_CONFIRMED']]) {
  test(`zylos auth claude: a ${status} check names a settings.json key that overrides the checked values`, async () => {
    const saved = 'sk-ant-api03-' + secret(), hand = handSecret();
    fs.writeFileSync(envFile, `KEEP=unchanged\nANTHROPIC_API_KEY=${saved}\n`);
    const text = writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: hand } }));
    const result = await failedLogin('claude', status);
    assert.equal(result.error.code, code);
    const warnings = failureOverrides(result);
    assert.equal(warnings.length, 1);
    assert.deepEqual(overrideKeys(warnings[0].message), ['ANTHROPIC_API_KEY']);
    leaksNothing(JSON.stringify(result), hand, saved);
    settingsUnchanged(text);
  });
}

test('zylos auth claude text output prints the settings.json warning before the error', async () => {
  const saved = 'sk-ant-api03-' + secret(), hand = handSecret();
  fs.writeFileSync(envFile, `KEEP=unchanged\nANTHROPIC_API_KEY=${saved}\n`);
  const text = writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: hand } }));
  const errors = [], logs = [], original = { error: console.error, log: console.log }, exitCode = process.exitCode;
  console.error = line => errors.push(String(line)); console.log = line => logs.push(String(line));
  try { await authCommand(['claude'], { exists: () => true, spawn: () => ({ status: 0 }), adapter: () => ({ checkAuth: async () => ({ status: 'failure' }) }) }); }
  finally { console.error = original.error; console.log = original.log; assert.equal(process.exitCode, 1, 'the exit code stays 1'); process.exitCode = exitCode; }
  const warning = errors.findIndex(line => line.startsWith(`Warning [${OVERRIDE}]: `));
  assert.ok(warning >= 0, 'the warning is printed on stderr');
  assert.ok(errors.findIndex(line => line.startsWith('Error [AUTH_FAILED]: ')) > warning, 'the warning comes before the error');
  leaksNothing([...errors, ...logs].join('\n'), hand, saved);
  settingsUnchanged(text);
});

test('zylos auth claude: a failed check with no overriding key, or a Codex check, reports no settings.json warning', async t => {
  const saved = 'sk-ant-api03-' + secret();
  fs.writeFileSync(envFile, `KEEP=unchanged\nANTHROPIC_API_KEY=${saved}\n`);
  writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: saved, KEEP: 'x' } }));
  assert.deepEqual(failureOverrides(await failedLogin()), [], 'equal value');
  // The check's values, not .env: in compat mode the check inherits a base URL
  // from the process that .env does not set; the same URL in settings.json is equal.
  const inherited = 'https://inherited-relay.example.test', before = process.env.ANTHROPIC_BASE_URL;
  t.after(() => { if (before === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = before; });
  process.env.ANTHROPIC_BASE_URL = inherited;
  fs.writeFileSync(envFile, `ZYLOS_CLEAN_ENV=false\nANTHROPIC_API_KEY=${saved}\n`);
  writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: saved, ANTHROPIC_BASE_URL: inherited } }));
  assert.deepEqual(failureOverrides(await failedLogin()), [], 'compared with the values the check used');
  writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: handSecret() } }));
  assert.deepEqual(failureOverrides(await failedLogin('codex')), [], 'zylos auth codex');
});

// init: a setup token is checked with `claude -p` in this process before it is
// saved; settings.json `env` overrides the process values there.
const setupCheck = (result, lines) => runInitAuthentication({ setupToken: 'sk-ant-oat01-' + secret() }, {
  runtime: 'claude', quiet: true, skipConfirm: true, exists: () => true, claudeStatus: () => false,
  setupVerify: () => result, log: line => lines.push(String(line)), reportError: line => lines.push(String(line)) });

test('init: a failed setup token check names a settings.json key that overrides it', async () => {
  const hand = handSecret();
  const text = writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: hand } }));
  const lines = [];
  const result = await setupCheck({ valid: false, authError: true }, lines);
  assert.equal(result.claudeAuthenticated, false);
  const warnings = lines.filter(line => line.includes('settings.json'));
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('⚠'), 'printed as an init warning');
  assert.deepEqual(overrideKeys(warnings[0]), ['ANTHROPIC_API_KEY']);
  leaksNothing(lines.join('\n'), hand);
  settingsUnchanged(text);
});

test('init: a setup token check reports nothing when it passes or when settings.json matches the checked token', async () => {
  writeSettings(JSON.stringify({ env: { ANTHROPIC_API_KEY: handSecret() } }));
  const passed = [];
  await setupCheck({ valid: true }, passed);
  assert.equal(passed.some(line => line.includes('settings.json')), false, 'a passing check');
  // settings.json holds the very token being checked: equal to the checked value
  // (process env), although .env does not have it yet.
  const token = 'sk-ant-oat01-' + secret(), lines = [];
  writeSettings(JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: token } }));
  await runInitAuthentication({ setupToken: token }, { runtime: 'claude', quiet: true, skipConfirm: true, exists: () => true,
    claudeStatus: () => false, setupVerify: () => ({ valid: false, authError: true }), log: line => lines.push(String(line)), reportError: line => lines.push(String(line)) });
  assert.equal(lines.some(line => line.includes('settings.json')), false, 'compared with the checked token, not .env');
});
