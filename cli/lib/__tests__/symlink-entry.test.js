import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '../../..');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'zylos'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'), ZYLOS_PACKAGE_ROOT: repo };
  delete env.pm_exec_path;
  delete env.TMUX;
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) fs.mkdirSync(env[key], { recursive: true });
  console.log(JSON.stringify({ boundary: 'entry fixture', ...Object.fromEntries(
    ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, env[key]])) }));
  const run = (args, extra = {}) => spawnSync(process.execPath, args, {
    cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000,
  });
  return { root, env, run };
}

// Integration boundary: real CLI entry via temporary symlinks and child
// processes; run for direct-entry changes, skip for unrelated changes. All
// writable paths are private, no tmux/PM2 service starts, and t.after cleans.
for (const [relative, args, status, output] of [
  ['skills/zylos-memory/scripts/memory-status.js', [], 0, /Memory Status/],
  ['skills/zylos-memory/scripts/sync-files.js', ['invalid'], 1, /INVALID_INPUT/],
  ['skills/comm-bridge/scripts/c4-db.js', ['--help'], 0, /c4-db.js: init/],
]) test(`direct and symlink entries execute ${path.basename(relative)}`, t => {
  const f = fixture(t), real = path.join(repo, relative), link = path.join(f.root, 'entry.js');
  fs.symlinkSync(real, link);
  const direct = f.run([real, ...args]), linked = f.run([link, ...args]);
  assert.equal(direct.status, status, direct.stderr);
  assert.match(direct.stdout + direct.stderr, output);
  assert.equal(linked.status, direct.status, linked.stderr);
  assert.equal(linked.stdout, direct.stdout);
  assert.equal(linked.stderr, direct.stderr);
  const imported = f.run(['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(real).href)})`]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout + imported.stderr, '');
});

// Integration boundary: the real Dashboard module/guard runs in a subprocess
// with a temporary database and paths. OS service queries and version checks
// are mocked by the fixture; no server is listened. Run for Dashboard entry
// guard changes; skip otherwise. Child exits and t.after removes its database.
for (const mode of ['argv', 'pm_exec_path']) test(`Dashboard ${mode} symlink selects its smoke entry`, t => {
  const f = fixture(t), real = path.join(repo, 'skills/dashboard/src/index.js');
  const link = path.join(f.root, 'dashboard.js'); fs.symlinkSync(real, link);
  const wrapper = path.join(repo, 'cli/lib/__tests__/fixtures/dashboard-smoke-entry.js');
  const result = mode === 'argv'
    ? f.run(['--experimental-test-module-mocks', '--import', pathToFileURL(wrapper).href, link, '--smoke'])
    : f.run(['--experimental-test-module-mocks', wrapper, '--smoke'], { pm_exec_path: link });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.db.startsWith(`${f.env.ZYLOS_DIR}${path.sep}`), true);
});
