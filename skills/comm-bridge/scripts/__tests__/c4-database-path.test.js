import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertTestDatabasePath } from '../c4-database-path.js';

const opener = fileURLToPath(new URL('./fixtures/open-c4-database.js', import.meta.url));

test('the path check identifies the account live directory without opening a database', () => {
  assert.throws(() => assertTestDatabasePath(path.join(os.userInfo().homedir, 'zylos/comm-bridge/c4.db')),
    { code: 'TEST_DATABASE_PATH_UNSAFE' });
});

for (const target of ['live', 'symlink', 'cached', 'stripped']) {
  test(`C4 refuses the ${target} live database path before opening it`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-path-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const accountHome = path.join(root, 'account');
    const live = path.join(accountHome, 'zylos');
    fs.mkdirSync(live, { recursive: true });
    const link = path.join(root, 'live-link');
    if (target === 'symlink') fs.symlinkSync(live, link, 'dir');
    const args = [target === 'symlink' ? link : live, target === 'cached' ? root : '', accountHome];
    // Change the target inside the child, after the runner's launch guard.
    const env = target === 'stripped' ? { HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
      PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR } : process.env;
    const result = spawnSync(process.execPath, [opener, ...args], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /TEST_DATABASE_PATH_UNSAFE/);
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.root, target === 'cached' ? root : args[0]);
    assert.equal(fs.existsSync(path.join(live, 'comm-bridge')), false);
  });
}

test('C4 opens its isolated database with the real schema', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [opener, root], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const opened = JSON.parse(result.stdout);
  assert.equal(opened.path, path.join(root, 'comm-bridge/c4.db'));
  assert.equal(opened.configured, opened.path);
  assert.ok(fs.existsSync(opened.path));
});
