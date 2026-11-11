import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sourceBridge = path.join(packageRoot, 'skills', 'comm-bridge');
const helper = fileURLToPath(new URL('./helpers/chat-core-loader-child.js', import.meta.url));

// Run when the installed Core import/path boundary changes; pure UI or message
// classification changes can skip. Both cases use an owned child process with
// private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR and copied, unmodified production
// scripts. No router, status notification, network, tmux or PM2 is invoked. The
// child calls the default loader and namespace allocator only; its SQLite handle
// is closed before exit, then teardown removes the fixture's own directory.
for (const mode of ['matching', 'mismatched']) {
  test(`default installed Core loading enforces the ${mode} database path`, { timeout: 15000 }, t => {
    assert.ok(!path.resolve(process.env.HOME).startsWith(os.userInfo().homedir + path.sep));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-core-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    const installed = path.join(home, 'zylos');
    const actual = mode === 'matching' ? installed : path.join(root, 'other-zylos');
    const bridge = path.join(installed, '.claude', 'skills', 'comm-bridge');
    for (const directory of [path.join(root, 'tmp'), path.join(root, 'tmux'), path.join(actual, '.zylos'),
      path.join(bridge, 'scripts'), path.join(actual, '.claude', 'skills', 'dashboard')]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(path.join(actual, '.zylos', 'config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'multi' }));
    fs.copyFileSync(path.join(sourceBridge, 'package.json'), path.join(bridge, 'package.json'));
    fs.copyFileSync(path.join(sourceBridge, 'init-db.sql'), path.join(bridge, 'init-db.sql'));
    fs.cpSync(path.join(sourceBridge, 'scripts'), path.join(bridge, 'scripts'), {
      recursive: true, filter: file => !file.split(path.sep).includes('__tests__'),
    });
    fs.symlinkSync(fs.realpathSync(path.join(sourceBridge, 'node_modules')), path.join(bridge, 'node_modules'));
    const env = {
      HOME: home, ZYLOS_DIR: actual, ZYLOS_PACKAGE_ROOT: packageRoot,
      PM2_HOME: path.join(home, '.pm2'), TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmux'),
      PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), LANG: 'C.UTF-8',
    };
    for (const name of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
      assert.ok(env[name].startsWith(root + path.sep), name);
    }
    t.diagnostic(JSON.stringify({ mode, installed, actual, home, tmpdir: env.TMPDIR, pm2Home: env.PM2_HOME }));
    const result = spawnSync(process.execPath, [helper, mode, installed, packageRoot], {
      cwd: root, env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.mode, mode);
    if (mode === 'matching') {
      assert.equal(receipt.namespace, 'dashboard');
      assert.equal(receipt.conversations, 0);
      assert.equal(receipt.heads, 0);
      assert.equal(receipt.receiveImported, true);
      assert.equal(fs.existsSync(path.join(installed, 'comm-bridge', 'c4.db')), true);
    } else {
      assert.equal(receipt.error, 'chat_core_path_mismatch');
      assert.equal(receipt.statusCode, 503);
      assert.equal(fs.existsSync(path.join(installed, 'comm-bridge', 'c4.db')), false);
      assert.equal(fs.existsSync(path.join(actual, 'comm-bridge', 'c4.db')), false);
    }
  });
}
