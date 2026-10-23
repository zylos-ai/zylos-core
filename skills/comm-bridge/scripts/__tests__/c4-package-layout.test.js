import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const scripts = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = path.resolve(scripts, '../../..');

// Stage the global package layout without npm install or touching the host's
// prefix. npm itself is real: both this check and the loader run npm root -g.
// Dependency symlinks reuse the checkout's already-present dependencies; this
// validates resolution/wiring, not npm package contents or fresh installation.
function fixture(t, { core = true, config = '{}' } = {}) {
  // Keep the basename short for tmux's Unix socket path limit on macOS.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4p-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const prefix = path.join(root, 'npm-prefix');
  const skill = path.join(home, '.claude/skills/comm-bridge');
  const copied = path.join(skill, 'scripts');
  fs.mkdirSync(path.join(home, '.zylos'), { recursive: true });
  fs.mkdirSync(prefix);
  fs.writeFileSync(path.join(home, '.zylos/config.json'), config);
  fs.cpSync(scripts, copied, {
    recursive: true,
    filter: source => !['__tests__', 'diagnostics'].includes(path.basename(source)),
  });
  fs.copyFileSync(path.resolve(scripts, '../package.json'), path.join(skill, 'package.json'));
  fs.copyFileSync(path.resolve(scripts, '../init-db.sql'), path.join(skill, 'init-db.sql'));
  fs.symlinkSync(path.resolve(scripts, '../node_modules'), path.join(skill, 'node_modules'), 'dir');
  const env = {
    PATH: process.env.PATH, HOME: home, ZYLOS_DIR: home,
    TMUX_TMPDIR: root, LANG: 'en_US.UTF-8', npm_config_prefix: prefix,
  };
  assert.equal(Object.hasOwn(env, 'ZYLOS_PACKAGE_ROOT'), false);
  const npm = spawnSync('npm', ['root', '-g'], { env, cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(npm.status, 0, `${npm.stderr}\n${npm.error ?? ''}`);
  const globalRoot = npm.stdout.trim();
  assert.equal(globalRoot, path.join(prefix, 'lib/node_modules'));
  const packageRoot = path.join(globalRoot, 'zylos');
  if (core) {
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, 'package.json'), path.join(packageRoot, 'package.json'));
    fs.cpSync(path.join(sourceRoot, 'cli'), path.join(packageRoot, 'cli'), { recursive: true });
    // Core's session-group-paths imports its bundled comm-bridge, so retain both
    // the package's copy and the independently deployed skill copy.
    fs.cpSync(skill, path.join(packageRoot, 'skills/comm-bridge'), { recursive: true });
    fs.symlinkSync(path.join(sourceRoot, 'node_modules'), path.join(packageRoot, 'node_modules'), 'dir');
  }
  // The development-checkout candidate must not accidentally satisfy the test.
  assert.equal(fs.existsSync(path.resolve(copied, '../../../cli/lib/config.js')), false);
  const url = name => JSON.stringify(pathToFileURL(path.join(copied, name)).href);
  function run(args, expected = 0) {
    const r = spawnSync(process.execPath, args, { env, cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, expected, `${r.stdout}\n${r.stderr}\n${r.error ?? ''}`);
    return r;
  }
  function evaluate(code, expected) {
    // A real module entry also lets worker_threads inherit valid execArgv.
    const entry = path.join(root, 'probe.mjs');
    fs.writeFileSync(entry, code);
    return run([entry], expected);
  }
  const db = code => JSON.parse(evaluate(`const db = await import(${url('c4-db.js')}); try { ${code} } finally { db.close(); }`).stdout);
  return { home, copied, packageRoot, url, run, evaluate, db };
}

test('copied skill uses actual npm root -g fallback and real strict F1', t => {
  const f = fixture(t, { config: '{"runtime":"codex","session_mode":"multi"}' });
  const resolved = JSON.parse(f.evaluate(`const loader = await import(${f.url('core-config-loader.js')}); const core = await loader.loadCoreConfig(); console.log(JSON.stringify({path:loader.resolveCoreConfigModule(), mode:core.readSessionMode()}));`).stdout);
  assert.equal(resolved.path, path.join(f.packageRoot, 'cli/lib/config.js'));
  assert.deepEqual(resolved.mode, { mode: 'multi', keyPresent: true });
  assert.deepEqual(f.db("console.log(JSON.stringify(db.resolveSessionLaunchConfig({sessionGroup:'origin',sessionMode:'single'})))"), { runtime: 'codex', mode: 'default' });
});

test('npm fallback strict F1 rejects corruption without inserting control work', t => {
  const f = fixture(t);
  f.db("console.log(JSON.stringify(db.insertControl('before',{appendAckSuffix:false})))");
  fs.writeFileSync(path.join(f.home, '.zylos/config.json'), '{broken');
  const result = f.evaluate(`try { const db = await import(${f.url('c4-db.js')}); try { db.insertControl('forbidden'); } finally { db.close(); } } catch(e) { console.log(JSON.stringify({code:e.code})); }`);
  assert.equal(JSON.parse(result.stdout).code, 'CONFIG_UNREADABLE');
  fs.writeFileSync(path.join(f.home, '.zylos/config.json'), '{}');
  assert.deepEqual(f.db("console.log(JSON.stringify(db.getDb().prepare('SELECT raw_content FROM control_queue').all()))"), [{ raw_content: 'before' }]);
});

test('copied runtime CLI resolves npm Core and observes an isolated no-server target', t => {
  const f = fixture(t);
  const r = f.run([path.join(f.copied, 'c4-runtime-config.js'), 'set', '--group', 'origin', '--runtime', 'codex', '--json']);
  const output = JSON.parse(r.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.data.changed, true);
  assert.equal(output.data.resolved.runtime, 'claude');
  assert.equal(output.data.running.status, 'single_native', JSON.stringify(output));
  const observed = JSON.parse(f.evaluate(`const observer = await import(${f.url('c4-runtime-observer.js')}); console.log(JSON.stringify(observer.observeCoreRunning({sessionGroup:'origin',sessionMode:'single'})));`).stdout);
  assert.deepEqual(observed, { hasProcess: false });
});

test('copied skill fails closed when temporary npm prefix has no Core package', t => {
  const f = fixture(t, { core: false });
  const r = f.evaluate(`await import(${f.url('c4-db.js')});`, 1);
  assert.match(r.stderr, /Cannot locate the installed zylos-core cli\/lib\/config\.js/);
  assert.equal(fs.existsSync(path.join(f.home, 'comm-bridge/c4.db')), false);
});
