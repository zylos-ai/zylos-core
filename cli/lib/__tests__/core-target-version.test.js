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
