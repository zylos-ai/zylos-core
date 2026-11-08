import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const SCRYPT_KEYLEN = 64;

function verifyScrypt(plaintext, stored) {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (expected.length !== SCRYPT_KEYLEN) return false;
  const actual = crypto.scryptSync(plaintext, salt, SCRYPT_KEYLEN);
  return crypto.timingSafeEqual(expected, actual);
}

function freshTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'postinstall-test-'));
}

function runPostInstall(zylosDir, extraEnv = {}) {
  const scriptPath = new URL('../hooks/post-install.js', import.meta.url).pathname;
  const homeDir = extraEnv.HOME || path.join(zylosDir, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  return execFileSync('node', [scriptPath], {
    env: { ...process.env, HOME: homeDir, ZYLOS_DIR: zylosDir, ZYLOS_RUNTIME: 'claude', ...extraEnv },
    encoding: 'utf8'
  });
}

function configPath(tmpDir) {
  return path.join(tmpDir, 'components', 'dashboard', 'config.json');
}

test('post-install — fresh install generates secure config', () => {
  const tmpDir = freshTmpDir();
  const stdout = runPostInstall(tmpDir);
  const config = JSON.parse(fs.readFileSync(configPath(tmpDir), 'utf8'));

  assert.equal(config.auth.enabled, true);
  assert.ok(config.auth.password.startsWith('scrypt:'), 'password must be scrypt hash');
  assert.deepEqual(config.observer, { enabled: false });
  assert.equal(fs.existsSync(path.join(tmpDir, 'components', 'dashboard', 'observer')), false,
    'default install must not download or stage Observer artifacts');

  const parts = config.auth.password.split(':');
  assert.equal(parts.length, 3);
  assert.equal(Buffer.from(parts[1], 'hex').length, 32, 'salt must be 32 bytes');
  assert.equal(Buffer.from(parts[2], 'hex').length, SCRYPT_KEYLEN, 'hash must be 64 bytes');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('post-install — does not print credentials or reuse Web Console authentication', () => {
  const tmpDir = freshTmpDir();
  const shared = 'web-console-fixture-password';
  fs.writeFileSync(path.join(tmpDir, '.env'), `ZYLOS_WEB_PASSWORD=${shared}\n`);
  const stdout = runPostInstall(tmpDir, { ZYLOS_WEB_PASSWORD: shared });
  assert.doesNotMatch(stdout, /Dashboard password:|[a-f0-9]{32}|scrypt:/);
  assert.equal(stdout.includes(shared), false);
  const config = JSON.parse(fs.readFileSync(configPath(tmpDir), 'utf8'));
  assert.equal(verifyScrypt(shared, config.auth.password), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('post-install — config has no unused fields', () => {
  const tmpDir = freshTmpDir();
  runPostInstall(tmpDir);
  const config = JSON.parse(fs.readFileSync(configPath(tmpDir), 'utf8'));

  assert.equal(config.theme, undefined, 'theme must not be present');
  assert.equal(config.refreshMs, undefined, 'refreshMs must not be present');
  assert.equal(config.retention, undefined, 'retention must not be present');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('post-install — does not overwrite existing config', () => {
  const tmpDir = freshTmpDir();
  runPostInstall(tmpDir);
  const before = fs.readFileSync(configPath(tmpDir), 'utf8');
  runPostInstall(tmpDir);
  const after = fs.readFileSync(configPath(tmpDir), 'utf8');
  assert.equal(before, after, 'existing config must not be overwritten');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('post-install — never downloads or changes an existing Observer installation state', () => {
  const tmpDir = freshTmpDir();
  const dashboardDir = path.dirname(configPath(tmpDir));
  fs.mkdirSync(dashboardDir, { recursive: true });
  const existing = {
    auth: { enabled: false },
    observer: { enabled: true, generation: 9, installedVersion: 'older' },
  };
  fs.writeFileSync(configPath(tmpDir), `${JSON.stringify(existing, null, 2)}\n`);
  runPostInstall(tmpDir);
  const saved = JSON.parse(fs.readFileSync(configPath(tmpDir), 'utf8'));
  assert.match(saved.auth.password, /^scrypt:/);
  delete saved.auth.password;
  assert.deepEqual(saved, existing);
  assert.equal(fs.existsSync(path.join(dashboardDir, 'observer')), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

for (const auth of [undefined, { enabled: true }, { enabled: true, password: null },
  { enabled: true, password: '', allowUrlTokenOnLocalhost: false }]) {
  test(`post-install repairs a missing password while preserving configured fields (${JSON.stringify(auth)})`, t => {
    const tmpDir = freshTmpDir();
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const existing = { port: 3491, host: '127.0.0.1', observer: { enabled: true }, custom: 'preserved',
      ...(auth ? { auth } : {}) };
    fs.mkdirSync(path.dirname(configPath(tmpDir)), { recursive: true });
    fs.writeFileSync(configPath(tmpDir), JSON.stringify(existing));
    const output = runPostInstall(tmpDir);
    const bytes = fs.readFileSync(configPath(tmpDir), 'utf8');
    const saved = JSON.parse(bytes);
    assert.match(saved.auth.password, /^scrypt:[a-f0-9]{64}:[a-f0-9]{128}$/);
    assert.equal(saved.auth.enabled, true);
    assert.equal(fs.statSync(configPath(tmpDir)).mode & 0o777, 0o600);
    assert.doesNotMatch(output, /scrypt:|[a-f0-9]{32}/);
    delete saved.auth.password;
    const expected = { ...existing, auth: { enabled: true, ...auth } };
    delete expected.auth.password;
    assert.deepEqual(saved, expected);
    runPostInstall(tmpDir);
    assert.equal(fs.readFileSync(configPath(tmpDir), 'utf8'), bytes, 'second install must retain the repaired password');
  });
}

test('post-install — leaves both runtime hooks and custom statusLine untouched', () => {
  const tmpDir = freshTmpDir();
  for (const rel of ['.claude/settings.json','.codex/hooks.json']) {
    const file=path.join(tmpDir,rel);fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,JSON.stringify({hooks:{Stop:[{hooks:[{command:'third-party'}]}]},statusLine:{command:'custom'}}));
  }
  const before=['.claude/settings.json','.codex/hooks.json'].map(rel=>fs.readFileSync(path.join(tmpDir,rel),'utf8'));
  runPostInstall(tmpDir,{ZYLOS_RUNTIME:'codex'});
  for (const [i,rel] of ['.claude/settings.json','.codex/hooks.json'].entries()) assert.equal(fs.readFileSync(path.join(tmpDir,rel),'utf8'),before[i]);
  fs.rmSync(tmpDir,{recursive:true,force:true});
});
