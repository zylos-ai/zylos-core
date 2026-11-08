import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { AuthGate } from '../src/lib/auth.js';
import { loadConfig } from '../src/lib/config.js';
import { dashboardAccessAddress, printDashboardInfo } from '../../../cli/lib/dashboard-access.js';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const hook = path.join(packageRoot, 'skills/dashboard/hooks/post-install.js');
const cli = path.join(packageRoot, 'cli/zylos.js');

function fixture(t, { running = false, restartFails = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-password-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'instance'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmp') };
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) fs.mkdirSync(env[key], { recursive: true });
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const calls = path.join(root, 'pm2-calls');
  // Only the service boundary is stubbed; password generation/config/CLI/auth run.
  const pm2 = `#!/bin/sh\necho "$*" >> '${calls}'\ncase "$1" in\n  pid) echo "${running ? '42' : '0'}" ;;\n  restart) exit ${restartFails ? 1 : 0} ;;\n  *) exit 1 ;;\nesac\n`;
  fs.writeFileSync(path.join(bin, 'pm2'), pm2, { mode: 0o755 });
  env.PATH = `${bin}:${env.PATH}`;
  return { root, env, calls, config: path.join(env.ZYLOS_DIR, 'components/dashboard/config.json') };
}
function writeConfig(f, config) {
  fs.mkdirSync(path.dirname(f.config), { recursive: true });
  fs.writeFileSync(f.config, JSON.stringify(config));
}
function assertNoPlaintext(directory, password) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) assertNoPlaintext(file, password);
    else if (entry.isFile()) assert.equal(fs.readFileSync(file).includes(Buffer.from(password)), false, file);
  }
}
async function passwordAccepted(zylosDir, password) {
  const previous = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = zylosDir;
  let config;
  try { config = loadConfig(); }
  finally { if (previous === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = previous; }
  const gate = new AuthGate(config, null);
  const server = http.createServer((req, res) => {
    gate.handle(req, res, new URL(req.url, 'http://127.0.0.1')).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/login`, { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }) });
    await response.text();
    return response.status === 302;
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

// Provisioning + official reset CLI + actual loaded-config AuthGate HTTP login.
// Run for credential handoff/reset changes; skip unrelated UI. All filesystem,
// PM2 state, temp/socket locations belong to each fixture; child commands have
// deadlines and no PM2 daemon is contacted. HTTP listeners are closed each call.
for (const repair of [false, true]) {
  test(`generated Dashboard password can log in and reset replaces it (${repair ? 'existing config' : 'fresh config'})`, { timeout: 20_000 }, async t => {
    const f = fixture(t);
    if (repair) writeConfig(f, { port: 3491, extra: 'preserved', auth: { enabled: true } });
    console.log('Password lifecycle isolation:', JSON.stringify({ HOME: f.env.HOME, ZYLOS_DIR: f.env.ZYLOS_DIR,
      PM2_HOME: f.env.PM2_HOME, TMPDIR: f.env.TMPDIR, TMUX_TMPDIR: f.env.TMUX_TMPDIR,
      socket: path.join(f.env.TMUX_TMPDIR, 'default'), config: f.config }));
    const install = () => spawnSync(process.execPath, [hook], { env: { ...f.env, ZYLOS_DASHBOARD_PASSWORD_FD: '3' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: 1024 * 1024 });
    const first = install();
    assert.equal(first.status, 0, first.stderr);
    const { password } = JSON.parse(first.output[3]);
    assert.match(password, /^[a-f0-9]{32}$/);
    assert.equal((first.stdout + first.stderr).includes(password), false);
    assert.equal(await passwordAccepted(f.env.ZYLOS_DIR, password), true);
    const config = JSON.parse(fs.readFileSync(f.config, 'utf8'));
    assert.match(config.auth.password, /^scrypt:/);
    if (repair) { assert.equal(config.port, 3491); assert.equal(config.extra, 'preserved'); }
    assertNoPlaintext(f.root, password);
    const second = install();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.output[3]).password, null, 'repeat install must not redisplay the existing password');
    assert.equal(JSON.parse(fs.readFileSync(f.config, 'utf8')).auth.password, config.auth.password);
    const reset = spawnSync(process.execPath, [cli, 'dashboard', 'reset-password'], {
      env: f.env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
    assert.equal(reset.status, 0, reset.stderr);
    const next = reset.stdout.match(/Password: ([a-f0-9]{32})/)?.[1];
    assert.ok(next);
    assert.notEqual(next, password);
    assert.equal(reset.stdout.split(next).length - 1, 1);
    assert.match(reset.stdout, /takes effect the next time Dashboard starts/);
    assert.doesNotMatch(reset.stdout, /URL:|https?:\/\//);
    assert.equal(await passwordAccepted(f.env.ZYLOS_DIR, password), false);
    assert.equal(await passwordAccepted(f.env.ZYLOS_DIR, next), true);
    assertNoPlaintext(f.root, password); assertNoPlaintext(f.root, next);
    assert.equal(fs.readFileSync(f.calls, 'utf8'), 'pid zylos-dashboard\n');
  });
}

test('Dashboard access reporting selects public route or local port and consumes a new password once', t => {
  const f = fixture(t); writeConfig(f, { port: 3491 });
  fs.mkdirSync(path.join(f.env.ZYLOS_DIR, '.zylos'));
  const core = path.join(f.env.ZYLOS_DIR, '.zylos/config.json');
  fs.writeFileSync(core, JSON.stringify({ domain: 'agent.example.test', protocol: 'https' }));
  assert.deepEqual(dashboardAccessAddress({ zylosDir: f.env.ZYLOS_DIR, routed: true }), { url: 'https://agent.example.test/dashboard/', localOnly: false });
  fs.writeFileSync(core, JSON.stringify({ domain: 'agent.example.test', protocol: 'https', port: 8080 }));
  assert.equal(dashboardAccessAddress({ zylosDir: f.env.ZYLOS_DIR, routed: true }).url, 'http://agent.example.test:8080/dashboard/');
  assert.deepEqual(dashboardAccessAddress({ zylosDir: f.env.ZYLOS_DIR, routed: false }), { url: 'http://127.0.0.1:3491/', localOnly: true });
  const access = { zylosDir: f.env.ZYLOS_DIR, routed: true, password: 'one-time-display' }, output = [];
  printDashboardInfo(access, line => output.push(line));
  printDashboardInfo(access, line => output.push(line));
  assert.equal(output.join('\n').split('one-time-display').length - 1, 1);
  assertNoPlaintext(f.root, 'one-time-display');
});

for (const restartFails of [false, true]) {
  test(`password reset targets only a running Dashboard and ${restartFails ? 'reports restart failure' : 'confirms restart'}`, t => {
    const f = fixture(t, { running: true, restartFails });
    writeConfig(f, { port: 3491, auth: { enabled: true } });
    fs.mkdirSync(path.join(f.env.ZYLOS_DIR, 'bin'));
    fs.mkdirSync(path.join(f.env.ZYLOS_DIR, 'http'));
    fs.mkdirSync(path.join(f.env.ZYLOS_DIR, '.zylos'));
    fs.writeFileSync(path.join(f.env.ZYLOS_DIR, 'bin/caddy'), 'unused');
    fs.writeFileSync(path.join(f.env.ZYLOS_DIR, 'http/Caddyfile'), 'no dashboard route');
    fs.writeFileSync(path.join(f.env.ZYLOS_DIR, '.zylos/config.json'), JSON.stringify({ domain: 'public.example.test' }));
    const reset = spawnSync(process.execPath, [cli, 'dashboard', 'reset-password'], {
      env: f.env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
    assert.equal(reset.status, restartFails ? 2 : 0, reset.stderr);
    const password = reset.stdout.match(/Password: ([a-f0-9]{32})/)?.[1];
    assert.ok(password, 'even a failed restart must show the saved new password once');
    assert.doesNotMatch(reset.stdout, /URL:|public\.example\.test|https?:\/\//);
    assert.equal(reset.stdout.split(password).length - 1, 1);
    assert.equal(reset.stderr.includes(password), false);
    assert.equal(fs.readFileSync(f.calls, 'utf8'), 'pid zylos-dashboard\nrestart zylos-dashboard\n');
    if (restartFails) assert.match(reset.stderr, /restart could not be confirmed/);
    else assert.match(reset.stdout, /Dashboard password updated and Dashboard restarted/);
    assertNoPlaintext(f.root, password);
  });
}
