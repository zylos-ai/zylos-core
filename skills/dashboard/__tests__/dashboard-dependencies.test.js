import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const core = fileURLToPath(new URL('../../../', import.meta.url));
const child = fileURLToPath(new URL('./helpers/dashboard-imports.js', import.meta.url));

// Boundary: real module loading without the removed Web Console. Run when
// Dashboard imports or dependencies change; UI-only style changes can skip it.
test('Dashboard entry points import without the web console installed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-imports-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, 'package');
  fs.mkdirSync(installed);
  fs.copyFileSync(path.join(core, 'package.json'), path.join(installed, 'package.json'));
  const production = file => !['test', '__tests__', 'node_modules'].some(part => file.split(path.sep).includes(part));
  fs.cpSync(path.join(core, 'cli'), path.join(installed, 'cli'), { recursive: true, filter: production });
  for (const name of ['dashboard', 'comm-bridge']) {
    const source = path.join(core, 'skills', name);
    const target = path.join(installed, 'skills', name);
    fs.cpSync(source, target, { recursive: true, filter: production });
    fs.symlinkSync(fs.realpathSync(path.join(source, 'node_modules')), path.join(target, 'node_modules'), 'dir');
  }
  fs.symlinkSync(fs.realpathSync(path.join(core, 'node_modules')), path.join(installed, 'node_modules'), 'dir');
  assert.equal(fs.existsSync(path.join(installed, 'skills/web-console')), false);

  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  const bin = path.join(root, 'bin');
  for (const directory of [home, tmp, bin]) fs.mkdirSync(directory);
  const env = {
    HOME: home,
    ZYLOS_DIR: path.join(home, 'zylos'),
    PM2_HOME: path.join(root, 'pm2'),
    TMPDIR: tmp,
    TMUX_TMPDIR: tmp,
    PATH: bin,
    ZYLOS_PACKAGE_ROOT: installed,
  };
  for (const [key, value] of Object.entries(env)) assert.ok(value.startsWith(root + path.sep), key);
  console.log('Dashboard import isolation:', JSON.stringify({ ...env, tmux: 'not spawned', network: 'blocked' }));
  const result = spawnSync(process.execPath, [child, installed], {
    cwd: root, env, encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(receipt.entry, 'src/index.js');
  assert.ok(receipt.scripts.includes('send.js'));
  assert.ok(receipt.scripts.includes('send-hook.js'));
  assert.ok(receipt.scripts.includes('attachments.js'));
  assert.equal(receipt.webConsolePresent, false);
});
