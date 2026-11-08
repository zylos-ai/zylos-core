import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/lib/store.js';

// Actual HTTP entry with a temporary installation whose .env sets TZ. Run for changes to how the Dashboard reads the
// instance time zone or to the usage and state routes that report it; unrelated UI may skip. The conversation routes
// are covered at the handler in chat-history.test.js. The runner
// isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; the server and the installation are removed in teardown. ZYLOS_DIR stays
// pointed at the temporary installation for the whole test, because the zone reader only reads the .env of the
// installation this process serves.

const dayOf = (iso, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(iso));
const clockOf = (iso, timeZone) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .format(new Date(iso));

test('usage and state follow the .env time zone on every request, without a restart', { timeout: 30_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-tz-http-'));
  const data = path.join(root, 'components/dashboard');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ auth: { enabled: true, password: 'fixture-password' } }));
  fs.writeFileSync(path.join(root, '.env'), '# instance settings\nTZ=Asia/Shanghai\n');
  const previous = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = root;
  let server;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (previous === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { createServer } = await import(`../src/index.js?instance-tz=${Date.now()}`);
  // Two hours ago: within today's or yesterday's bucket depending on the zone, never outside the week.
  const spent = new Date(Date.now() - 2 * 3600_000).toISOString();
  const store = new Store(path.join(data, 'dashboard.db'));
  try {
    store.insertMetric({ timestamp: spent, runtime: 'claude', metric_name: 'api_request_cost', metric_value: 1.5,
      source: 'fixture', confidence: 'actual' });
  } finally { store.close(); }
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
  for (const zone of ['Asia/Shanghai', 'America/Los_Angeles', 'UTC']) {
    if (zone !== 'Asia/Shanghai') fs.writeFileSync(path.join(root, '.env'), `# instance settings\nTZ=${zone}\n`);
    const series = await get('/api/workbench/usage?range=7d');
    assert.equal(series.tz, zone, `usage reads ${zone} from .env`);
    assert.equal(series.tzFallback, false);
    assert.equal(clockOf(series.since, zone), '00:00', 'the week starts at midnight in the instance zone');
    const summary = (await get('/api/workbench/usage?summary=cost')).costSummary;
    assert.equal(summary.tz, zone);
    const day = summary.daily.find(row => row.total > 0);
    assert.ok(day, 'the cost falls in one day bucket');
    assert.equal(clockOf(day.at, zone), '00:00', 'day buckets start at midnight in the instance zone');
    assert.equal(dayOf(day.at, zone), dayOf(spent, zone), 'the cost is counted on its day in the instance zone');
    assert.equal(summary.sevenDay.total, 1.5);
    assert.equal((await get('/api/state')).tz, zone, 'the state reports the zone for every page');
    const aggregate = await get('/api/metrics/aggregate?metric=cost&period=today');
    assert.equal(clockOf(aggregate.since, zone), '00:00', 'the aggregate API counts today from midnight in the instance zone');
  }
  fs.writeFileSync(path.join(root, '.env'), 'TZ=Not/AZone\n');
  const unknown = await get('/api/workbench/usage?range=7d');
  assert.equal(unknown.tz, 'UTC', 'an unusable zone reads UTC');
  assert.equal(unknown.tzFallback, true, 'and says so');
  assert.equal((await get('/api/state')).tz, null);
  // Without a TZ line the scheduler runs in the process zone, or UTC; that is the instance zone, not a fallback.
  fs.writeFileSync(path.join(root, '.env'), '# instance settings\n');
  const processZone = new Intl.DateTimeFormat('en-US', { timeZone: process.env.TZ || 'UTC' }).resolvedOptions().timeZone;
  const noLine = await get('/api/workbench/usage?range=7d');
  assert.equal(noLine.tz, processZone, 'an .env without TZ reads the zone the scheduler uses');
  assert.equal(noLine.tzFallback, false);
  assert.equal((await get('/api/state')).tz, processZone);
});
