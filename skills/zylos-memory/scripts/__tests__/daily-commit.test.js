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

test('daily snapshot excludes root/nested tmp including staged files on an unborn branch', t => {
  const f = fixture(t);
  for (const name of ['state.md.token.tmp', 'session-groups/chat/state.md.token.tmp', 'reference/.page.123.tmp', 'staged[1].tmp']) f.write(name, 'unfinished');
  f.write('state.md', 'official state');
  f.write('reference/keep.tmp.md', 'official reference');
  f.git('add', '--', 'staged[1].tmp', 'reference/.page.123.tmp');
  f.run();
  assert.deepEqual(f.git('ls-tree', '-r', '--name-only', 'HEAD').split('\n'), ['reference/keep.tmp.md', 'state.md']);
  assert.equal(f.git('diff', '--cached', '--name-only'), '');
  assert.equal(fs.readFileSync(path.join(f.memory, 'staged[1].tmp'), 'utf8'), 'unfinished');
});

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

for (const staged of [false, true]) {
  test(`daily snapshot commits deletion-only cleanup with ${staged ? 'staged' : 'unstaged'} tracked tmp deletions`, t => {
    const f = fixture(t);
    const removed = ['deleted.tmp', 'reference/deleted[1].tmp'];
    for (const name of [...removed, 'edited.tmp', 'state.md']) f.write(name, 'before');
    f.git('add', '.'); f.git('commit', '-qm', 'baseline');
    const baseline = f.git('rev-parse', 'HEAD');
    for (const name of removed) fs.unlinkSync(path.join(f.memory, name));
    f.write('edited.tmp', 'unfinished replacement');
    f.write('added.tmp', 'unfinished addition');
    if (staged) f.git('add', '-A');

    f.run();
    assert.notEqual(f.git('rev-parse', 'HEAD'), baseline);
    assert.deepEqual(f.git('diff-tree', '--no-commit-id', '--name-status', '-r', 'HEAD').split('\n'),
      removed.map(name => `D\t${name}`));
    assert.deepEqual(f.git('ls-tree', '-r', '--name-only', 'HEAD').split('\n'), ['edited.tmp', 'state.md']);
    assert.equal(f.git('show', 'HEAD:edited.tmp'), 'before');
    assert.equal(f.git('diff', '--cached', '--name-only'), '');
    assert.equal(fs.readFileSync(path.join(f.memory, 'edited.tmp'), 'utf8'), 'unfinished replacement');
    assert.equal(fs.readFileSync(path.join(f.memory, 'added.tmp'), 'utf8'), 'unfinished addition');
    for (const name of removed) assert.equal(fs.existsSync(path.join(f.memory, name)), false);
    assert.match(f.run(), /No memory changes to commit/);
  });
}

test('daily snapshot with only staged tmp creates no commit and preserves worktree', t => {
  const f = fixture(t);
  f.write('only.tmp', 'unfinished'); f.git('add', '.');
  assert.match(f.run(), /No memory changes to commit/);
  assert.equal(f.git('ls-files'), '');
  assert.equal(fs.readFileSync(path.join(f.memory, 'only.tmp'), 'utf8'), 'unfinished');
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: f.memory, encoding: 'utf8' });
  assert.notEqual(head.status, 0);
});
