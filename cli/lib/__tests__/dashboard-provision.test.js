import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { hashPassword } from '../../../skills/dashboard/src/lib/auth.js';

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

test('existing configure stdin accepts a password hash without writing or printing plaintext', t => {
  const root = fixture(t); const password = 'owner-chosen-fixture-password';
  const data = path.join(root, 'components/dashboard');
  const hashed = hashPassword(password);
  const result = spawnSync(process.execPath, [path.join(packageRoot, 'skills/dashboard/hooks/configure.js')], {
    input: JSON.stringify({ DASHBOARD_AUTH_PASSWORD: hashed }), encoding: 'utf8',
    env: { ...process.env, ZYLOS_DATA_DIR: data },
  });
  assert.equal(result.status, 0, result.stderr);
  const bytes = fs.readFileSync(path.join(data, 'config.json'), 'utf8');
  assert.equal(JSON.parse(bytes).auth.password, hashed);
  assert.equal(matchesPassword(password, hashed), true);
  assert.equal(bytes.includes(password), false);
  assert.equal((result.stdout + result.stderr).includes(password), false);
  assert.equal((result.stdout + result.stderr).includes(hashed), false);
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
    assert.equal(startCoreServices(), 1, JSON.stringify({ commands, logs }));
    assert.ok(logs.some(line => line.includes('Dashboard configuration failed')));
    assert.ok(commands.some(command => command.startsWith('pm2 start ')));
    assert.ok(commands.includes('pm2 save'));
  } finally {
    if (previous === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = previous;
  }
});
