import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { readUploadLimit, resolveUploadRoot } from '../attachment-utils.js';

const mib = 1024 * 1024;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-limit-'));
  const home = path.join(root, 'home');
  const zylosDir = path.join(home, 'zylos');
  fs.mkdirSync(zylosDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, zylosDir, write: value => fs.writeFileSync(path.join(zylosDir, '.env'), value) };
}

test('upload limit reads only the target dotenv file and accepts safe positive integral values', t => {
  const f = fixture(t);
  for (const value of ['1', '20', '0'.repeat(3) + '7', '8589934591']) {
    f.write(`WEB_CONSOLE_MAX_UPLOAD_MB=${value}\n`);
    assert.equal(readUploadLimit(f.zylosDir), Number(value) * mib);
  }
  f.write('export WEB_CONSOLE_MAX_UPLOAD_MB="23" # target setting\n');
  assert.equal(readUploadLimit(f.zylosDir), 23 * mib);
});

test('missing, unreadable, malformed and overflowing upload limits use twenty MiB', t => {
  const f = fixture(t);
  assert.equal(readUploadLimit(f.zylosDir), 20 * mib);
  assert.equal(readUploadLimit(path.join(f.root, 'missing')), 20 * mib);
  for (const value of ['', '0', '-1', 'abc', '12x', '1.5', 'Infinity', 'NaN', '1e3', '8589934592', '9'.repeat(400)]) {
    f.write(`WEB_CONSOLE_MAX_UPLOAD_MB=${value}\n`);
    assert.equal(readUploadLimit(f.zylosDir), 20 * mib, value);
  }
  fs.rmSync(path.join(f.zylosDir, '.env'));
  fs.mkdirSync(path.join(f.zylosDir, '.env'));
  assert.equal(readUploadLimit(f.zylosDir), 20 * mib);
});

test('custom and default installation roots resolve symlinks before locating configuration', t => {
  const f = fixture(t);
  f.write('WEB_CONSOLE_MAX_UPLOAD_MB=31\n');
  const alias = path.join(f.root, 'alias');
  fs.symlinkSync(f.zylosDir, alias, 'dir');
  assert.equal(resolveUploadRoot({ ZYLOS_DIR: alias, HOME: '/unused' }), fs.realpathSync(f.zylosDir));
  assert.equal(resolveUploadRoot({ HOME: f.home }), fs.realpathSync(f.zylosDir));
  assert.equal(readUploadLimit(alias), 31 * mib);
});

// Three isolated process environments exercise the same parser used by both
// services and the CLI. Run for shared limit/root changes; UI changes may skip.
// Children are synchronous with a timeout and use only this fixture's files;
// there are no DB, HTTP, PM2 or tmux processes.
test('independent process upload variables cannot override the shared target setting', t => {
  const f = fixture(t);
  f.write('WEB_CONSOLE_MAX_UPLOAD_MB=9\n');
  const helper = new URL('../attachment-utils.js', import.meta.url).href;
  const script = `import {readUploadLimit,resolveUploadRoot} from ${JSON.stringify(helper)}; process.stdout.write(String(readUploadLimit(resolveUploadRoot())));`;
  const childEnv = { ...process.env, HOME: f.home, ZYLOS_DIR: f.zylosDir,
    PM2_HOME: path.join(f.home, '.pm2'), TMPDIR: path.join(f.root, 'tmp'), TMUX_TMPDIR: path.join(f.root, 'tmux') };
  fs.mkdirSync(childEnv.TMPDIR);
  fs.mkdirSync(childEnv.TMUX_TMPDIR);
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    assert.ok(childEnv[key].startsWith(f.root + path.sep));
  }
  console.log('Upload-limit child isolation:', JSON.stringify(Object.fromEntries(
    ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR'].map(key => [key, childEnv[key]]))));
  for (const value of ['1', '300', 'not-a-number']) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 10000,
      env: { ...childEnv, WEB_CONSOLE_MAX_UPLOAD_MB: value },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, String(9 * mib));
  }
});
