import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const {
  loadRuntimeSecrets, applySecrets, PROTECTED_NAMES, SECRETS_SUBDIR,
} = await import('../runtime/secret-store.js');
const { buildCleanEnv, buildCompatEnv } = await import('../runtime/tmux-env.js');

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) {
    try { fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { }
  }
});

/** Build a throwaway ZYLOS_DIR containing the given credential files. */
function makeStore(files = {}, { mode = 0o600 } = {}) {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-secret-'));
  tmpDirs.push(zylosDir);
  const dir = path.join(zylosDir, SECRETS_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const f = path.join(dir, name);
    fs.writeFileSync(f, content);
    fs.chmodSync(f, mode);
  }
  return zylosDir;
}

describe('loadRuntimeSecrets', () => {
  it('loads one credential per file, keyed by filename', () => {
    const zylosDir = makeStore({ GH_TOKEN: 'ghp_abc123', LARK_APP_SECRET: 's3cr3t' });
    const { secrets, names, warnings } = loadRuntimeSecrets({ zylosDir });
    assert.deepEqual(secrets, { GH_TOKEN: 'ghp_abc123', LARK_APP_SECRET: 's3cr3t' });
    assert.deepEqual(names, ['GH_TOKEN', 'LARK_APP_SECRET']);
    assert.deepEqual(warnings, []);
  });

  it('strips exactly one trailing newline (echo secret > FILE)', () => {
    const zylosDir = makeStore({ A: 'value\n', B: 'value\n\n', C: 'value' });
    const { secrets } = loadRuntimeSecrets({ zylosDir });
    assert.equal(secrets.A, 'value');
    assert.equal(secrets.B, 'value\n', 'only the final newline is stripped');
    assert.equal(secrets.C, 'value');
  });

  it('missing directory is normal, not a warning', () => {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-nosecret-'));
    tmpDirs.push(zylosDir);
    const { secrets, warnings } = loadRuntimeSecrets({ zylosDir });
    assert.deepEqual(secrets, {});
    assert.deepEqual(warnings, []);
  });

  it('refuses protected names so a credential drop cannot hijack PATH', () => {
    const zylosDir = makeStore({ PATH: '/tmp/evil', LD_PRELOAD: '/tmp/x.so', GH_TOKEN: 'ok' });
    const { secrets, warnings } = loadRuntimeSecrets({ zylosDir });
    assert.deepEqual(Object.keys(secrets), ['GH_TOKEN']);
    assert.equal(warnings.filter(w => w.includes('protected')).length, 2);
  });

  it('skips invalid variable names and reports them', () => {
    const zylosDir = makeStore({ 'not-a-var': 'x', '9NOPE': 'y', OK_VAR: 'z' });
    const { secrets, warnings } = loadRuntimeSecrets({ zylosDir });
    assert.deepEqual(Object.keys(secrets), ['OK_VAR']);
    assert.equal(warnings.filter(w => w.includes('not a valid environment variable name')).length, 2);
  });

  it('skips empty files and dotfiles', () => {
    const zylosDir = makeStore({ EMPTY: '', '.keep': 'x', REAL: 'v' });
    const { secrets, warnings } = loadRuntimeSecrets({ zylosDir });
    assert.deepEqual(Object.keys(secrets), ['REAL']);
    assert.ok(warnings.some(w => w.includes('EMPTY') && w.includes('empty')));
    assert.ok(!warnings.some(w => w.includes('.keep')), 'dotfiles are ignored silently');
  });

  it('warns when a credential is readable beyond its owner but still loads it', () => {
    const zylosDir = makeStore({ LOOSE: 'v' }, { mode: 0o644 });
    const { secrets, warnings } = loadRuntimeSecrets({ zylosDir });
    assert.equal(secrets.LOOSE, 'v', 'availability beats tidiness — never drop a usable credential');
    assert.ok(warnings.some(w => w.includes('LOOSE') && w.includes('0600')));
  });

  it('reports a rejection rather than failing silently', () => {
    // A silently-dropped credential is indistinguishable from "tool not
    // configured", which is a terrible way to discover a typo.
    const zylosDir = makeStore({ 'GH TOKEN': 'x' });
    const { secrets, warnings } = loadRuntimeSecrets({ zylosDir });
    assert.deepEqual(secrets, {});
    assert.equal(warnings.length, 1);
  });
});

describe('applySecrets', () => {
  it('applies values and returns the names applied', () => {
    const env = { PATH: '/usr/bin' };
    const { applied } = applySecrets(env, { B_TOKEN: '2', A_TOKEN: '1' });
    assert.deepEqual(applied, ['A_TOKEN', 'B_TOKEN']);
    assert.equal(env.A_TOKEN, '1');
  });

  it('never overwrites a protected var even if one reaches it', () => {
    const env = { PATH: '/usr/bin', HOME: '/home/me' };
    const { applied, skipped } = applySecrets(env, { PATH: '/evil', HOME: '/evil', OK: 'v' });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/me');
    assert.deepEqual(applied, ['OK']);
    assert.deepEqual(skipped, ['HOME', 'PATH']);
  });

  it('tolerates absent secrets', () => {
    const env = {};
    assert.deepEqual(applySecrets(env, undefined).applied, []);
    assert.deepEqual(env, {});
  });

  it('PROTECTED_NAMES covers the vars that control command resolution', () => {
    for (const n of ['PATH', 'HOME', 'SHELL', 'LD_PRELOAD', 'NODE_OPTIONS']) {
      assert.ok(PROTECTED_NAMES.has(n), `${n} must be protected`);
    }
  });
});

describe('env assembly with secrets', () => {
  const base = { processEnv: { HOME: '/home/me', PATH: '/usr/bin' }, dotenvVars: {} };

  it('clean env: a delivered credential wins over a same-named .env value', () => {
    const { env } = buildCleanEnv({
      ...base,
      dotenvVars: { ZYLOS_TMUX_ENV: 'GH_TOKEN', GH_TOKEN: 'from-dotenv' },
      secrets: { GH_TOKEN: 'from-secret-store' },
    });
    assert.equal(env.GH_TOKEN, 'from-secret-store');
  });

  it('clean env: reports refused protected secrets in warnings', () => {
    const { env, warnings, secretNames } = buildCleanEnv({ ...base, secrets: { PATH: '/evil', T: 'v' } });
    assert.notEqual(env.PATH, '/evil');
    assert.deepEqual(secretNames, ['T']);
    assert.ok(warnings.some(w => w.includes('PATH') && w.includes('protected')));
  });

  it('compat env also receives credentials', () => {
    // ZYLOS_CLEAN_ENV=false must not silently opt a host out of credentials.
    const { env, secretNames } = buildCompatEnv({ ...base, secrets: { GH_TOKEN: 'v' } });
    assert.equal(env.GH_TOKEN, 'v');
    assert.deepEqual(secretNames, ['GH_TOKEN']);
  });

  it('no secrets: env assembly is unchanged', () => {
    const { env, secretNames } = buildCleanEnv({ ...base });
    assert.deepEqual(secretNames, []);
    assert.equal(env.HOME, '/home/me');
    assert.ok(env.PATH.includes('/usr/bin'));
  });
});
