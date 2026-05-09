import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const { buildCleanEnv, buildCompatEnv, parseManifest, writeLaunchSpec, readAndDeleteSpec } = await import('../runtime/tmux-env.js');

const tmpFiles = [];
afterEach(() => {
  while (tmpFiles.length) {
    try { fs.unlinkSync(tmpFiles.pop()); } catch { }
  }
});

// ── parseManifest ──────────────────────────────────────────────────────────

describe('parseManifest', () => {
  it('parses comma-separated names', () => {
    assert.deepEqual(parseManifest('FOO,BAR,BAZ'), ['FOO', 'BAR', 'BAZ']);
  });

  it('trims whitespace and skips empty strings', () => {
    assert.deepEqual(parseManifest(' FOO , , BAR '), ['FOO', 'BAR']);
  });

  it('returns empty array for empty/null input', () => {
    assert.deepEqual(parseManifest(''), []);
    assert.deepEqual(parseManifest(null), []);
    assert.deepEqual(parseManifest(undefined), []);
  });

  it('rejects invalid variable names and records warnings', () => {
    const warnings = [];
    const result = parseManifest('GOOD,123bad,also-bad,OK_2', warnings);
    assert.deepEqual(result, ['GOOD', 'OK_2']);
    assert.equal(warnings.length, 2);
    assert.ok(warnings[0].includes('123bad'));
    assert.ok(warnings[1].includes('also-bad'));
  });
});

// ── buildCleanEnv ──────────────────────────────────────────────────────────

describe('buildCleanEnv', () => {
  const baseProcessEnv = {
    PATH: '/usr/bin:/usr/local/bin',
    HOME: '/home/testuser',
    USER: 'testuser',
    LOGNAME: 'testuser',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    SHELL: '/bin/bash',
  };

  it('includes all 8 base variables', () => {
    const { env } = buildCleanEnv({ processEnv: baseProcessEnv, dotenvVars: {}, platform: 'linux' });
    for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'SHELL']) {
      assert.ok(env[key] !== undefined, `Missing base var: ${key}`);
    }
  });

  it('excludes ambient variables not in allowlist', () => {
    const processEnv = { ...baseProcessEnv, AWS_SECRET_KEY: 'secret123', RANDOM_VAR: 'xyz' };
    const { env } = buildCleanEnv({ processEnv, dotenvVars: {}, platform: 'linux' });
    assert.equal(env.AWS_SECRET_KEY, undefined);
    assert.equal(env.RANDOM_VAR, undefined);
  });

  it('injects ZYLOS_TMUX_ENV vars from dotenvVars', () => {
    const dotenvVars = {
      ZYLOS_TMUX_ENV: 'MY_VAR,OTHER_VAR',
      MY_VAR: 'value1',
      OTHER_VAR: 'value2',
    };
    const { env } = buildCleanEnv({ processEnv: baseProcessEnv, dotenvVars, platform: 'linux' });
    assert.equal(env.MY_VAR, 'value1');
    assert.equal(env.OTHER_VAR, 'value2');
  });

  it('injects ZYLOS_TMUX_INHERIT vars from processEnv', () => {
    const processEnv = { ...baseProcessEnv, SSH_AUTH_SOCK: '/tmp/ssh.sock' };
    const dotenvVars = { ZYLOS_TMUX_INHERIT: 'SSH_AUTH_SOCK' };
    const { env } = buildCleanEnv({ processEnv, dotenvVars, platform: 'linux' });
    assert.equal(env.SSH_AUTH_SOCK, '/tmp/ssh.sock');
  });

  it('ZYLOS_TMUX_ENV wins over ZYLOS_TMUX_INHERIT on conflict', () => {
    const processEnv = { ...baseProcessEnv, CONFLICT_VAR: 'from_process' };
    const dotenvVars = {
      ZYLOS_TMUX_ENV: 'CONFLICT_VAR',
      ZYLOS_TMUX_INHERIT: 'CONFLICT_VAR',
      CONFLICT_VAR: 'from_dotenv',
    };
    const { env } = buildCleanEnv({ processEnv, dotenvVars, platform: 'linux' });
    assert.equal(env.CONFLICT_VAR, 'from_dotenv');
  });

  it('auto-inherits proxy vars from processEnv', () => {
    const processEnv = { ...baseProcessEnv, HTTP_PROXY: 'http://proxy:8080', https_proxy: 'http://proxy:8443' };
    const { env } = buildCleanEnv({ processEnv, dotenvVars: {}, platform: 'linux' });
    assert.equal(env.HTTP_PROXY, 'http://proxy:8080');
    assert.equal(env.https_proxy, 'http://proxy:8443');
  });

  it('includes TMPDIR on macOS when present', () => {
    const processEnv = { ...baseProcessEnv, TMPDIR: '/var/folders/xx/tmp' };
    const { env: envDarwin } = buildCleanEnv({ processEnv, dotenvVars: {}, platform: 'darwin' });
    assert.equal(envDarwin.TMPDIR, '/var/folders/xx/tmp');

    const { env: envLinux } = buildCleanEnv({ processEnv, dotenvVars: {}, platform: 'linux' });
    assert.equal(envLinux.TMPDIR, undefined);
  });

  it('skips invalid variable names and records warnings', () => {
    const dotenvVars = {
      ZYLOS_TMUX_ENV: 'GOOD,bad-name',
      GOOD: 'ok',
      'bad-name': 'nope',
    };
    const { env, warnings } = buildCleanEnv({ processEnv: baseProcessEnv, dotenvVars, platform: 'linux' });
    assert.equal(env.GOOD, 'ok');
    assert.equal(env['bad-name'], undefined);
    assert.ok(warnings.some(w => w.includes('bad-name')));
  });

  it('extracts .nvm paths from processEnv.PATH', () => {
    const processEnv = {
      ...baseProcessEnv,
      PATH: '/home/testuser/.nvm/versions/node/v24.13.1/bin:/usr/bin',
    };
    const { env } = buildCleanEnv({ processEnv, dotenvVars: {}, platform: 'linux' });
    assert.ok(env.PATH.includes('.nvm'), `PATH should include .nvm segment: ${env.PATH}`);
  });
});

// ── buildCompatEnv ─────────────────────────────────────────────────────────

describe('buildCompatEnv', () => {
  it('passes through full processEnv', () => {
    const processEnv = { PATH: '/usr/bin', HOME: '/home/test', SECRET: 'abc123' };
    const { env } = buildCompatEnv({ processEnv, dotenvVars: {} });
    assert.equal(env.SECRET, 'abc123');
    assert.equal(env.PATH, '/usr/bin');
  });

  it('overrides with ZYLOS_TMUX_ENV manifest vars', () => {
    const processEnv = { MY_VAR: 'old_value' };
    const dotenvVars = { ZYLOS_TMUX_ENV: 'MY_VAR', MY_VAR: 'new_value' };
    const { env } = buildCompatEnv({ processEnv, dotenvVars });
    assert.equal(env.MY_VAR, 'new_value');
  });
});

// ── spec file I/O ──────────────────────────────────────────────────────────

describe('writeLaunchSpec / readAndDeleteSpec', () => {
  it('writes 0600 file and reads it back', () => {
    const spec = { command: 'node', args: ['test.js'], env: { FOO: 'bar' }, cwd: '/tmp' };
    const specPath = writeLaunchSpec(spec);
    tmpFiles.push(specPath);

    const stat = fs.statSync(specPath);
    assert.equal(stat.mode & 0o777, 0o600, 'File should have 0600 permissions');

    const read = readAndDeleteSpec(specPath);
    tmpFiles.pop(); // already deleted
    assert.deepEqual(read, spec);
    assert.ok(!fs.existsSync(specPath), 'File should be deleted after read');
  });
});
