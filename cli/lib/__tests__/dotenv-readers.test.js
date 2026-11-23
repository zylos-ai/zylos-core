import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { ZYLOS_DIR } from '../config.js';
import { readEnvFile, writeEnvEntries } from '../env.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-readers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function assertIsolatedEnvironment() {
  const home = fs.realpathSync(process.env.HOME);
  const runnerRoot = path.dirname(home);
  assert.match(path.basename(runnerRoot), /^zylos-tests-[^/]+$/);
  const expected = { HOME: home, ZYLOS_DIR: path.join(home, 'zylos'), PM2_HOME: path.join(home, '.pm2'), TMPDIR: path.join(runnerRoot, 'tmp') };
  for (const [key, target] of Object.entries(expected)) {
    const actual = fs.existsSync(process.env[key]) ? fs.realpathSync(process.env[key]) : path.resolve(process.env[key]);
    assert.equal(actual, target, key);
  }
}

test('environment entry writes recognize exported existing keys and remain append-only', () => {
  const file = path.join(ZYLOS_DIR, '.env');
  assert.equal(fs.existsSync(file), false);
  try {
    fs.writeFileSync(file, 'EXPORTED=first\nexport EXPORTED="last # literal" # comment\n');
    assert.equal(readEnvFile().get('EXPORTED'), 'last # literal');
    const before = fs.readFileSync(file, 'utf8');
    const result = writeEnvEntries({ EXPORTED: 'replacement' }, 'fixture');
    assert.deepEqual(result, { written: [], skipped: ['EXPORTED'] });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { fs.rmSync(file, { force: true }); }
});

// Integration boundary: load the real PM2 template with a fixture instance and
// installed Core on PATH; no PM2, tmux, runtime or database is started. Run when
// template dotenv reads or Core dependency resolution changes; skip otherwise.
// The runner isolates HOME, ZYLOS_DIR, PM2_HOME and TMPDIR before module loading.
for (const deployed of [false, true]) test(`PM2 template reads dotenv from an isolated instance with deployed layout ${deployed}`, t => {
  const root = fixture(t), bin = path.join(root, 'bin');
  const packageRoot = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
  fs.mkdirSync(bin);
  fs.symlinkSync(fileURLToPath(new URL('../../zylos.js', import.meta.url)), path.join(bin, 'zylos'));
  fs.writeFileSync(path.join(root, '.env'), [
    'SYSTEM_PATH=/obsolete', `export SYSTEM_PATH="${bin}:/fixture/saved" # comment`,
    'CLAUDE_BYPASS_PERMISSIONS=true', 'export CLAUDE_BYPASS_PERMISSIONS="false" # comment',
    "export CODEX_BYPASS_PERMISSIONS='false' # comment",
  ].join('\n'));
  const before = { ZYLOS_DIR: process.env.ZYLOS_DIR, PATH: process.env.PATH, ZYLOS_PACKAGE_ROOT: process.env.ZYLOS_PACKAGE_ROOT };
  const require = createRequire(import.meta.url);
  let template = path.join(packageRoot, 'templates/pm2/ecosystem.config.cjs');
  if (deployed) {
    const skill = path.join(root, '.claude/skills/comm-bridge');
    fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(skill, '.zylos'));
    fs.copyFileSync(path.join(packageRoot, 'skills/comm-bridge/scripts/core-config-loader.js'), path.join(skill, 'scripts/core-config-loader.js'));
    fs.copyFileSync(path.join(packageRoot, 'skills/comm-bridge/package.json'), path.join(skill, 'package.json'));
    fs.writeFileSync(path.join(skill, '.zylos/core-package.json'), JSON.stringify({ v: 1, packageRoot }));
    fs.mkdirSync(path.join(root, 'pm2'));
    fs.copyFileSync(template, path.join(root, 'pm2/ecosystem.config.cjs'));
    template = path.join(root, 'pm2/ecosystem.config.cjs');
  }
  try {
    assertIsolatedEnvironment();
    console.log('isolated PM2 template', JSON.stringify({ template, root, home: process.env.HOME, pm2: process.env.PM2_HOME, tmp: process.env.TMPDIR, tmux: 'not used', database: 'not used' }));
    process.env.ZYLOS_DIR = root;
    process.env.PATH = '/bin';
    delete process.env.ZYLOS_PACKAGE_ROOT;
    delete require.cache[template];
    const { apps } = require(template);
    const monitor = apps.find(app => app.name === 'activity-monitor');
    assert.equal(monitor.env.CLAUDE_BYPASS_PERMISSIONS, 'false');
    assert.equal(monitor.env.CODEX_BYPASS_PERMISSIONS, 'false');
    assert.equal(monitor.env.PATH.split(':').includes('/fixture/saved'), true);
    assert.equal(monitor.env.PATH.includes('/obsolete'), false);
    assert.equal(monitor.env.ZYLOS_PACKAGE_ROOT, packageRoot);
  } finally {
    delete require.cache[template];
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
