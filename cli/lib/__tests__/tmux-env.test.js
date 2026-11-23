import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, describe, it } from 'node:test';

const {
  buildCleanEnv, parseRuntimeEnvManifest,
} = await import('../runtime/tmux-env.js');

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) {
    try { fs.rmSync(tmpDirs.pop(), { recursive: true }); } catch { }
  }
});

// ── parseManifest ──────────────────────────────────────────────────────────

// ── parsePathManifest ─────────────────────────────────────────────────────

// ── parseRuntimeEnvManifest ───────────────────────────────────────────────

describe('parseRuntimeEnvManifest', () => {
  it('parses all four directive types', () => {
    const content = [
      'env TZ',
      'env CLAUDE_CODE_ENABLE_TELEMETRY',
      'inherit SSH_AUTH_SOCK',
      'inherit NVM_DIR',
      'path_prepend /custom/bin',
      'path_append /late/tools',
    ].join('\n');
    const warnings = [];
    const m = parseRuntimeEnvManifest(content, warnings);
    assert.deepEqual(m.envNames, ['TZ', 'CLAUDE_CODE_ENABLE_TELEMETRY']);
    assert.deepEqual(m.inheritNames, ['SSH_AUTH_SOCK', 'NVM_DIR']);
    assert.deepEqual(m.pathPrepend, ['/custom/bin']);
    assert.deepEqual(m.pathAppend, ['/late/tools']);
    assert.equal(warnings.length, 0);
  });

});

// ── loadRuntimeEnvManifest ────────────────────────────────────────────────

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

  it('auto-inherits proxy vars from processEnv', () => {
    const processEnv = { ...baseProcessEnv, HTTP_PROXY: 'http://proxy:8080', https_proxy: 'http://proxy:8443', NODE_USE_ENV_PROXY: '1' };
    const { env } = buildCleanEnv({ processEnv, dotenvVars: {}, platform: 'linux' });
    assert.equal(env.HTTP_PROXY, 'http://proxy:8080');
    assert.equal(env.https_proxy, 'http://proxy:8443');
    assert.equal(env.NODE_USE_ENV_PROXY, '1');
  });

  it('sets IS_SANDBOX when uid is 0 and not in processEnv', () => {
    const { env } = buildCleanEnv({ processEnv: baseProcessEnv, dotenvVars: {}, platform: 'linux', uid: 0 });
    assert.equal(env.IS_SANDBOX, '1');
  });

  it('includes execPath dir in PATH even when processEnv.PATH lacks nvm', () => {
    const { env } = buildCleanEnv({
      processEnv: baseProcessEnv,
      dotenvVars: {},
      platform: 'linux',
      execPath: '/home/testuser/.nvm/versions/node/v22.0.0/bin/node',
    });
    const parts = env.PATH.split(':');
    const execIdx = parts.indexOf('/home/testuser/.nvm/versions/node/v22.0.0/bin');
    const sysIdx = parts.indexOf('/usr/bin');
    assert.ok(execIdx >= 0, 'execPath dir should be in PATH');
    assert.ok(execIdx < sysIdx, 'execPath dir should be before system paths');
  });

  // ── manifest file integration ──────────────────────────────────────────

  it('manifest env injects dotenv value into clean env', () => {
    const manifest = { envNames: ['MY_VAR'], inheritNames: [], pathPrepend: [], pathAppend: [] };
    const dotenvVars = { MY_VAR: 'from_dotenv' };
    const { env } = buildCleanEnv({ processEnv: baseProcessEnv, dotenvVars, manifest, platform: 'linux' });
    assert.equal(env.MY_VAR, 'from_dotenv');
  });

});

// ── buildCompatEnv ─────────────────────────────────────────────────────────

// ── spec file I/O ──────────────────────────────────────────────────────────

// ── deployManifestTemplate ────────────────────────────────────────────────
