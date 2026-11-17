import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Real daily snapshot CLI and git, entirely inside temporary HOME/ZYLOS_DIR.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-tmp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), zylos = path.join(root, 'zylos'), memory = path.join(zylos, 'memory');
  fs.mkdirSync(home); fs.mkdirSync(memory, { recursive: true });
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
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

test('daily snapshot leaves staged tmp edits/deletions at HEAD and commits official changes', t => {
  const f = fixture(t);
  for (const name of ['state.md', 'legacy.tmp', 'deleted.tmp']) f.write(name, 'before');
  f.git('add', '.'); f.git('commit', '-qm', 'baseline');
  f.write('legacy.tmp', 'unfinished replacement');
  fs.unlinkSync(path.join(f.memory, 'deleted.tmp'));
  f.write('state.md', 'after');
  f.git('add', '-A');
  f.run();
  assert.equal(f.git('show', 'HEAD:legacy.tmp'), 'before');
  assert.equal(f.git('show', 'HEAD:deleted.tmp'), 'before');
  assert.equal(f.git('show', 'HEAD:state.md'), 'after');
  assert.equal(f.git('diff', '--cached', '--name-only'), '');
  assert.equal(fs.existsSync(path.join(f.memory, 'deleted.tmp')), false);
});

test('daily snapshot with only staged tmp creates no commit and preserves worktree', t => {
  const f = fixture(t);
  f.write('only.tmp', 'unfinished'); f.git('add', '.');
  assert.match(f.run(), /No memory changes to commit/);
  assert.equal(f.git('ls-files'), '');
  assert.equal(fs.readFileSync(path.join(f.memory, 'only.tmp'), 'utf8'), 'unfinished');
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: f.memory, encoding: 'utf8' });
  assert.notEqual(head.status, 0);
});
