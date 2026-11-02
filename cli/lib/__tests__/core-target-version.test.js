import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctv-')));
const isolation = {
  HOME: path.join(root, 'home'),
  ZYLOS_DIR: path.join(root, 'zylos'),
  PM2_HOME: path.join(root, 'pm2'),
  TMPDIR: path.join(root, 'tmp'),
  TMUX_TMPDIR: path.join(root, 'tmux'),
  PATH: path.join(root, 'bin'),
  GITHUB_TOKEN: '',
  GH_TOKEN: '',
};
for (const value of Object.values(isolation).filter(Boolean)) fs.mkdirSync(value, { recursive: true });
const savedEnv = Object.fromEntries(Object.keys(isolation).map(key => [key, process.env[key]]));
Object.assign(process.env, isolation);
for (const [key, value] of Object.entries(isolation)) {
  assert.equal(process.env[key], value);
  if (value) assert.ok(fs.realpathSync(value).startsWith(root + path.sep));
}
console.log('Unit import isolation:', JSON.stringify(Object.fromEntries(Object.keys(isolation).map(key => [key, process.env[key]]))));
after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const { checkCoreTargetVersion } = await import('../self-upgrade.js');
const packagePath = path.resolve(import.meta.dirname, '../../../package.json');

function installedVersion(t, current) {
  const readFile = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (file === packagePath) return JSON.stringify({ version: current });
    return readFile.call(this, file, ...args);
  });
}

const precedence = ['alpha', 'alpha.1', 'alpha.beta', 'beta', 'beta.2', 'beta.11', 'rc.1', '']
  .map(prerelease => `1.0.0${prerelease ? `-${prerelease}` : ''}`);
for (let i = 0; i < precedence.length - 1; i++) {
  const current = precedence[i], target = precedence[i + 1];
  test(`SemVer precedence permits ${current} to ${target} and refuses the reverse`, t => {
    installedVersion(t, current);
    assert.deepEqual(checkCoreTargetVersion(target), { success: true, current, latest: target, hasUpdate: true });
    t.mock.restoreAll();
    installedVersion(t, target);
    assert.equal(checkCoreTargetVersion(current).error, 'downgrade_refused');
  });
}

for (const [current, target] of [
  ['1.0.0-9', '1.0.0-alpha'],
  ['1.0.0-alpha', '1.0.0-alpha-1'],
  ['1.0.0-9007199254740992', '1.0.0-9007199254740993'],
  ['9007199254740992.0.0', '9007199254740993.0.0'],
  ['1.0.0-alpha.1', '1.0.0-alpha.1.1'],
]) {
  test(`SemVer identifier ordering permits ${current} to ${target} and refuses the reverse`, t => {
    installedVersion(t, current);
    assert.equal(checkCoreTargetVersion(target).hasUpdate, true);
    t.mock.restoreAll();
    installedVersion(t, target);
    assert.equal(checkCoreTargetVersion(current).error, 'downgrade_refused');
  });
}

for (const [current, target] of [
  ['1.0.0+source.1', '1.0.0+target.2'],
  ['1.0.0-alpha.1+source', '1.0.0-alpha.1+target'],
  ['1.0.0+build', '1.0.0'],
]) {
  test(`build metadata preserves version equality: ${current} and ${target}`, t => {
    installedVersion(t, current);
    assert.deepEqual(checkCoreTargetVersion(target), { success: true, current, latest: target, hasUpdate: false });
  });
}

for (const target of [
  ' 1.0.0', '1.0.0 ', '1.0.0\n', '1.0.0\r\n',
  '01.0.0', '1.01.0', '1.0.01', '1.0.0-01',
  '1.0.0-alpha..1', '1.0.0-', '1.0.0+', '1.0.0+build..1',
]) {
  test(`malformed SemVer is rejected: ${JSON.stringify(target)}`, t => {
    installedVersion(t, '0.9.3');
    const result = checkCoreTargetVersion(target);
    assert.equal(result.success, false);
    assert.equal(result.error, 'invalid_version');
    assert.match(result.message, /--version 1\.0\.0/);
  });
}
