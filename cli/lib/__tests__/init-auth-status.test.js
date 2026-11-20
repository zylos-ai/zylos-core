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

const claudePath = path.join(process.env.HOME, 'claude');
fs.writeFileSync(claudePath, '#!/bin/sh\n', { mode: 0o755 });
const previousClaudeBin = process.env.CLAUDE_BIN;
process.env.CLAUDE_BIN = claudePath;
after(() => {
  if (previousClaudeBin === undefined) delete process.env.CLAUDE_BIN;
  else process.env.CLAUDE_BIN = previousClaudeBin;
});

let subscription = false;
const probes = [];
const { default: childDefault, ...childExports } = childProcess;
mock.module('node:child_process', { defaultExport: childDefault, namedExports: {
  ...childExports,
  spawnSync(command, args, options) {
    assert.equal(command, claudePath); assert.deepEqual(args, ['auth', 'status', '--json']);
    probes.push(options.env);
    const loggedIn = subscription || keys.some(key => options.env?.[key]);
    return { stdout: JSON.stringify({ loggedIn }), status: loggedIn ? 0 : 1 };
  },
} });
const { CLAUDE_CREDENTIAL_KEYS: keys, ZYLOS_DIR } = await import('../config.js');
const { parseInitFlags, resolveFromEnv, runInitAuthentication,
  persistInitCredentials, printInitHelp } = await import('../../commands/init.js');
const { claudeProbeEnvironment, localAuthStatus } = await import('../runtime/claude/auth.js');
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

{
  const kind = 'setup token', key = 'CLAUDE_CODE_OAUTH_TOKEN';
  const value = 'sk-ant-oat-test-placeholder', pending = 'setupToken';
  for (const accepted of [true, false]) test(`ambient ${kind} ${accepted ? 'is verified and persisted' : 'fails verification without being authenticated'}`, async () => {
    process.env[key] = value;
    const opts = parseInitFlags([]), output = [], calls = [];
    await resolveFromEnv(opts);
    assert.equal(opts.authFromEnv, true);
    const result = await runInitAuthentication(opts, {
      runtime: 'claude',
      skipConfirm: true,
      log: line => output.push(line),
      reportError: line => output.push(line),
      deps: {
        setupVerify: () => { calls.push('verify'); return { valid: accepted, authError: !accepted }; },
        authClaude: () => assert.fail('setup token must use its own verification flow'),
      },
    });
    assert.equal(result.authenticated, accepted); assert.equal(result.exitCode, accepted ? 0 : 1);
    assert.equal(result.pending.claude[pending], accepted ? value : null); assert.deepEqual(calls, ['verify']);
    assert.doesNotMatch(output.join('\n'), /Claude Code authenticated/);
    assert.equal(output.join('\n').includes(value), false);
    assert.ok(probes.length >= 2);
    for (const probe of probes) {
      for (const credential of keys) assert.equal(probe[credential], undefined);
      assert.equal(probe.ANTHROPIC_BASE_URL, undefined);
    }
    if (accepted) {
      assert.equal(await persistInitCredentials(result.pending, { log: () => {} }), true);
      assert.equal(claudeProbeEnvironment(ZYLOS_DIR, process.env)[key], value);
      assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    } else {
      assert.equal(fs.existsSync(envFile), false);
      assert.match(output.join('\n'), /invalid or expired/);
    }
  });

  test(`subscription login preserves its billing choice despite ambient ${kind}`, async () => {
    subscription = true; process.env[key] = value;
    const opts = parseInitFlags([]); await resolveFromEnv(opts);
    assert.equal(opts.authFromEnv, false);
    const result = await runInitAuthentication(opts, {
      runtime: 'claude',
      skipConfirm: true,
      log: () => {},
      deps: {
        authClaude: () => assert.fail('must preserve existing login'),
        setupSave: () => assert.fail('must preserve existing login'),
      },
    });
    assert.equal(result.authenticated, true); assert.equal(result.pending.claude[pending], null);
    assert.equal(fs.existsSync(envFile), false);
    assert.equal(probes.length, 2); for (const probe of probes) assert.equal(probe[key], undefined);
  });

  for (const same of [true, false]) test(`saved ${kind} ${same ? 'matches ambient credentials silently' : 'wins over different ambient credentials with a notice'}`, async () => {
    const saved = value + '-saved'; fs.writeFileSync(envFile, `${key}=${saved}\n`);
    const before = fs.readFileSync(envFile, 'utf8'); process.env[key] = same ? saved : value;
    const opts = parseInitFlags([]), output = []; await resolveFromEnv(opts, { log: line => output.push(line) });
    const result = await runInitAuthentication(opts, {
      runtime: 'claude',
      skipConfirm: true,
      log: () => {},
      deps: {
        authClaude: () => assert.fail('saved presence requires no verification'),
        setupSave: () => assert.fail('saved presence requires no verification'),
      },
    });
    assert.equal(result.authenticated, true); assert.equal(opts.authFromEnv, false); assert.equal(probes.length, 0);
    assert.equal(fs.readFileSync(envFile, 'utf8'), before);
    assert.equal(output.length, same ? 0 : 1);
    if (!same) {
      assert.match(output[0], /not adopted.*\.env already has credentials/);
      assert.match(output[0], /Use --api-key\/--auth-token or edit \.env/);
    }
    assert.equal(output.join('').includes(saved), false); assert.equal(output.join('').includes(value), false);
  });
}

test('different ambient credential kinds are also rejected in favor of saved credentials', async () => {
  const saved = 'sk-ant-saved-placeholder', ambient = 'sk-ant-oat-ambient-placeholder';
  const previous = `ANTHROPIC_API_KEY=${saved}\n`;
  fs.writeFileSync(envFile, previous);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = ambient;
  const output = [], opts = parseInitFlags([]); await resolveFromEnv(opts, { log: line => output.push(line) });
  assert.equal(opts.setupToken, null); assert.equal(output.length, 1); assert.equal(probes.length, 0);
  assert.equal(fs.readFileSync(envFile, 'utf8'), previous);
  assert.match(output[0], /not adopted.*\.env already has credentials/);
  assert.equal(output[0].includes(saved), false); assert.equal(output[0].includes(ambient), false);
});

test('explicit API key replaces saved credentials despite ambient credentials without a notice', async () => {
  const flag = '--api-key', key = 'ANTHROPIC_API_KEY';
  const value = 'sk-ant-explicit-placeholder', pending = 'apiKey';
  fs.writeFileSync(envFile, 'ANTHROPIC_API_KEY=sk-ant-saved-placeholder\n');
  process.env[key] = value + '-ambient';
  const output = [], opts = parseInitFlags([flag, value]); await resolveFromEnv(opts, { log: line => output.push(line) });
  const result = await runInitAuthentication(opts, {
    runtime: 'claude',
    skipConfirm: true,
    log: () => {},
    deps: {
      authClaude: async options => { assert.equal(options.apiKey, value); return true; },
      setupSave: () => assert.fail('an existing login must skip setup token saving'),
      setupVerify: () => assert.fail('an existing login must skip setup token verification'),
    },
  });
  assert.equal(output.length, 0); assert.equal(opts.authFromEnv, false);
  assert.equal(result.authenticated, true);
  assert.equal(result.pending.claude[pending], value);
});

test('explicit setup token preserves saved credentials without saving or verification', async () => {
  const previous = 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-saved-placeholder\n';
  fs.writeFileSync(envFile, previous);
  const value = 'sk-ant-oat-explicit-placeholder', output = [];
  const opts = parseInitFlags(['--setup-token', value]); await resolveFromEnv(opts);
  const result = await runInitAuthentication(opts, {
    runtime: 'claude',
    skipConfirm: true,
    log: line => output.push(line),
    reportError: line => output.push(line),
    deps: {
      setupSave: () => assert.fail('existing login must skip saving'),
      setupVerify: () => assert.fail('existing login must skip verification'),
      setupRollback: () => assert.fail('existing login must not roll back'),
    },
  });
  assert.equal(probes.length, 0);
  assert.equal(result.authenticated, true); assert.equal(result.exitCode, 0);
  assert.equal(result.pending.claude.setupToken, null); assert.match(output.join('\n'), /Claude Code authenticated/);
  assert.equal(fs.readFileSync(envFile, 'utf8'), previous);
  assert.equal(output.join('\n').includes(value), false);
});

test('subscription login recheck uses the same session credential view', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-ambient-placeholder';
  const result = await runInitAuthentication(parseInitFlags([]), { runtime: 'claude', log: () => {},
    choose: async () => 1, nativeLogin: () => { subscription = true; },
  });
  assert.equal(result.pending.claude.subscriptionLogin, true); assert.equal(probes.length, 2);
  for (const probe of probes) assert.equal(probe.ANTHROPIC_API_KEY, undefined);
});

test('probe rejects malformed status and thrown CLI errors without mutating ambient credentials', () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-ambient-placeholder';
  assert.equal(localAuthStatus({ spawn: () => ({ stdout: '{}' }) }), false);
  assert.equal(localAuthStatus({ spawn: () => { throw new Error('unavailable'); } }), false);
  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-ant-ambient-placeholder');
});

test('help states the saved Claude credential exception in both priority sections', () => {
  const originalLog = console.log; let output = '';
  console.log = line => { output += line; };
  try { printInitHelp(); } finally { console.log = originalLog; }
  assert.equal(output.match(/Claude credential exception: environment variables do not override credentials already in \.env\./g)?.length, 2);
});
