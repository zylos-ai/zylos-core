import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve(import.meta.dirname, '../../..');
const hook = path.join(packageRoot, 'skills/dashboard/hooks/post-install.js');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-provision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function matchesPassword(plaintext, stored) {
  const [, salt, expected] = stored.split(':');
  return crypto.scryptSync(plaintext, Buffer.from(salt, 'hex'), 64).equals(Buffer.from(expected, 'hex'));
}

test('new Dashboard auth is independent of Web Console and hook never prints credentials', t => {
  const root = fixture(t);
  const shared = 'web-console-fixture-password';
  fs.writeFileSync(path.join(root, '.env'), `ZYLOS_WEB_PASSWORD=${shared}\n`);
  const run = () => spawnSync(process.execPath, [hook], {
    encoding: 'utf8', env: { ...process.env, ZYLOS_DIR: root, ZYLOS_WEB_PASSWORD: shared },
  });
  const first = run(); assert.equal(first.status, 0, first.stderr);
  const file = path.join(root, 'components/dashboard/config.json');
  const before = fs.readFileSync(file, 'utf8'); const config = JSON.parse(before);
  assert.equal(config.auth.enabled, undefined); assert.match(config.auth.password, /^scrypt:/);
  assert.equal(matchesPassword(shared, config.auth.password), false);
  assert.doesNotMatch(first.stdout + first.stderr, /Dashboard password:|scrypt:|web-console-fixture-password/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const second = run(); assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.doesNotMatch(second.stdout + second.stderr, /Dashboard password:|scrypt:|web-console-fixture-password/);
});

test('PM2 template keeps all Core services in the selected instance and has no dead Dashboard data override', t => {
  const root = fixture(t); const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const template = path.join(packageRoot, 'templates/pm2/ecosystem.config.cjs');
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).apps))', template], {
    encoding: 'utf8', env: { ...process.env, ZYLOS_DIR: root, PATH: bin },
  });
  assert.equal(result.status, 0, result.stderr);
  const apps = JSON.parse(result.stdout);
  assert.equal(apps.some(app => app.name === 'web-console'), false);
  for (const app of apps) assert.ok(app.script.startsWith(path.join(root, '.claude/skills/')), app.name);
  const dashboard = apps.find(app => app.name === 'zylos-dashboard');
  assert.equal(dashboard.env.ZYLOS_DIR, root);
  assert.equal(Object.hasOwn(dashboard.env, 'ZYLOS_DASHBOARD_DATA_DIR'), false);
});

test('component upgrade refuses the Core-managed Dashboard at the CLI entry', t => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, [path.join(packageRoot, 'cli/zylos.js'), 'upgrade', 'dashboard', '--check', '--json', '--upstream-config', 'direct'], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, '.pm2') },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).error, 'core_managed');
});

// CLI integration for registration-only removal and Core-managed refusal.
// Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; each child gets a
// private deployment. Run for uninstall routing changes, skip Dashboard UI work.
for (const registered of [true, false]) test(`component uninstall ${registered ? 'removes residual registration while retaining shared files and data' : 'refuses Core-managed Dashboard without changing registration'}`, t => {
  for (const args of registered ? [
    ['uninstall', 'dashboard', '--check', '--json'],
    ['uninstall', 'dashboard', '--check'],
    ['uninstall', 'dashboard', '--json'],
    ['uninstall', 'dashboard', '--yes', '--json'],
  ] : [
    ['uninstall', 'dashboard', '--yes'],
    ['uninstall', 'dashboard', '--check'],
    ['uninstall', 'dashboard', '--json'],
    ['uninstall', 'dashboard', '--check', '--json'],
  ]) {
    const root = fixture(t), metadata = path.join(root, '.zylos/components.json');
    const skillDir = path.join(root, '.claude/skills/dashboard'), dataDir = path.join(root, 'components/dashboard');
    for (const directory of [path.dirname(metadata), skillDir, dataDir]) fs.mkdirSync(directory, { recursive: true });
    const entries = { telegram: { version: '1.2.3' } };
    if (registered) entries.dashboard = { version: '0.5.5', repo: 'zylos-ai/zylos-dashboard', type: 'declarative', isThirdParty: false,
      installedAt: '2026-11-01T00:00:00.000Z', skillDir, dataDir, source: { type: 'github-release', repo: 'zylos-ai/zylos-dashboard', ref: '0.5.5', refType: 'tag' } };
    fs.writeFileSync(metadata, JSON.stringify(entries));
    const before = fs.readFileSync(metadata, 'utf8');
    fs.writeFileSync(path.join(skillDir, 'retained'), 'Core code');
    fs.writeFileSync(path.join(dataDir, 'retained'), 'owner data');
    const pm2Home = path.join(root, '.pm2');
    const result = spawnSync(process.execPath, [path.join(packageRoot, 'cli/zylos.js'), ...args], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, HOME: root, ZYLOS_DIR: root, PM2_HOME: pm2Home },
    });
    const cancelled = registered && !args.includes('--check') && !args.includes('--yes');
    assert.equal(result.status, registered && !cancelled ? 0 : 1, result.stderr);
    if (args.includes('--json')) {
      const output = JSON.parse(result.stdout);
      if (cancelled) { assert.equal(output.success, false); assert.equal(output.error, 'cancelled'); }
      else if (registered) assert.equal(output.success, true);
      else assert.equal(output.error, 'core_managed');
    } else if (registered) {
      assert.match(result.stdout, /remove standalone Dashboard registration from components\.json/);
      assert.match(result.stdout, /data and built-in Dashboard retained/);
    } else assert.match(result.stderr, /bundled with Core/);
    if (registered && !args.includes('--check') && !cancelled) {
      const after = JSON.parse(fs.readFileSync(metadata, 'utf8'));
      assert.equal(Object.hasOwn(after, 'dashboard'), false); assert.equal(after.telegram.version, '1.2.3');
    } else assert.equal(fs.readFileSync(metadata, 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(skillDir, 'retained'), 'utf8'), 'Core code');
    assert.equal(fs.readFileSync(path.join(dataDir, 'retained'), 'utf8'), 'owner data');
    assert.equal(fs.existsSync(pm2Home), false, 'registration-only CLI must not start PM2');
  }
});

test('upgrade all excludes a registered Core-managed Dashboard before checking components', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.writeFileSync(path.join(root, '.zylos/components.json'), JSON.stringify({ dashboard: { version: '0.6.9' } }));
  const result = spawnSync(process.execPath, [path.join(packageRoot, 'cli/zylos.js'), 'upgrade', '--all', '--check', '--json', '--upstream-config', 'direct'], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, '.pm2') },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.action, 'check_all');
  assert.deepEqual(output.components, []);
});
