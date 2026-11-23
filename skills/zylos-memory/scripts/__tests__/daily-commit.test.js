import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Boundary: real daily snapshot CLI, Git index and commits, without services,
// tmux, network or a database. Run when snapshot filtering/staging changes;
// unrelated Supervisor or UI changes may skip. Use the official Node runner
// for isolation before imports; each child gets its own HOME/ZYLOS_DIR,
// PM2_HOME and TMPDIR below. t.after removes the entire owned fixture tree.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-tmp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), zylos = path.join(root, 'zylos'), memory = path.join(zylos, 'memory');
  fs.mkdirSync(home); fs.mkdirSync(memory, { recursive: true });
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos,
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(env[key].startsWith(root + path.sep));
    fs.mkdirSync(env[key], { recursive: true });
  }
  t.diagnostic(JSON.stringify({ paths: Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, env[key]])),
    tmux: 'unused', database: 'unused' }));
  const git = (...args) => execFileSync('git', args, { cwd: memory, env, encoding: 'utf8' }).trim();
  const write = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(memory, name)), { recursive: true });
    fs.writeFileSync(path.join(memory, name), text);
  };
  const run = () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../daily-commit.js', import.meta.url))], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@local');
  return { memory, git, write, run };
}

test('daily snapshot excludes staged tmp edits and commits tmp deletions with official changes', t => {
  const f = fixture(t);
  for (const name of ['state.md', 'legacy.tmp', 'deleted.tmp']) f.write(name, 'before');
  f.git('add', '.'); f.git('commit', '-qm', 'baseline');
  f.write('legacy.tmp', 'unfinished replacement');
  fs.unlinkSync(path.join(f.memory, 'deleted.tmp'));
  f.write('state.md', 'after');
  f.git('add', '-A');
  f.run();
  assert.equal(f.git('show', 'HEAD:legacy.tmp'), 'before');
  assert.deepEqual(f.git('ls-tree', '-r', '--name-only', 'HEAD').split('\n'), ['legacy.tmp', 'state.md']);
  assert.equal(f.git('show', 'HEAD:state.md'), 'after');
  assert.equal(f.git('diff', '--cached', '--name-only'), '');
  assert.equal(fs.existsSync(path.join(f.memory, 'deleted.tmp')), false);
});
