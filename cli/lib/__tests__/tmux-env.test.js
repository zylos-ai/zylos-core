import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const {
  buildCleanEnv, buildCompatEnv, parseManifest, parsePathManifest,
  parseRuntimeEnvManifest, loadRuntimeEnvManifest, deployManifestTemplate,
  writeLaunchSpec, readAndDeleteSpec,
} = await import('../runtime/tmux-env.js');

const tmpFiles = [];
const tmpDirs = [];
afterEach(() => {
  while (tmpFiles.length) {
    try { fs.unlinkSync(tmpFiles.pop()); } catch { }
  }
  while (tmpDirs.length) {
    try { fs.rmSync(tmpDirs.pop(), { recursive: true }); } catch { }
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

// ── parsePathManifest ─────────────────────────────────────────────────────

describe('parsePathManifest', () => {
  it('parses comma-separated absolute paths', () => {
    const warnings = [];
    assert.deepEqual(
      parsePathManifest('/a/bin,/b/bin', warnings, 'TEST'),
      ['/a/bin', '/b/bin'],
    );
    assert.equal(warnings.length, 0);
  });

  it('returns empty array for empty/null input', () => {
    const warnings = [];
    assert.deepEqual(parsePathManifest('', warnings, 'T'), []);
    assert.deepEqual(parsePathManifest(null, warnings, 'T'), []);
    assert.deepEqual(parsePathManifest(undefined, warnings, 'T'), []);
    assert.equal(warnings.length, 0);
  });

  it('skips relative paths with warning', () => {
    const warnings = [];
    const result = parsePathManifest('/good,foo/bin,also/bad,/ok', warnings, 'MYKEY');
    assert.deepEqual(result, ['/good', '/ok']);
    assert.equal(warnings.length, 2);
    assert.ok(warnings[0].includes('MYKEY'));
    assert.ok(warnings[0].includes('foo/bin'));
    assert.ok(warnings[1].includes('also/bad'));
  });

  it('silently skips empty items', () => {
    const warnings = [];
    assert.deepEqual(
      parsePathManifest('/a, , /b, ', warnings, 'T'),
      ['/a', '/b'],
    );
    assert.equal(warnings.length, 0);
  });
});

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

  it('skips comments and blank lines', () => {
    const content = '# comment\n\n  \nenv TZ\n# another comment\n';
    const m = parseRuntimeEnvManifest(content);
    assert.deepEqual(m.envNames, ['TZ']);
    assert.equal(m.inheritNames.length, 0);
  });

  it('warns on invalid env var name', () => {
    const warnings = [];
    const m = parseRuntimeEnvManifest('env 123bad', warnings);
    assert.equal(m.envNames.length, 0);
    assert.ok(warnings.some(w => w.includes('invalid env var name') && w.includes('123bad')));
  });

  it('warns on relative path in path_prepend', () => {
    const warnings = [];
    const m = parseRuntimeEnvManifest('path_prepend relative/bad', warnings);
    assert.equal(m.pathPrepend.length, 0);
    assert.ok(warnings.some(w => w.includes('relative path') && w.includes('relative/bad')));
  });

  it('warns on unknown directive', () => {
    const warnings = [];
    parseRuntimeEnvManifest('bogus_directive /foo', warnings);
    assert.ok(warnings.some(w => w.includes('unknown directive') && w.includes('bogus_directive')));
  });

  it('warns on missing argument', () => {
    const warnings = [];
    parseRuntimeEnvManifest('env', warnings);
    assert.ok(warnings.some(w => w.includes('missing argument')));
  });

  it('warns on too many tokens', () => {
    const warnings = [];
    parseRuntimeEnvManifest('env TZ extra', warnings);
    assert.ok(warnings.some(w => w.includes('too many tokens')));
  });

  it('returns empty manifest for null/empty content', () => {
    const m1 = parseRuntimeEnvManifest(null);
    assert.deepEqual(m1.envNames, []);
    const m2 = parseRuntimeEnvManifest('');
    assert.deepEqual(m2.envNames, []);
  });
});

// ── loadRuntimeEnvManifest ────────────────────────────────────────────────

describe('loadRuntimeEnvManifest', () => {
  it('loads and parses manifest from .zylos/ subdir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-test-'));
    tmpDirs.push(tmpDir);
    const zylosSubdir = path.join(tmpDir, '.zylos');
    fs.mkdirSync(zylosSubdir);
    fs.writeFileSync(path.join(zylosSubdir, 'runtime-env.manifest'), 'env MY_VAR\npath_prepend /x');
    const m = loadRuntimeEnvManifest(tmpDir);
    assert.deepEqual(m.envNames, ['MY_VAR']);
    assert.deepEqual(m.pathPrepend, ['/x']);
  });

  it('returns empty manifest when file is missing', () => {
    const m = loadRuntimeEnvManifest('/nonexistent/path');
    assert.deepEqual(m.envNames, []);
    assert.deepEqual(m.inheritNames, []);
    assert.deepEqual(m.pathPrepend, []);
    assert.deepEqual(m.pathAppend, []);
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

  it('inherits IS_SANDBOX from processEnv when present', () => {
    const processEnv = { ...baseProcessEnv, IS_SANDBOX: '1' };
    const { env } = buildCleanEnv({ processEnv, dotenvVars: {}, platform: 'linux' });
    assert.equal(env.IS_SANDBOX, '1');
  });

  it('sets IS_SANDBOX when uid is 0 and not in processEnv', () => {
    const { env } = buildCleanEnv({ processEnv: baseProcessEnv, dotenvVars: {}, platform: 'linux', uid: 0 });
    assert.equal(env.IS_SANDBOX, '1');
  });

  it('processEnv IS_SANDBOX takes precedence over uid=0', () => {
    const processEnv = { ...baseProcessEnv, IS_SANDBOX: 'custom' };
    const { env } = buildCleanEnv({ processEnv, dotenvVars: {}, platform: 'linux', uid: 0 });
    assert.equal(env.IS_SANDBOX, 'custom');
  });

  it('does not set IS_SANDBOX for non-root uid', () => {
    const { env } = buildCleanEnv({ processEnv: baseProcessEnv, dotenvVars: {}, platform: 'linux', uid: 1000 });
    assert.equal(env.IS_SANDBOX, undefined);
  });

  it('extracts .nvm paths from processEnv.PATH', () => {
    const processEnv = {
      ...baseProcessEnv,
      PATH: '/home/testuser/.nvm/versions/node/v24.13.1/bin:/usr/bin',
    };
    const { env } = buildCleanEnv({ processEnv, dotenvVars: {}, platform: 'linux' });
    assert.ok(env.PATH.includes('.nvm'), `PATH should include .nvm segment: ${env.PATH}`);
  });

  it('darwin clean PATH includes Homebrew paths', () => {
    const { env } = buildCleanEnv({ processEnv: baseProcessEnv, dotenvVars: {}, platform: 'darwin' });
    const parts = env.PATH.split(':');
    assert.ok(parts.includes('/opt/homebrew/bin'), 'Missing /opt/homebrew/bin');
    assert.ok(parts.includes('/opt/homebrew/sbin'), 'Missing /opt/homebrew/sbin');
    assert.ok(parts.includes('/usr/local/bin'), 'Missing /usr/local/bin');
    assert.ok(parts.includes('/usr/local/sbin'), 'Missing /usr/local/sbin');
  });

  it('non-darwin clean PATH does not include Homebrew paths', () => {
    const { env } = buildCleanEnv({ processEnv: baseProcessEnv, dotenvVars: {}, platform: 'linux' });
    const parts = env.PATH.split(':');
    assert.ok(!parts.includes('/opt/homebrew/bin'), 'Should not have /opt/homebrew/bin on Linux');
    assert.ok(!parts.includes('/opt/homebrew/sbin'), 'Should not have /opt/homebrew/sbin on Linux');
  });

  it('clean env includes GH_PROMPT_DISABLED=1', () => {
    const { env } = buildCleanEnv({ processEnv: baseProcessEnv, dotenvVars: {}, platform: 'linux' });
    assert.equal(env.GH_PROMPT_DISABLED, '1');
  });

  it('PREPEND inserts before platform/system base paths', () => {
    const dotenvVars = { ZYLOS_TMUX_PATH_PREPEND: '/custom/tools,/extra/bin' };
    const { env } = buildCleanEnv({ processEnv: baseProcessEnv, dotenvVars, platform: 'linux' });
    const parts = env.PATH.split(':');
    const customIdx = parts.indexOf('/custom/tools');
    const sysIdx = parts.indexOf('/usr/bin');
    assert.ok(customIdx >= 0, 'PREPEND path missing');
    assert.ok(customIdx < sysIdx, 'PREPEND should be before system paths');
  });

  it('APPEND inserts after system base paths', () => {
    const dotenvVars = { ZYLOS_TMUX_PATH_APPEND: '/late/tools' };
    const { env } = buildCleanEnv({ processEnv: baseProcessEnv, dotenvVars, platform: 'linux' });
    const parts = env.PATH.split(':');
    const lateIdx = parts.indexOf('/late/tools');
    const binIdx = parts.indexOf('/bin');
    assert.ok(lateIdx >= 0, 'APPEND path missing');
    assert.ok(lateIdx > binIdx, 'APPEND should be after /bin');
  });

  it('relative path in PREPEND is skipped with warning', () => {
    const dotenvVars = { ZYLOS_TMUX_PATH_PREPEND: '/ok,relative/bad' };
    const { env, warnings } = buildCleanEnv({ processEnv: baseProcessEnv, dotenvVars, platform: 'linux' });
    const parts = env.PATH.split(':');
    assert.ok(parts.includes('/ok'));
    assert.ok(!parts.includes('relative/bad'));
    assert.ok(warnings.some(w => w.includes('ZYLOS_TMUX_PATH_PREPEND') && w.includes('relative/bad')));
  });

  it('empty PATH manifest does not change PATH', () => {
    const { env: envWith } = buildCleanEnv({ processEnv: baseProcessEnv, dotenvVars: {}, platform: 'linux' });
    const { env: envEmpty } = buildCleanEnv({
      processEnv: baseProcessEnv,
      dotenvVars: { ZYLOS_TMUX_PATH_PREPEND: '', ZYLOS_TMUX_PATH_APPEND: '' },
      platform: 'linux',
    });
    assert.equal(envWith.PATH, envEmpty.PATH);
  });

  it('PREPEND dedupes with system paths preserving first occurrence', () => {
    const dotenvVars = { ZYLOS_TMUX_PATH_PREPEND: '/usr/bin' };
    const { env } = buildCleanEnv({ processEnv: baseProcessEnv, dotenvVars, platform: 'linux' });
    const parts = env.PATH.split(':');
    const firstIdx = parts.indexOf('/usr/bin');
    const lastIdx = parts.lastIndexOf('/usr/bin');
    assert.equal(firstIdx, lastIdx, '/usr/bin should appear only once');
    const localIdx = parts.indexOf('/usr/local/sbin');
    assert.ok(firstIdx < localIdx, '/usr/bin from PREPEND should be before /usr/local/sbin');
  });

  // ── manifest file integration ──────────────────────────────────────────

  it('manifest env injects dotenv value into clean env', () => {
    const manifest = { envNames: ['MY_VAR'], inheritNames: [], pathPrepend: [], pathAppend: [] };
    const dotenvVars = { MY_VAR: 'from_dotenv' };
    const { env } = buildCleanEnv({ processEnv: baseProcessEnv, dotenvVars, manifest, platform: 'linux' });
    assert.equal(env.MY_VAR, 'from_dotenv');
  });

  it('manifest inherit pulls processEnv value into clean env', () => {
    const processEnv = { ...baseProcessEnv, INHERITED_VAR: 'from_process' };
    const manifest = { envNames: [], inheritNames: ['INHERITED_VAR'], pathPrepend: [], pathAppend: [] };
    const { env } = buildCleanEnv({ processEnv, dotenvVars: {}, manifest, platform: 'linux' });
    assert.equal(env.INHERITED_VAR, 'from_process');
  });

  it('manifest path_prepend affects clean PATH order', () => {
    const manifest = { envNames: [], inheritNames: [], pathPrepend: ['/manifest/bin'], pathAppend: [] };
    const { env } = buildCleanEnv({ processEnv: baseProcessEnv, dotenvVars: {}, manifest, platform: 'linux' });
    const parts = env.PATH.split(':');
    const mIdx = parts.indexOf('/manifest/bin');
    const sysIdx = parts.indexOf('/usr/bin');
    assert.ok(mIdx >= 0 && mIdx < sysIdx, 'manifest path_prepend should be before system paths');
  });

  it('manifest path_append goes after system paths', () => {
    const manifest = { envNames: [], inheritNames: [], pathPrepend: [], pathAppend: ['/manifest/late'] };
    const { env } = buildCleanEnv({ processEnv: baseProcessEnv, dotenvVars: {}, manifest, platform: 'linux' });
    const parts = env.PATH.split(':');
    const mIdx = parts.indexOf('/manifest/late');
    const binIdx = parts.indexOf('/bin');
    assert.ok(mIdx > binIdx, 'manifest path_append should be after /bin');
  });

  it('manifest + .env keys merge and dedupe', () => {
    const manifest = { envNames: ['A', 'B'], inheritNames: ['X'], pathPrepend: ['/m'], pathAppend: [] };
    const dotenvVars = { ZYLOS_TMUX_ENV: 'B,C', ZYLOS_TMUX_INHERIT: 'X,Y', A: '1', B: '2', C: '3' };
    const processEnv = { ...baseProcessEnv, X: 'px', Y: 'py' };
    const { env } = buildCleanEnv({ processEnv, dotenvVars, manifest, platform: 'linux' });
    assert.equal(env.A, '1');
    assert.equal(env.B, '2');
    assert.equal(env.C, '3');
    assert.equal(env.X, 'px');
    assert.equal(env.Y, 'py');
    assert.ok(env.PATH.includes('/m'));
  });

  it('manifest env wins over manifest inherit on same var', () => {
    const processEnv = { ...baseProcessEnv, SHARED: 'from_process' };
    const dotenvVars = { SHARED: 'from_dotenv' };
    const manifest = { envNames: ['SHARED'], inheritNames: ['SHARED'], pathPrepend: [], pathAppend: [] };
    const { env } = buildCleanEnv({ processEnv, dotenvVars, manifest, platform: 'linux' });
    assert.equal(env.SHARED, 'from_dotenv');
  });

  it('works without manifest (backward compat)', () => {
    const dotenvVars = { ZYLOS_TMUX_ENV: 'TZ', TZ: 'Asia/Shanghai' };
    const { env } = buildCleanEnv({ processEnv: baseProcessEnv, dotenvVars, platform: 'linux' });
    assert.equal(env.TZ, 'Asia/Shanghai');
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

  it('deduplicates PATH preserving first-occurrence order', () => {
    const processEnv = { PATH: '/a:/b:/a:/c:/b', HOME: '/home/test' };
    const { env } = buildCompatEnv({ processEnv, dotenvVars: {} });
    assert.equal(env.PATH, '/a:/b:/c');
  });

  it('does not inject GH_PROMPT_DISABLED, Homebrew paths, or PATH manifest', () => {
    const processEnv = { PATH: '/usr/bin', HOME: '/home/test' };
    const dotenvVars = {
      ZYLOS_TMUX_PATH_PREPEND: '/custom/pre',
      ZYLOS_TMUX_PATH_APPEND: '/custom/post',
    };
    const { env } = buildCompatEnv({ processEnv, dotenvVars });
    assert.equal(env.GH_PROMPT_DISABLED, undefined);
    assert.ok(!env.PATH.includes('/opt/homebrew'), 'compat mode should not add Homebrew paths');
    assert.ok(!env.PATH.includes('/custom/pre'), 'compat mode should not apply PREPEND');
    assert.ok(!env.PATH.includes('/custom/post'), 'compat mode should not apply APPEND');
  });
});

// ── spec file I/O ──────────────────────────────────────────────────────────

// ── deployManifestTemplate ────────────────────────────────────────────────

describe('deployManifestTemplate', () => {
  it('creates manifest from template when missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-deploy-'));
    tmpDirs.push(tmpDir);
    const templatePath = path.join(tmpDir, 'runtime-env.manifest.example');
    fs.writeFileSync(templatePath, 'env TZ\n');
    const zylosDir = path.join(tmpDir, 'zylos');
    fs.mkdirSync(zylosDir);

    const created = deployManifestTemplate(templatePath, zylosDir);
    assert.equal(created, true);
    const dest = path.join(zylosDir, '.zylos', 'runtime-env.manifest');
    assert.ok(fs.existsSync(dest));
    assert.equal(fs.readFileSync(dest, 'utf8'), 'env TZ\n');
  });

  it('does not overwrite existing manifest', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-deploy-'));
    tmpDirs.push(tmpDir);
    const templatePath = path.join(tmpDir, 'runtime-env.manifest.example');
    fs.writeFileSync(templatePath, 'env NEW_VAR\n');
    const zylosDir = path.join(tmpDir, 'zylos');
    const zylosSubdir = path.join(zylosDir, '.zylos');
    fs.mkdirSync(zylosSubdir, { recursive: true });
    fs.writeFileSync(path.join(zylosSubdir, 'runtime-env.manifest'), 'env USER_CUSTOM\n');

    const created = deployManifestTemplate(templatePath, zylosDir);
    assert.equal(created, false);
    assert.equal(
      fs.readFileSync(path.join(zylosSubdir, 'runtime-env.manifest'), 'utf8'),
      'env USER_CUSTOM\n',
    );
  });

  it('returns false when template does not exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-deploy-'));
    tmpDirs.push(tmpDir);
    const created = deployManifestTemplate('/nonexistent/template', tmpDir);
    assert.equal(created, false);
  });
});

// ── writeLaunchSpec / readAndDeleteSpec ────────────────────────────────────

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
