import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

const tmpDirs = [];

const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-claude-fakebin-'));
const fakeClaudePath = path.join(fakeBinDir, 'claude');
const envCapturePath = path.join(fakeBinDir, 'env.json');
const fakeZylosDir = path.join(fakeBinDir, 'zylos');
fs.writeFileSync(
  fakeClaudePath,
  `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(process.env.FAKE_CLAUDE_ENV_OUT, JSON.stringify({
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN || '',
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || '',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '',
  CLAUDECODE: process.env.CLAUDECODE || '',
  CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT || ''
}));
const mode = process.env.FAKE_CLAUDE_MODE || 'success';
if (mode === 'success') {
  console.log('pong');
  process.exit(0);
}
if (mode === 'require_credentials') {
  const hasCredential = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']
    .some(name => process.env[name]);
  console.log(hasCredential ? 'pong' : 'Not logged in');
  process.exit(0);
}
if (mode === 'not_logged_in_stdout') {
  console.log('Not logged in');
  process.exit(0);
}
if (mode === 'auth_error') {
  console.error('authentication_error');
  process.exit(1);
}
if (mode === 'rate_limit') {
  console.error('rate_limit_error');
  process.exit(1);
}
console.error('unknown failure');
process.exit(1);
`,
  { mode: 0o755 }
);

process.env.CLAUDE_BIN = fakeClaudePath;
process.env.FAKE_CLAUDE_ENV_OUT = envCapturePath;
process.env.ZYLOS_DIR = fakeZylosDir;

after(() => { try { fs.rmSync(fakeBinDir, { recursive: true, force: true }); } catch {} });

const { ClaudeAdapter } = await import('../runtime/claude.js');

let originalHome;
let originalZylosDir;
let originalClaudeCode;
let originalClaudeCodeEntrypoint;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalZylosDir = process.env.ZYLOS_DIR;
  originalClaudeCode = process.env.CLAUDECODE;
  originalClaudeCodeEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-claude-auth-home-'));
  tmpDirs.push(tmpHome);
  fs.rmSync(fakeZylosDir, { recursive: true, force: true });
  fs.mkdirSync(fakeZylosDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeZylosDir, '.env'),
    [
      'ANTHROPIC_API_KEY=sk-ant-test',
      'CLAUDE_CODE_OAUTH_TOKEN=oauth-test',
      'ANTHROPIC_BASE_URL=https://claude-proxy.example.com',
      '',
    ].join('\n'),
    'utf8'
  );
  process.env.HOME = tmpHome;
  process.env.ZYLOS_DIR = fakeZylosDir;
  process.env.CLAUDECODE = '1';
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
});

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalZylosDir === undefined) delete process.env.ZYLOS_DIR;
  else process.env.ZYLOS_DIR = originalZylosDir;
  if (originalClaudeCode === undefined) delete process.env.CLAUDECODE;
  else process.env.CLAUDECODE = originalClaudeCode;
  if (originalClaudeCodeEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
  else process.env.CLAUDE_CODE_ENTRYPOINT = originalClaudeCodeEntrypoint;
  delete process.env.FAKE_CLAUDE_MODE;
});

describe('Claude auth checks', () => {
  it('returns success and injects Anthropic credentials plus base URL into the probe env', async () => {
    process.env.FAKE_CLAUDE_MODE = 'success';

    const result = await new ClaudeAdapter({}).checkAuth();
    const env = JSON.parse(fs.readFileSync(envCapturePath, 'utf8'));

    assert.equal(result.status, 'success');
    assert.equal(result.reason, 'cli_probe');
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-test');
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-test');
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://claude-proxy.example.com');
    assert.equal(env.CLAUDECODE, '');
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, '');
  });

  it('injects ANTHROPIC_AUTH_TOKEN with the base URL for a relay-only .env (#1130)', async () => {
    process.env.FAKE_CLAUDE_MODE = 'success';
    fs.writeFileSync(
      path.join(fakeZylosDir, '.env'),
      [
        'ANTHROPIC_BASE_URL=https://relay.example.test',
        'ANTHROPIC_AUTH_TOKEN=relay-bearer-test',
        '',
      ].join('\n'),
      'utf8'
    );
    // The probe must get these from .env, not from the test runner's own environment.
    const authNames = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
    const saved = Object.fromEntries(authNames.map(name => [name, process.env[name]]));
    for (const name of authNames) delete process.env[name];

    try {
      const result = await new ClaudeAdapter({}).checkAuth();
      const env = JSON.parse(fs.readFileSync(envCapturePath, 'utf8'));

      assert.equal(result.status, 'success');
      assert.equal(env.ANTHROPIC_BASE_URL, 'https://relay.example.test');
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'relay-bearer-test');
      assert.equal(env.ANTHROPIC_API_KEY, '');
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, '');
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('carries CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC into the probe only when .env sets it', async () => {
    process.env.FAKE_CLAUDE_MODE = 'success';
    const saved = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    const dotenvPath = path.join(fakeZylosDir, '.env');
    const relay = 'ANTHROPIC_BASE_URL=https://relay.example.test\nANTHROPIC_AUTH_TOKEN=relay-bearer-test\n';
    try {
      fs.writeFileSync(dotenvPath, relay + 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\n', 'utf8');
      await new ClaudeAdapter({}).checkAuth();
      let env = JSON.parse(fs.readFileSync(envCapturePath, 'utf8'));
      assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');

      fs.writeFileSync(dotenvPath, relay, 'utf8');
      await new ClaudeAdapter({}).checkAuth();
      env = JSON.parse(fs.readFileSync(envCapturePath, 'utf8'));
      assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, null);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
      else process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = saved;
    }
  });

  it('does not treat CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC as a credential', async () => {
    process.env.FAKE_CLAUDE_MODE = 'require_credentials';
    fs.writeFileSync(path.join(fakeZylosDir, '.env'), 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\n', 'utf8');
    const names = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'];
    const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    try {
      const result = await new ClaudeAdapter({}).checkAuth();
      const env = JSON.parse(fs.readFileSync(envCapturePath, 'utf8'));

      assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
      assert.equal(env.ANTHROPIC_API_KEY, '');
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, '');
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, '');
      assert.equal(result.status, 'failure');
      assert.equal(result.reason, 'cli_probe_not_logged_in');
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('returns failure for explicit logged-out and authentication-error signals', async () => {
    const adapter = new ClaudeAdapter({});

    process.env.FAKE_CLAUDE_MODE = 'not_logged_in_stdout';
    assert.equal((await adapter.checkAuth()).status, 'failure');

    process.env.FAKE_CLAUDE_MODE = 'auth_error';
    const result = await adapter.checkAuth();
    assert.equal(result.status, 'failure');
    assert.equal(result.reason, 'cli_probe_authentication_error');
  });

  it('returns uncertain for transient probe failures', async () => {
    process.env.FAKE_CLAUDE_MODE = 'rate_limit';

    const result = await new ClaudeAdapter({}).checkAuth();

    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'cli_probe_uncertain');
  });
});
