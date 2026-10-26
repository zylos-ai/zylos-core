import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

// Copy only declared production dependencies, never the source checkout's
// complete node_modules: that would mask accidental imports of skill packages.
function copyDependency(name, fromPackage, targetModules) {
  const require = createRequire(path.join(fromPackage, 'package.json'));
  // Prefer the package manifest so npm packages named like Node built-ins
  // (for example buffer) are copied instead of resolving the built-in module.
  let entry;
  try { entry = require.resolve(`${name}/package.json`); }
  catch { entry = require.resolve(name); }
  let source = path.dirname(entry);
  while (!fs.existsSync(path.join(source, 'package.json')) ||
    JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).name !== name) {
    const parent = path.dirname(source);
    assert.notEqual(parent, source, `Could not locate dependency ${name}`);
    source = parent;
  }
  const destination = path.join(targetModules, name);
  fs.cpSync(source, destination, { recursive: true, filter: entry => path.basename(entry) !== 'node_modules' });
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies || {})) {
    copyDependency(dependency, source, path.join(destination, 'node_modules'));
  }
}

test('packed global CLI starts without installed skill dependencies', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-packed-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.toLowerCase().startsWith('npm_') && !['NODE_PATH', 'NODE_OPTIONS', 'ZYLOS_PACKAGE_ROOT'].includes(key)));
  Object.assign(env, { HOME: root, ZYLOS_DIR: path.join(root, 'home-zylos'),
    npm_config_update_notifier: 'false', npm_config_cache: path.join(root, 'npm-cache'), npm_config_userconfig: path.join(root, 'npmrc'),
    npm_config_globalconfig: path.join(root, 'global-npmrc') });
  fs.writeFileSync(env.npm_config_userconfig, '');
  fs.writeFileSync(env.npm_config_globalconfig, '');
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root],
    { cwd: repo, env, encoding: 'utf8', timeout: 60000 }));
  const prefix = path.join(root, 'prefix');
  const installed = path.join(prefix, 'lib', 'node_modules', 'zylos');
  fs.mkdirSync(installed, { recursive: true });
  execFileSync('tar', ['-xzf', path.join(root, packed[0].filename), '--strip-components=1', '-C', installed]);
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  for (const name of Object.keys(manifest.dependencies || {})) copyDependency(name, repo, path.join(installed, 'node_modules'));
  for (const skill of fs.readdirSync(path.join(installed, 'skills'))) {
    assert.equal(fs.existsSync(path.join(installed, 'skills', skill, 'node_modules')), false, skill);
  }
  const bin = path.join(prefix, 'bin', 'zylos');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.symlinkSync(path.join(installed, manifest.bin.zylos), bin);
  fs.mkdirSync(path.join(env.ZYLOS_DIR, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(env.ZYLOS_DIR, '.zylos', 'config.json'), JSON.stringify({ runtime: 'claude', session: { mode: 'single' } }));
  for (const args of [['--version'], ['init', '--help']]) {
    await t.test(`zylos ${args.join(' ')}`, () => {
      const result = spawnSync(process.execPath, [bin, ...args], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      assert.match(result.stdout, args[0] === '--version' ? new RegExp(manifest.version.replaceAll('.', '\\.')) : /Usage:.*zylos init/);
    });
  }
  await t.test('zylos group runtime get reads the isolated database', () => {
    const result = spawnSync(process.execPath, [bin, 'group', 'runtime', 'get', '--group', 'origin', '--json'],
      { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stdout || result.stderr || result.error?.message);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, true);
    assert.equal(response.data.sessionGroup, 'origin');
    assert.equal(fs.existsSync(path.join(env.ZYLOS_DIR, 'comm-bridge', 'c4.db')), true);
  });
  await t.test('deployed dispatcher loads the installed Core and lazy supervisor client', () => {
    const skill = path.join(env.ZYLOS_DIR, '.claude', 'skills', 'comm-bridge');
    fs.cpSync(path.join(installed, 'skills', 'comm-bridge'), skill, { recursive: true });
    const skillManifest = JSON.parse(fs.readFileSync(path.join(skill, 'package.json'), 'utf8'));
    for (const name of Object.keys(skillManifest.dependencies || {})) {
      copyDependency(name, repo, path.join(skill, 'node_modules'));
    }
    // This is the deployed skill location, not the package's adjacent copy.
    assert.equal(fs.existsSync(path.join(env.ZYLOS_DIR, '.claude', 'cli')), false);
    const scripts = path.join(skill, 'scripts');
    const uri = relative => JSON.stringify(pathToFileURL(path.join(scripts, relative)).href);
    const probe = path.join(root, 'dispatcher-probe.mjs');
    fs.writeFileSync(probe, `
      import assert from 'node:assert/strict';
      const entry = await import(${uri('c4-dispatcher.js')});
      assert.equal(typeof entry.main, 'function');
      const loader = await import(${uri('core-config-loader.js')});
      const { loadCoreModule } = await import(${uri('router/core-modules.js')});
      assert.equal(loader.resolveCoreConfigModule(), ${JSON.stringify(path.join(installed, 'cli/lib/config.js'))});
      assert.equal(await loader.loadCoreConfig(), await loadCoreModule('config.js'));
      const { createDispatcher } = await import(${uri('router/factory.js')});
      const events = [];
      const empty = () => [];
      const dispatcher = createDispatcher({
        db: {
          recoverOrphanRunning: () => ({ requeued: { ids: [] }, ageExpired: { ids: [] }, retryExhausted: { ids: [] } }),
          listPendingSessionGroups: () => [{ sessionGroup: 'probe', headPriority: 0, headId: 1 }],
          getNextPending: filter => filter?.sessionGroups?.includes('probe') ? { id: 1, session_group: 'probe' } : null,
          expirePending: () => false, getDrainFence: () => null,
          resolveSessionLaunchConfig: () => ({ runtime: 'claude', mode: 'default' }),
          expireTimedOutControls: empty, cleanupControlQueue: empty,
          countNonTerminalControls: () => ({ pending: 0 }),
        },
        readSessionMode: () => ({ mode: 'multi' }),
        listGroupTmuxSessions: async () => [],
        readLiveIdentity: async () => ({ present: false }),
        readRuntimeHealth: () => ({ health: 'unavailable' }),
        diagnostics: { diagnostic: (event, fields) => events.push({ event, ...fields }), maintain() {} },
        log() {},
      }, { poolSize: 2 });
      try {
        await dispatcher.initialize();
        for (let i = 0; i < 3; i++) { dispatcher.tick(); await dispatcher.idle(); }
        // The real lazily imported client must reach the isolated missing socket.
        // A broken import is caught by admission as no_reply, not connect_failed.
        assert.ok(events.some(event => event.event === 'wait_health' && event.code === 'connect_failed'), JSON.stringify(events));
      } finally { await dispatcher.stop(); }
      console.log('dispatcher module graph and lazy client loaded');
    `);
    const result = spawnSync(process.execPath, [probe], { cwd: root,
      env: { ...env, PATH: path.dirname(bin), C4_DISPATCHER_DISABLE_MAIN: '1' },
      encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message || ''));
    assert.match(result.stdout, /dispatcher module graph and lazy client loaded/);
  });

});
