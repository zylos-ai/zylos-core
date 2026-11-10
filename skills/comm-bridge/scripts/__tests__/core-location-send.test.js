import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import Database from '../sqlite-driver.js';

const packageRoot = path.resolve(import.meta.dirname, '../../../..');
const coreRequire = createRequire(path.join(packageRoot, 'package.json'));
const skipped = new Set(['node_modules', '__tests__', 'test', '.git', 'public']);

function copyProduction(from, to) {
  fs.cpSync(from, to, { recursive: true,
    filter: source => !path.relative(from, source).split(path.sep).some(part => skipped.has(part)) });
}

function dependencyRoot(name) {
  let directory = path.dirname(coreRequire.resolve(name));
  while (directory !== path.dirname(directory)) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).name === name) return directory;
    } catch { /* keep walking from the declared dependency's entry point */ }
    directory = path.dirname(directory);
  }
  throw new Error('Cannot locate installed test dependency: ' + name);
}

function fixture(t, searchPath) {
  assert.ok(path.isAbsolute(process.env.TMPDIR ?? ''), 'Use the official runner with a private TMPDIR');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'core-send-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), data = path.join(home, 'zylos');
  const core = path.join(root, 'installed-core'), bridge = path.join(data, '.claude/skills/comm-bridge');
  for (const directory of [core, bridge, path.join(data, '.zylos'), path.join(root, 'tmp'), path.join(root, 'tmux'),
    path.join(home, '.pm2'), path.join(core, 'node_modules')]) fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(path.join(packageRoot, 'package.json'), path.join(core, 'package.json'));
  copyProduction(path.join(packageRoot, 'cli'), path.join(core, 'cli'));
  copyProduction(path.join(packageRoot, 'skills'), path.join(core, 'skills'));
  copyProduction(path.join(packageRoot, 'skills/comm-bridge'), bridge);
  for (const name of Object.keys(JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).dependencies)) {
    fs.symlinkSync(dependencyRoot(name), path.join(core, 'node_modules', name));
  }
  fs.symlinkSync(path.join(core, 'node_modules'), path.join(bridge, 'node_modules'));
  fs.mkdirSync(path.join(bridge, '.zylos'));
  fs.writeFileSync(path.join(bridge, '.zylos/core-package.json'), JSON.stringify({ v: 1, packageRoot: core }));
  fs.writeFileSync(path.join(data, '.zylos/config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'multi' }));
  const component = path.join(data, '.claude/skills/local-fixture');
  fs.mkdirSync(path.join(component, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(component, 'package.json'), '{"type":"module"}');
  const marker = path.join(root, 'received.json');
  fs.writeFileSync(path.join(component, 'scripts/send.js'), `
    import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), runtime: process.execPath }));
  `);
  const env = { ...process.env, HOME: home, ZYLOS_DIR: data, PM2_HOME: path.join(home, '.pm2'),
    TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmux'), PATH: searchPath };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_') || key.startsWith('npm_') ||
        ['ZYLOS_PACKAGE_ROOT', 'ZYLOS_RUN_ID', 'ZYLOS_SESSION_GROUP', 'ZYLOS_SESSION_ID', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID', 'TMUX'].includes(key)) delete env[key];
  }
  const file = path.join(data, 'comm-bridge/c4.db');
  const cli = path.join(bridge, 'scripts/c4-send.js');
  for (const [key, value] of Object.entries({ HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME,
    TMPDIR: env.TMPDIR, TMUX_TMPDIR: env.TMUX_TMPDIR, cli, database: file, core })) {
    assert.ok(value.startsWith(root + path.sep), key + ' must remain in the fixture');
  }
  assert.equal(env.ZYLOS_PACKAGE_ROOT, undefined);
  console.log('Installed send isolation:', JSON.stringify({ node: process.execPath, cli, core, database: file,
    HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR,
    TMUX_TMPDIR: env.TMUX_TMPDIR, PATH: env.PATH, transport: 'local marker only; no network, PM2 or tmux' }));
  return { root, core, bridge, cli, env, marker, file };
}

for (const searchPath of ['/usr/bin:/bin', '']) {
  // Integration boundary: copied production Core/bridge, installation metadata,
  // external-channel child and private C4 SQLite. Run for Core discovery or send
  // child changes; skip unrelated work. The official runner owns temporary
  // HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/private TMUX_TMPDIR; the nested fixture
  // overrides all of them. No live channel, socket or background loop is started.
  // spawnSync waits for completion and has a timeout; fixture cleanup removes all
  // owned files after the child exits, including on failure.
  test('installed send locates Core and dispatches through its absolute runtime with PATH=' + JSON.stringify(searchPath), { timeout: 20000 }, t => {
    const f = fixture(t, searchPath), endpoint = 'local-endpoint', message = 'private fixture message';
    const result = spawnSync(process.execPath, [f.cli, 'local-fixture', endpoint, '--stdin'], {
      env: f.env, cwd: f.root, input: message + '\n', encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL',
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Message sent via local-fixture/);
    const delivered = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
    assert.deepEqual(delivered.args, [endpoint, message]);
    assert.equal(fs.realpathSync(delivered.runtime), fs.realpathSync(process.execPath));
    const db = new Database(f.file, { readonly: true });
    try {
      const rows = db.prepare('SELECT direction, channel, endpoint_id, content, status FROM conversations').all();
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0], { direction: 'out', channel: 'local-fixture', endpoint_id: endpoint,
        content: message, status: 'delivered' });
    } finally { db.close(); }
  });
}
