import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as childProcess from 'node:child_process';

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
  assert.equal(config.auth.enabled, true); assert.match(config.auth.password, /^scrypt:/);
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
  for (const app of apps) assert.ok(app.script.startsWith(path.join(root, '.claude/skills/')), app.name);
  const dashboard = apps.find(app => app.name === 'zylos-dashboard');
  assert.equal(dashboard.env.ZYLOS_DIR, root);
  assert.equal(Object.hasOwn(dashboard.env, 'ZYLOS_DASHBOARD_DATA_DIR'), false);
});

test('Dashboard provisioning failure warns but continues real init Core service orchestration', async t => {
  const root = fixture(t); fs.mkdirSync(path.join(root, '.claude/skills/dashboard/hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'pm2')); fs.writeFileSync(path.join(root, 'pm2/ecosystem.config.cjs'), 'module.exports={apps:[{name:"scheduler"}]}');
  fs.writeFileSync(path.join(root, '.env'), 'ZYLOS_WEB_PASSWORD=fixture\n');
  const commands = []; const logs = [];
  t.mock.module('node:child_process', { namedExports: { ...childProcess,
    execFileSync(command, args) {
      if (args.some(arg => String(arg).endsWith('/dashboard/hooks/post-install.js'))) throw new Error('fixture provisioning failure');
      return JSON.stringify({ success: true });
    },
    execSync(command) {
      commands.push(command);
      if (command === 'pm2 jlist') return JSON.stringify([{ name: 'scheduler', pm2_env: { status: 'online' } }]);
      return '';
    },
  } });
  t.mock.method(console, 'log', text => logs.push(text));
  const previous = process.env.ZYLOS_DIR; process.env.ZYLOS_DIR = root;
  try {
    const { startCoreServices } = await import(`../../commands/init.js?provision=${Date.now()}`);
    assert.equal(await startCoreServices(), 1, JSON.stringify({ commands, logs }));
    assert.ok(logs.some(line => line.includes('Dashboard configuration failed')));
    assert.ok(commands.some(command => command.startsWith('pm2 start ')));
    assert.ok(commands.includes('pm2 save'));
  } finally {
    if (previous === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = previous;
  }
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

test('component info refuses the Core-managed Dashboard before inspecting its files or service', t => {
  const root = fixture(t); const metadata = path.join(root, '.zylos/components.json');
  fs.mkdirSync(path.dirname(metadata), { recursive: true });
  fs.writeFileSync(metadata, JSON.stringify({ dashboard: { version: '0.6.9' } }));
  const before = fs.readFileSync(metadata, 'utf8');
  const result = spawnSync(process.execPath, [path.join(packageRoot, 'cli/zylos.js'), 'info', 'dashboard', '--json'], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, '.pm2') },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).error, 'core_managed');
  assert.equal(fs.readFileSync(metadata, 'utf8'), before);
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

test('PM2 template reserves the Dashboard service name against registered components', t => {
  const root = fixture(t);
  const skillDir = path.join(root, '.claude/skills/fixture');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.writeFileSync(path.join(root, '.zylos/components.json'), JSON.stringify({ fixture: { skillDir } }));
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nservice:\n  name: zylos-dashboard\n  entry: collision.js\n---\n');
  const template = path.join(packageRoot, 'templates/pm2/ecosystem.config.cjs');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const {default: config} = await import(process.argv[1]); process.stdout.write(JSON.stringify(config.apps));', template], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, '.pm2'), PATH: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  const dashboards = JSON.parse(result.stdout).filter(app => app.name === 'zylos-dashboard');
  assert.equal(dashboards.length, 1);
  assert.equal(dashboards[0].script, path.join(root, '.claude/skills/dashboard/src/index.js'));
  assert.match(result.stderr, /conflicts with existing service/);
});
