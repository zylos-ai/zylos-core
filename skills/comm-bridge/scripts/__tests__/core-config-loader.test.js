import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const packageRoot = path.resolve(import.meta.dirname, '../../../..');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'core-loader-paths-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const npmCount = path.join(root, 'npm-count');
  const npmRoot = path.join(root, 'global');
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nprintf "call\\n" >> "$NPM_COUNT"\nprintf "%s\\n" "$NPM_ROOT"\n', { mode: 0o755 });
  const deployed = path.join(root, 'deployed');
  const loader = path.join(deployed, 'skills/comm-bridge/scripts/core-config-loader.js');
  fs.mkdirSync(path.dirname(loader), { recursive: true });
  fs.copyFileSync(new URL('../core-config-loader.js', import.meta.url), loader);
  fs.writeFileSync(path.join(deployed, 'package.json'), '{"type":"module"}');
  const env = { ...process.env, HOME: root, ZYLOS_DIR: path.join(root, 'data'), TMPDIR: root,
    PATH: bin, NPM_COUNT: npmCount, NPM_ROOT: npmRoot };
  delete env.ZYLOS_PACKAGE_ROOT;
  return {
    root, bin, deployed, loader, env, npmRoot,
    count: () => fs.existsSync(npmCount) ? fs.readFileSync(npmCount, 'utf8').trim().split('\n').length : 0,
  };
}

function copyCore(root) {
  fs.mkdirSync(path.join(root, 'cli/lib'), { recursive: true });
  fs.copyFileSync(path.join(packageRoot, 'package.json'), path.join(root, 'package.json'));
  fs.copyFileSync(path.join(packageRoot, 'cli/zylos.js'), path.join(root, 'cli/zylos.js'));
  fs.chmodSync(path.join(root, 'cli/zylos.js'), 0o755);
  for (const file of ['config.js', 'config-store.js', 'config-lock.js']) {
    fs.copyFileSync(path.join(packageRoot, 'cli/lib', file), path.join(root, 'cli/lib', file));
  }
  return root;
}

function writeRecord(fx, record) {
  const file = path.resolve(path.dirname(fx.loader), '../.zylos/core-package.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record));
  return file;
}

function run(fx, source, env = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    const { loadCoreConfig, resolveCoreConfigModule } = await import(${JSON.stringify(pathToFileURL(fx.loader).href)});
    ${source}
  `], { env: { ...fx.env, ...env }, encoding: 'utf8', timeout: 10000 });
}

function assertLoaded(fx, expectedRoot, env) {
  const result = run(fx, `
    assert.equal(resolveCoreConfigModule(), ${JSON.stringify(path.join(expectedRoot, 'cli/lib/config.js'))});
    const modules = await Promise.all(Array.from({ length: 5 }, () => loadCoreConfig()));
    assert.equal(modules[0].CONFIG_FILE, ${JSON.stringify(path.join(fx.env.ZYLOS_DIR, '.zylos/config.json'))});
    assert.equal(modules[0].readZylosConfigStrict().state, 'missing');
    for (const module of modules) assert.equal(module, modules[0]);
  `, env);
  assert.equal(result.status, 0, result.stderr);
}

for (const { title, development, explicit, expected } of [
  { title: 'explicit Core root wins over development and PATH without npm', development: true, explicit: true, expected: 'explicit' },
  { title: 'validated development tree wins over PATH without npm', development: true, expected: 'deployed' },
  { title: 'installed loader resolves a PATH symlink to real Core without npm', expected: 'installed' },
  { title: 'development package identity must match before PATH is selected', development: 'unrelated', expected: 'installed' },
]) test(title, t => {
  const fx = fixture(t);
  const roots = { deployed: fx.deployed, installed: copyCore(path.join(fx.root, 'installed')) };
  if (development) copyCore(roots.deployed);
  if (development === 'unrelated') fs.writeFileSync(path.join(roots.deployed, 'package.json'), '{"type":"module","name":"unrelated"}');
  if (explicit) roots.explicit = copyCore(path.join(fx.root, 'explicit'));
  fs.symlinkSync(path.join(roots.installed, 'cli/zylos.js'), path.join(fx.bin, 'zylos'));
  assertLoaded(fx, roots[expected], explicit ? { ZYLOS_PACKAGE_ROOT: roots.explicit } : undefined);
  assert.equal(fx.count(), 0);
});

test('npm fallback resolves once for concurrent and repeated successful loads', t => {
  const fx = fixture(t);
  copyCore(path.join(fx.npmRoot, 'zylos'));
  const result = run(fx, `
    const modules = await Promise.all(Array.from({ length: 5 }, () => loadCoreConfig()));
    for (const module of modules) assert.equal(module, modules[0]);
    assert.equal(modules[0].readZylosConfigStrict().state, 'missing');
    for (let i = 0; i < 5; i++) assert.equal(resolveCoreConfigModule(), ${JSON.stringify(path.join(fx.npmRoot, 'zylos/cli/lib/config.js'))});
    fs.mkdirSync(${JSON.stringify(path.join(fx.env.ZYLOS_DIR, '.zylos'))}, { recursive: true });
    fs.writeFileSync(modules[0].CONFIG_FILE, '{');
    assert.equal((await loadCoreConfig()).readZylosConfigStrict().state, 'error');
    process.env.PATH = '';
    assert.equal(await loadCoreConfig(), modules[0]);
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fx.count(), 1);
});

test('unrelated PATH package falls back to validated global Core', t => {
  const fx = fixture(t);
  const unrelated = copyCore(path.join(fx.root, 'unrelated'));
  fs.writeFileSync(path.join(unrelated, 'package.json'), '{"type":"module","name":"unrelated"}');
  fs.symlinkSync(path.join(unrelated, 'cli/zylos.js'), path.join(fx.bin, 'zylos'));
  copyCore(path.join(fx.npmRoot, 'zylos'));
  const result = run(fx, `assert.equal((await loadCoreConfig()).CONFIG_FILE, ${JSON.stringify(path.join(fx.env.ZYLOS_DIR, '.zylos/config.json'))});`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fx.count(), 1);
});

test('invalid explicit root rejects without trying valid alternatives', t => {
  const fx = fixture(t);
  copyCore(fx.deployed);
  copyCore(path.join(fx.npmRoot, 'zylos'));
  writeRecord(fx, { v: 1, packageRoot: copyCore(path.join(fx.root, 'recorded')) });
  const result = run(fx, `await assert.rejects(loadCoreConfig(), /Cannot locate.*ZYLOS_PACKAGE_ROOT/);`,
    { ZYLOS_PACKAGE_ROOT: path.join(fx.root, 'absent') });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fx.count(), 0);
});

test('missing Core and invalid global package identity reject and failed resolution retries', t => {
  const fx = fixture(t);
  const result = run(fx, `
    await assert.rejects(loadCoreConfig(), /Cannot locate/);
    await assert.rejects(loadCoreConfig(), /Cannot locate/);
    process.env.ZYLOS_PACKAGE_ROOT = ${JSON.stringify(packageRoot)};
    const recovered = await Promise.all(Array.from({ length: 5 }, () => loadCoreConfig()));
    assert.equal(typeof recovered[0].readZylosConfigOrThrow, 'function');
    for (const module of recovered) assert.equal(module, recovered[0]);
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fx.count(), 2);
  const global = copyCore(path.join(fx.npmRoot, 'zylos'));
  fs.writeFileSync(path.join(global, 'package.json'), '{"type":"module","name":"unrelated"}');
  const invalid = run(fx, `await assert.rejects(loadCoreConfig(), /Cannot locate/);`);
  assert.equal(invalid.status, 0, invalid.stderr);
  assert.equal(fx.count(), 3);
});

for (const [title, development, explicit, expected] of [
  ['explicit root wins over the installation record', false, true, 'explicit'],
  ['development tree wins over the installation record', true, false, 'deployed'],
  ['installation record wins over PATH and npm roots', false, false, 'recorded'],
]) test(title, t => {
  const fx = fixture(t);
  const roots = { recorded: copyCore(path.join(fx.root, 'recorded')),
    installed: copyCore(path.join(fx.root, 'installed')), deployed: fx.deployed };
  writeRecord(fx, { v: 1, packageRoot: roots.recorded });
  if (development) copyCore(roots.deployed);
  if (explicit) roots.explicit = copyCore(path.join(fx.root, 'explicit'));
  fs.symlinkSync(path.join(roots.installed, 'cli/zylos.js'), path.join(fx.bin, 'zylos'));
  copyCore(path.join(fx.npmRoot, 'zylos'));
  assertLoaded(fx, roots[expected], explicit ? { ZYLOS_PACKAGE_ROOT: roots.explicit } : undefined);
  assert.equal(fx.count(), 0);
});

test('minimal PATH resolves the record beside the loader independently of ZYLOS_DIR', t => {
  const fx = fixture(t), core = copyCore(path.join(fx.root, 'recorded'));
  writeRecord(fx, { v: 1, packageRoot: core });
  assertLoaded(fx, core, { PATH: '/usr/bin:/bin' });
  assert.equal(fx.count(), 0);
});

for (const fault of ['missing', 'malformed', 'version', 'relative', 'unrelated', 'stale']) {
  test('invalid installation record preserves PATH and npm fallbacks and actionable failure: ' + fault, t => {
    const fx = fixture(t);
    const recorded = copyCore(path.join(fx.root, 'recorded'));
    if (fault !== 'missing') {
      writeRecord(fx, fault === 'malformed' ? '{' : {
        v: fault === 'version' ? 2 : 1,
        packageRoot: fault === 'relative' ? './recorded' : fault === 'stale' ? path.join(fx.root, 'absent') : recorded,
      });
    }
    if (fault === 'unrelated') fs.writeFileSync(path.join(recorded, 'package.json'), '{"type":"module","name":"unrelated"}');
    const installed = copyCore(path.join(fx.root, 'installed'));
    const executable = path.join(fx.bin, 'zylos');
    fs.symlinkSync(path.join(installed, 'cli/zylos.js'), executable);
    assertLoaded(fx, installed);
    assert.equal(fx.count(), 0);
    fs.unlinkSync(executable);
    const global = copyCore(path.join(fx.npmRoot, 'zylos'));
    assertLoaded(fx, global);
    assert.equal(fx.count(), 1);
    fs.writeFileSync(path.join(global, 'package.json'), '{"type":"module","name":"unrelated"}');
    const result = run(fx, `
      await assert.rejects(loadCoreConfig(), error => {
        assert.match(error.message, /ZYLOS_PACKAGE_ROOT/);
        assert.ok(error.message.includes(${JSON.stringify(path.resolve(path.dirname(fx.loader), '../.zylos/core-package.json'))}));
        assert.ok(error.message.includes('/absolute/path/to/node /absolute/path/to/zylos/cli/zylos.js init'));
        assert.match(error.message, /PATH/);
        return true;
      });
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fx.count(), 2);
  });
}

test('record resolution observes an updated installation without another locator cache', t => {
  const fx = fixture(t), before = copyCore(path.join(fx.root, 'before')), after = copyCore(path.join(fx.root, 'after'));
  const record = writeRecord(fx, { v: 1, packageRoot: before });
  const result = run(fx, `
    assert.equal(resolveCoreConfigModule(), ${JSON.stringify(path.join(before, 'cli/lib/config.js'))});
    fs.writeFileSync(${JSON.stringify(record)}, ${JSON.stringify(JSON.stringify({ v: 1, packageRoot: after }))});
    assert.equal(resolveCoreConfigModule(), ${JSON.stringify(path.join(after, 'cli/lib/config.js'))});
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fx.count(), 0);
});
