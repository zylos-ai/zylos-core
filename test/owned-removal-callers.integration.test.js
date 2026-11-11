import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const helper = fileURLToPath(new URL('./helpers/owned-removal-command.js', import.meta.url));

// Real reset/uninstall entry points in bounded child processes. Run for owned
// deletion or caller-root changes; unrelated work can skip these cases. The
// official runner first isolates HOME/ZYLOS_DIR/PM2_HOME and a short TMPDIR.
// Each case then reads back a private root, HOME/ZYLOS_DIR/PM2_HOME/TMPDIR,
// unused private tmux socket and DB paths. Empty PATH prevents real npm, tmux,
// PM2, model or channel invocation. No DB/server is opened; children have a 10s
// timeout and all fixture files are removed by test lifecycle cleanup.
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owned-callers-')));
  const home = path.join(root, 'home'), zylos = path.join(home, 'zylos');
  const env = {
    PATH: path.join(root, 'empty-bin'), HOME: home, ZYLOS_DIR: zylos,
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'),
    TMUX_TMPDIR: path.join(root, 'tmp'), CODEX_HOME: path.join(home, '.codex'),
    ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
  };
  for (const directory of [env.PATH, home, zylos, env.PM2_HOME, env.TMPDIR, env.CODEX_HOME]) fs.mkdirSync(directory, { recursive: true });
  const socket = path.join(root, 'tmux.sock');
  const databases = [path.join(zylos, 'comm-bridge/c4.db'), path.join(zylos, 'components/dashboard/dashboard.db')];
  assert.ok(Buffer.byteLength(socket) < 100);
  for (const directory of [env.PATH, home, zylos, env.PM2_HOME, env.TMPDIR, env.CODEX_HOME]) assert.equal(fs.realpathSync(directory), directory);
  assert.ok(!root.startsWith(fs.realpathSync(os.userInfo().homedir) + path.sep));
  t.diagnostic(JSON.stringify({ root, ...env, socket, databases, NODE_OPTIONS: undefined }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, contents = 'fixture contents') => {
    const filename = path.join(zylos, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, contents); return filename;
  };
  const run = mode => {
    const child = spawnSync(process.execPath, [helper, mode, root], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return { ...JSON.parse(child.stdout.trim().split('\n').at(-1)), output: child.stdout };
  };
  return { root, home, zylos, write, run };
}

for (const linked of [false, true]) {
  test(`managed state reset ${linked ? 'rejects a linked managed directory' : 'removes only the managed directories'}`, { timeout: 15000 }, t => {
    const f = fixture(t);
    for (const file of ['.zylos/config.json', 'components/fixture/data', 'pm2/ecosystem.config.cjs', 'memory/keep.txt', '.env']) f.write(file);
    const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside');
    const skills = path.join(f.zylos, '.claude/skills'); fs.mkdirSync(path.dirname(skills));
    if (linked) fs.symlinkSync(outside, skills); else { fs.mkdirSync(skills); fs.writeFileSync(path.join(skills, 'entry'), 'managed'); }
    const result = f.run('reset');
    assert.equal(result.ok, !linked);
    if (linked) {
      assert.equal(result.code, 'OWNED_TREE_PATH_INVALID');
      assert.equal(fs.existsSync(path.join(f.zylos, '.zylos/config.json')), true);
      assert.equal(fs.lstatSync(skills).isSymbolicLink(), true);
    } else for (const target of ['.claude/skills', '.zylos', 'components', 'pm2']) assert.equal(fs.existsSync(path.join(f.zylos, target)), false);
    assert.equal(fs.readFileSync(path.join(f.zylos, 'memory/keep.txt'), 'utf8'), 'fixture contents');
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside');
  });

  test(`component purge ${linked ? 'rejects a linked component root and preserves registration' : 'removes its skill and data without following interior links'}`, { timeout: 15000 }, t => {
    const f = fixture(t);
    const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside');
    f.write('.zylos/components.json', JSON.stringify({ fixture: { version: '1.0.0' } }));
    f.write('components/fixture/data');
    const skill = path.join(f.zylos, '.claude/skills/fixture'); fs.mkdirSync(path.dirname(skill), { recursive: true });
    if (linked) fs.symlinkSync(outside, skill); else {
      f.write('.claude/skills/fixture/SKILL.md', '---\nname: fixture\nversion: 1.0.0\n---\nPrivate fixture.\n');
      fs.symlinkSync(outside, path.join(skill, 'linked'));
    }
    const result = f.run('component');
    assert.equal(result.ok, !linked);
    const registered = JSON.parse(fs.readFileSync(path.join(f.zylos, '.zylos/components.json'), 'utf8'));
    if (linked) { assert.equal(result.code, 'OWNED_TREE_PATH_INVALID'); assert.ok(registered.fixture); assert.equal(fs.existsSync(path.join(f.zylos, 'components/fixture/data')), true); }
    else { assert.equal(registered.fixture, undefined); assert.equal(fs.existsSync(skill), false); assert.equal(fs.existsSync(path.join(f.zylos, 'components/fixture')), false); }
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside');
  });
}

test('self uninstall removes the private instance and preserves targets of interior links', { timeout: 15000 }, t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside');
  f.write('memory/entry'); fs.symlinkSync(outside, path.join(f.zylos, 'linked'));
  assert.equal(f.run('self').ok, true);
  assert.equal(fs.existsSync(f.zylos), false);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside');
});

test('self uninstall reports a rejected linked instance without touching its destination', { timeout: 15000 }, t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside');
  fs.rmdirSync(f.zylos); fs.symlinkSync(outside, f.zylos);
  const result = f.run('self');
  assert.equal(result.ok, true, 'existing non-fatal warning flow is retained');
  assert.match(result.output, /Could not fully remove/);
  assert.equal(fs.lstatSync(f.zylos).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside');
});

test('component purge rejects a dangling skill link instead of treating it as missing', { timeout: 15000 }, t => {
  const f = fixture(t);
  f.write('.zylos/components.json', JSON.stringify({ fixture: { version: '1.0.0' } }));
  f.write('components/fixture/data');
  const skill = path.join(f.zylos, '.claude/skills/fixture'); fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.symlinkSync(path.join(f.root, 'missing-outside'), skill);
  const result = f.run('component');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OWNED_TREE_PATH_INVALID');
  assert.equal(fs.lstatSync(skill).isSymbolicLink(), true);
  assert.ok(JSON.parse(fs.readFileSync(path.join(f.zylos, '.zylos/components.json'), 'utf8')).fixture);
  assert.equal(fs.existsSync(path.join(f.zylos, 'components/fixture/data')), true);
});
