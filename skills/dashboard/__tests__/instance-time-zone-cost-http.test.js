import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/lib/store.js';
import { INSTANCE_TEST_ZONE } from './helpers/instance-test-zone.js';

// Actual HTTP entry with a temporary installation whose .env sets TZ. Covers the overview cost tiers in /api/state
// (today and 7 days, from the metric resolver the server wires to the instance zone) and the pricing page's 7-day
// window. Run for changes to the server's zone wiring, the metric resolver, cost tiers or the pricing route; unrelated
// UI may skip. A file of its own: the scheduler's tz.js fixes its .env path on first import and the cost tiers are
// cached per process, so this needs a fresh process. The runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; ZYLOS_DIR
// points at the temporary installation for the whole test, and the server and installation are removed in teardown.

// Times are expected in the instance zone; INSTANCE_TEST_ZONE differs from the process zone (see the helper).
const ZONE = INSTANCE_TEST_ZONE;
const dayOf = (at, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(at));

test('overview cost tiers and the pricing week are counted in the .env time zone', { timeout: 30_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-tz-cost-'));
  const data = path.join(root, 'components/dashboard');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ auth: { enabled: true, password: 'fixture-password' } }));
  fs.writeFileSync(path.join(root, '.env'), `# instance settings\nTZ=${ZONE}\n`);
  const previous = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = root;
  let server;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (previous === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { createServer } = await import(`../src/index.js?instance-tz-cost=${Date.now()}`);

  // One cost of 1 every ten minutes over the last 30 hours: "today" is the number of them since midnight.
  const now = Date.now();
  const spent = Array.from({ length: 180 }, (_, index) => new Date(now - 60_000 - index * 600_000).toISOString());
  const store = new Store(path.join(data, 'dashboard.db'));
  try {
    for (const timestamp of spent) {
      store.insertMetric({ timestamp, runtime: 'claude', metric_name: 'api_request_cost', metric_value: 1,
        dimensions: { model: 'tiers' }, source: 'fixture', confidence: 'actual' });
    }
  } finally { store.close(); }
  const processZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const countToday = timeZone => spent.filter(at => dayOf(at, timeZone) === dayOf(now, timeZone)).length;
  const expectedToday = countToday(ZONE);
  assert.notEqual(expectedToday, countToday(processZone), 'the fixture tells the instance zone from the process zone');

  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: 'fixture-password' }) });
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie');
  const get = async route => {
    const response = await fetch(origin + route, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, route);
    return response.json();
  };

  const state = await get('/api/state');
  assert.equal(state.tz, ZONE);
  assert.equal(state.daily_cost, expectedToday, 'today counts from midnight in the instance zone');
  assert.equal(state.weekly_cost, spent.length, 'the last 30 hours are inside the 7 days');

  // The pricing page lists the models that cost something in the week the usage page shows.
  const week = await get('/api/workbench/usage?range=7d');
  assert.equal(week.tz, ZONE);
  const since = Date.parse(week.since);
  const edge = new Store(path.join(data, 'dashboard.db'));
  try {
    edge.insertMetric({ timestamp: new Date(since + 60_000).toISOString(), runtime: 'claude', metric_name: 'api_request_cost',
      metric_value: 2, dimensions: { model: 'inside-week' }, source: 'fixture', confidence: 'actual' });
    edge.insertMetric({ timestamp: new Date(since - 60_000).toISOString(), runtime: 'claude', metric_name: 'api_request_cost',
      metric_value: 3, dimensions: { model: 'before-week' }, source: 'fixture', confidence: 'actual' });
  } finally { edge.close(); }
  const models = (await get('/api/workbench/pricing')).models.map(row => row.model);
  assert.ok(models.includes('inside-week'), 'a cost a minute after the week starts in the instance zone is listed');
  assert.ok(!models.includes('before-week'), 'a cost a minute before it is not');
});
