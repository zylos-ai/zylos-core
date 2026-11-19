import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isolateInstanceObservations } from './fixtures/object-instance-observations.js';
import { generateRouteBlocks } from '../../../cli/lib/caddy.js';
import { VersionChecker } from '../src/lib/version-checker.js';

// Opt in only in a separate OS account/container. Real browser fetch -> generated
// Caddy reverse proxy -> actual Dashboard route -> private fake agy (65 seconds).
// Run with ZYLOS_UPGRADE_INTEGRATION=1 when changing upgrade execution/deadlines,
// the upgrade HTTP route, Dashboard socket timeouts, or generated Caddy proxy rules.
// Unrelated UI copy, doctor, and documentation changes may skip this slow gate.
test('Antigravity upgrade response survives more than sixty seconds through browser, proxy and Dashboard', {
  skip: process.env.ZYLOS_UPGRADE_INTEGRATION !== '1', timeout: 100000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-http-'));
  isolateInstanceObservations(t, root);
  t.mock.method(VersionChecker.prototype, 'start', function () {});
  const oldRoot = process.env.ZYLOS_DIR, oldPath = process.env.PATH;
  process.env.ZYLOS_DIR = root;
  const data = path.join(root, 'components/dashboard'), bin = path.join(root, 'bin');
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, '.zylos')); fs.writeFileSync(path.join(root, '.env'), 'TZ=Asia/Singapore\n');
  fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ runtime: 'agy', session_mode: 'single' }));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ auth: { enabled: true, password: 'fixture-password' } }));
  const calls = path.join(root, 'calls');
  fs.writeFileSync(path.join(bin, 'agy'), `#!${process.execPath}\nimport fs from 'node:fs'; if(process.argv[2]==='update'){fs.appendFileSync(${JSON.stringify(calls)}, 'agy update\\n'); setTimeout(()=>console.log('updated'),65000);}else console.log('1.5.11');`, { mode: 0o755 });
  for (const command of ['claude', 'codex']) fs.writeFileSync(path.join(bin, command), `#!${process.execPath}\nif(process.argv[2]==='update'){process.exit(99);}console.log('fixture');`, { mode: 0o755 });
  process.env.PATH = bin;
  let server, proxy, browser;
  t.after(async () => {
    await browser?.close();
    if (proxy && proxy.exitCode === null) { proxy.kill(); await new Promise(resolve => proxy.once('exit', resolve)); }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    process.env.ZYLOS_DIR = oldRoot; process.env.PATH = oldPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { createServer } = await import('../src/index.js'); server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const portProbe = net.createServer(); await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  const config = path.join(root, 'Caddyfile');
  fs.writeFileSync(config, `{\n admin off\n auto_https off\n}\nhttp://127.0.0.1:${port} {\n${generateRouteBlocks([{ type: 'reverse_proxy', path: '/dashboard/*', strip_prefix: '/dashboard', target: '127.0.0.1:' + server.address().port }])}\n}`);
  proxy = spawn(process.env.ZYLOS_TEST_CADDY, ['run', '--config', config, '--adapter', 'caddyfile'], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}/dashboard`;
  for (let i = 0; ; i++) { try { await fetch(base + '/login'); break; } catch { assert.ok(i < 100); await new Promise(resolve => setTimeout(resolve, 50)); } }
  const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
  browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true,
    env: { ...process.env, PATH: oldPath }, args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  const page = await browser.newPage();
  await page.goto(base + '/login');
  const login = await page.evaluate(async () => {
    const r = await fetch(location.href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=fixture-password' }); return r.status;
  }); assert.equal(login, 200);
  const started = Date.now();
  const result = await page.evaluate(async base => {
    const response = await fetch(base + '/api/instance/actions/upgrade-runtime', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return { status: response.status, data: await response.json() };
  }, base);
  assert.ok(Date.now() - started >= 65000); assert.equal(result.status, 200);
  assert.equal(result.data.ok, true); assert.equal(result.data.messageKey, 'result.runtime_updated');
  assert.deepEqual(result.data.messageParams, { runtime: 'Antigravity' });
  assert.equal(fs.readFileSync(calls, 'utf8'), 'agy update\n');
  console.log('Slow upgrade elapsed ms:', Date.now() - started, 'server socket timeout:', server.timeout);
});
