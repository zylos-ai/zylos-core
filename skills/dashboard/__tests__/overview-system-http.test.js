import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { mock } from 'node:test';
import { Store } from '../src/lib/store.js';
import { VersionChecker } from '../src/lib/version-checker.js';
import { SystemCollector } from '../src/lib/collectors/system-collector.js';
import { scheduleEnv } from './fixtures/schedule-env.js';

mock.method(VersionChecker.prototype, 'start', () => {});

// HTTP integration. Covers: the real server entry hands its own system collector to the overview snapshot, so
// GET /api/workbench/groups carries the collector's latest CPU, memory and disk sample under instance.system.
// The snapshot's forwarding of an injected reader is covered by wb-groups-api; this case proves the server wiring.
// The periodic collector loop only starts in the listening entry point, so the test asks the server's own
// collector instance (the one /api/system reads) for one real sample instead of waiting for that loop.
// Run when the server wiring, the overview snapshot or the system collector changes; changes limited to the
// strip's drawing may skip it. Isolation: HOME, PM2_HOME and TMPDIR are isolated by the test runner; this test
// points the process's ZYLOS_DIR at the temporary installation from scheduleEnv (asserted to stay under its root),
// with a private dashboard.db inside it; no PM2 or tmux command runs. The server, timers and stores are closed,
// ZYLOS_DIR restored and the root removed in teardown.
test('the overview snapshot carries the server system collector sample', { timeout: 20_000 }, async t => {
  const install = scheduleEnv(t, { link: false });
  const { zylosDir } = install;
  assert.ok(zylosDir.startsWith(install.root + path.sep));
  console.log('Overview system HTTP isolation:', JSON.stringify({ ZYLOS_DIR: zylosDir, HOME: process.env.HOME,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR }));

  const configDir = path.join(zylosDir, 'components', 'dashboard');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ auth: { enabled: true, password: 'secret' } }));

  const previous = { ZYLOS_DIR: process.env.ZYLOS_DIR, DASHBOARD_PORT: process.env.DASHBOARD_PORT };
  process.env.ZYLOS_DIR = zylosDir;
  process.env.DASHBOARD_PORT = '0';
  let server;
  const stores = new Set(), timers = new Set(), collectors = new Set();
  const checkSchema = Store.prototype.checkSchema, schedule = globalThis.setInterval;
  const latest = SystemCollector.prototype.getLatestSystemData;
  t.mock.method(Store.prototype, 'checkSchema', function (...args) { stores.add(this); return checkSchema.apply(this, args); });
  t.mock.method(globalThis, 'setInterval', (...args) => { const timer = schedule(...args); timers.add(timer); return timer; });
  t.mock.method(SystemCollector.prototype, 'getLatestSystemData', function (...args) {
    collectors.add(this); return latest.apply(this, args);
  });
  t.after(async () => {
    for (const collector of collectors) collector.stop();
    for (const timer of timers) clearInterval(timer);
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await server.closeAttachments?.();
    }
    for (const store of stores) if (store.db.open) store.close();
    for (const [key, value] of Object.entries(previous)) if (value == null) delete process.env[key]; else process.env[key] = value;
  });

  const { createServer } = await import(new URL(`../src/index.js?overview-system=${Date.now()}`, import.meta.url).href);
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: 'secret' }) });
  await login.text();
  assert.equal(login.status, 302);
  const cookie = login.headers.getSetCookie().find(value => value.startsWith('__Secure-zylos_dashboard_session=')).split(';')[0];
  const get = async route => {
    const response = await fetch(origin + route, { headers: { cookie } });
    const body = await response.json();
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(body).slice(0, 500)}`);
    return body;
  };

  await get('/api/system');
  assert.equal(collectors.size, 1, 'the server reads one system collector');
  const [collector] = collectors;
  await collector.collect();
  const sample = collector.getLatestSystemData();
  assert.equal(typeof sample.collectedAt, 'number');

  const snapshot = await get('/api/workbench/groups');
  assert.ok(snapshot.instance.system, 'the snapshot carries a host sample');
  assert.equal(typeof snapshot.instance.system.sampledAt, 'number');
  assert.equal(snapshot.instance.system.sampledAt, sample.collectedAt, 'the sample is the server collector\'s latest');
  assert.equal(snapshot.instance.system.memTotalBytes, sample.mem_total_bytes ?? null);
});
