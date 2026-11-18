import test, { after, afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as childProcess from 'node:child_process';

const isolation = Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]]));
const isolationRoot = path.dirname(isolation.TMPDIR || '');
assert.match(path.basename(isolationRoot), /^zylos-tests-/);
for (const value of Object.values(isolation)) assert.ok(value?.startsWith(isolationRoot + path.sep));
const fixtureRoot = fs.mkdtempSync(path.join(isolation.TMPDIR, 'init-status-'));
for (const [key, relative] of Object.entries({ HOME: 'home', ZYLOS_DIR: 'home/zylos', PM2_HOME: 'home/.pm2', TMPDIR: 'tmp' })) {
  process.env[key] = path.join(fixtureRoot, relative); fs.mkdirSync(process.env[key], { recursive: true });
}
const actual = Object.fromEntries(Object.keys(isolation).map(key => [key, process.env[key]]));
for (const value of Object.values(actual)) assert.ok(value.startsWith(fixtureRoot + path.sep));
console.log('Init status isolation:', JSON.stringify({ ...actual, resources: 'injected child processes; no network, PM2, tmux or database' }));
after(() => {
  for (const [key, value] of Object.entries(isolation)) process.env[key] = value;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

let subscription = false;
const probes = [];
const { default: childDefault, ...childExports } = childProcess;
mock.module('node:child_process', { defaultExport: childDefault, namedExports: {
  ...childExports,
  execFileSync(command, args) {
    assert.equal(command, 'which'); assert.deepEqual(args, ['claude']); return '/test/claude';
  },
  spawnSync(command, args, options) {
    assert.equal(command, 'claude'); assert.deepEqual(args, ['auth', 'status', '--json']);
    probes.push(options.env);
    const loggedIn = subscription || keys.some(key => options.env?.[key]);
    return { stdout: JSON.stringify({ loggedIn }), status: loggedIn ? 0 : 1 };
  },
} });
const { CLAUDE_CREDENTIAL_KEYS: keys, ZYLOS_DIR } = await import('../config.js');
const { parseInitFlags, resolveFromEnv, isInitClaudeAuthenticated, runInitAuthentication,
  authenticateClaudeApiCredential, persistInitCredentials, printInitHelp } = await import('../../commands/init.js');
const { claudeProbeEnvironment } = await import('../runtime/session-command.js');
const envFile = path.join(ZYLOS_DIR, '.env');
const envKeys = [...keys, 'ANTHROPIC_BASE_URL'];
let original;
beforeEach(() => {
  original = new Map(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  subscription = false; probes.length = 0;
  fs.rmSync(envFile, { force: true });
});
afterEach(() => {
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(envFile, { force: true });
});

for (const [kind, key, value, pending] of [
  ['setup token', 'CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat-test-placeholder', 'pendingSetupToken'],
  ['API key', 'ANTHROPIC_API_KEY', 'sk-ant-test-placeholder', 'pendingApiKey'],
  ['Bearer token', 'ANTHROPIC_AUTH_TOKEN', 'test-bearer-placeholder', 'pendingAuthToken'],
]) {
  for (const accepted of [true, false]) test(`ambient ${kind} ${accepted ? 'is verified and persisted' : 'fails verification without being authenticated'}`, async () => {
    process.env[key] = value;
    if (key === 'ANTHROPIC_AUTH_TOKEN') process.env.ANTHROPIC_BASE_URL = 'https://relay.example';
    const opts = parseInitFlags([]), output = [], calls = [];
    resolveFromEnv(opts);
    assert.equal(opts.authFromEnv, true);
    const result = await runInitAuthentication(opts, { runtime: 'claude', skipConfirm: true,
      log: line => output.push(line), reportError: line => output.push(line),
      setupVerify: () => { calls.push('verify'); return { valid: accepted, authError: !accepted }; },
      authClaude: (options, deps) => authenticateClaudeApiCredential(options, { ...deps,
        verify: async () => { calls.push('verify'); return accepted; },
      }),
    });
    assert.equal(result.claudeAuthenticated, accepted); assert.equal(result.exitCode, accepted ? 0 : 1);
    assert.equal(result[pending], accepted ? value : null); assert.deepEqual(calls, ['verify']);
    assert.doesNotMatch(output.join('\n'), /Claude Code authenticated/);
    assert.ok(probes.length >= 2);
    for (const probe of probes) {
      for (const credential of keys) assert.equal(probe[credential], undefined);
      assert.equal(probe.ANTHROPIC_BASE_URL, undefined);
    }
    if (accepted) {
      assert.equal(persistInitCredentials({ setupToken: result.pendingSetupToken, apiKey: result.pendingApiKey,
        authToken: result.pendingAuthToken, claudeBaseUrl: result.pendingClaudeBaseUrl }, { log: () => {} }), true);
      assert.equal(claudeProbeEnvironment(ZYLOS_DIR, process.env)[key], value);
      assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    } else {
      assert.equal(fs.existsSync(envFile), false);
      assert.match(output.join('\n'), key === 'CLAUDE_CODE_OAUTH_TOKEN' ? /invalid or expired/ : /rejected/);
    }
  });

  test(`subscription login preserves its billing choice despite ambient ${kind}`, async () => {
    subscription = true; process.env[key] = value;
    const opts = parseInitFlags([]); resolveFromEnv(opts);
    assert.equal(opts.authFromEnv, false);
    const result = await runInitAuthentication(opts, { runtime: 'claude', skipConfirm: true, log: () => {},
      authClaude: () => assert.fail('must preserve existing login'), setupSave: () => assert.fail('must preserve existing login') });
    assert.equal(result.claudeAuthenticated, true); assert.equal(result[pending], null);
    assert.equal(fs.existsSync(envFile), false);
    assert.equal(probes.length, 2); for (const probe of probes) assert.equal(probe[key], undefined);
  });

  for (const same of [true, false]) test(`saved ${kind} ${same ? 'matches ambient credentials silently' : 'wins over different ambient credentials with a notice'}`, async () => {
    const saved = value + '-saved'; fs.writeFileSync(envFile, `${key}=${saved}\n`);
    const before = fs.readFileSync(envFile, 'utf8'); process.env[key] = same ? saved : value;
    const opts = parseInitFlags([]), output = []; resolveFromEnv(opts, { log: line => output.push(line) });
    const result = await runInitAuthentication(opts, { runtime: 'claude', skipConfirm: true, log: () => {},
      authClaude: () => assert.fail('saved presence requires no verification'), setupSave: () => assert.fail('saved presence requires no verification') });
    assert.equal(result.claudeAuthenticated, true); assert.equal(opts.authFromEnv, false); assert.equal(probes.length, 0);
    assert.equal(fs.readFileSync(envFile, 'utf8'), before);
    assert.equal(output.length, same ? 0 : 1);
    if (!same) assert.match(output[0], /not adopted.*\.env already has credentials/);
    assert.equal(output.join('').includes(saved), false); assert.equal(output.join('').includes(value), false);
  });
}

test('different ambient credential kinds are also rejected in favor of saved credentials', () => {
  fs.writeFileSync(envFile, 'ANTHROPIC_API_KEY=sk-ant-saved-placeholder\n');
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-ambient-placeholder';
  const output = [], opts = parseInitFlags([]); resolveFromEnv(opts, { log: line => output.push(line) });
  assert.equal(opts.setupToken, null); assert.equal(output.length, 1); assert.equal(probes.length, 0);
});

for (const [flag, key, value, pending] of [
  ['--api-key', 'ANTHROPIC_API_KEY', 'sk-ant-explicit-placeholder', 'pendingApiKey'],
  ['--auth-token', 'ANTHROPIC_AUTH_TOKEN', 'explicit-bearer-placeholder', 'pendingAuthToken'],
  ['--setup-token', 'CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat-explicit-placeholder', 'pendingSetupToken'],
]) test(`explicit ${flag} retains its established behavior with saved and ambient credentials`, async () => {
  fs.writeFileSync(envFile, 'ANTHROPIC_API_KEY=sk-ant-saved-placeholder\n');
  process.env[key] = value + '-ambient';
  const output = [], opts = parseInitFlags([flag, value]); resolveFromEnv(opts, { log: line => output.push(line) });
  const result = await runInitAuthentication(opts, { runtime: 'claude', skipConfirm: true, log: () => {},
    authClaude: async options => { assert.equal(options[key === 'ANTHROPIC_API_KEY' ? 'apiKey' : 'authToken'], value); return true; },
    setupSave: () => assert.fail('an existing login retains the established setup-token behavior'),
  });
  assert.equal(output.length, 0); assert.equal(opts.authFromEnv, false);
  assert.equal(result.claudeAuthenticated, true);
  assert.equal(result[pending], flag === '--setup-token' ? null : value);
});

test('invalid ambient and explicit setup tokens return the same failure', async () => {
  const value = 'sk-ant-oat-invalid-placeholder'; process.env.CLAUDE_CODE_OAUTH_TOKEN = value;
  const ambient = parseInitFlags([]); resolveFromEnv(ambient);
  const outcomes = [];
  for (const opts of [ambient, parseInitFlags(['--setup-token', value])]) {
    const output = [];
    const result = await runInitAuthentication(opts, { runtime: 'claude', skipConfirm: true, log: () => {},
      setupVerify: () => ({ valid: false, authError: true }), reportError: line => output.push(line),
    });
    outcomes.push({ authenticated: result.claudeAuthenticated, pending: result.pendingSetupToken,
      exitCode: result.exitCode, diagnostic: output.join('\n') });
  }
  assert.deepEqual(outcomes[0], outcomes[1]); assert.equal(outcomes[0].exitCode, 1);
  assert.equal(fs.existsSync(envFile), false);
});

test('no ambient credentials retains unauthenticated and subscription outcomes', async () => {
  const opts = parseInitFlags([]); resolveFromEnv(opts); assert.equal(opts.authFromEnv, false);
  const result = await runInitAuthentication(opts, { runtime: 'claude', skipConfirm: true, log: () => {} });
  assert.equal(result.claudeAuthenticated, false);
  subscription = true; assert.equal(isInitClaudeAuthenticated(), true);
});

test('subscription login recheck uses the same session credential view', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-ambient-placeholder';
  const result = await runInitAuthentication(parseInitFlags([]), { runtime: 'claude', log: () => {},
    choose: async () => 1, nativeLogin: () => { subscription = true; },
  });
  assert.equal(result.subscriptionLogin, true); assert.equal(probes.length, 2);
  for (const probe of probes) assert.equal(probe.ANTHROPIC_API_KEY, undefined);
});

test('probe rejects malformed status and thrown CLI errors without mutating ambient credentials', () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-ambient-placeholder';
  assert.equal(isInitClaudeAuthenticated({ spawn: () => ({ stdout: '{}' }) }), false);
  assert.equal(isInitClaudeAuthenticated({ spawn: () => { throw new Error('unavailable'); } }), false);
  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-ant-ambient-placeholder');
});

test('help states the saved Claude credential exception in both priority sections', () => {
  const originalLog = console.log; let output = '';
  console.log = line => { output += line; };
  try { printInitHelp(); } finally { console.log = originalLog; }
  assert.equal(output.match(/Claude credential exception: environment variables do not override credentials already in \.env\./g)?.length, 2);
});
