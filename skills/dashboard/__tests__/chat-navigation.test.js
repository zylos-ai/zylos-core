import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetProxy } from '../src/lib/fleet-proxy.js';

// Integration boundary: actual fleet page handler and shared static assets.
// Run for chat navigation/static-route changes; skip status/text-only changes.
// The runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; no DB, PM2 or tmux is used.
test('fleet conversation page serves the shared frontend and schema under the browser prefix', async t => {
  const testRoot = path.dirname(process.env.TMPDIR);
  for (const name of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    const value = process.env[name];
    assert.ok(value && path.isAbsolute(value));
    const relative = path.relative(testRoot, value);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }
  console.info('chat navigation isolation', JSON.stringify(Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(name => [name, process.env[name]]))), 'DB/PM2/tmux: unused');
  const rootDir = fileURLToPath(new URL('../public', import.meta.url));
  let upstream = 0;
  const proxy = new FleetProxy({ config: { fleet: { agents: [{ name: 'Remote', base_url: 'http://unused.invalid' }] } }, rootDir,
    poller: { getSessionToken: async () => 'fixture-token', getAgentAccess: () => 'admin' },
    fetch: () => { upstream++; throw Error('Unexpected upstream'); } });
  const server = http.createServer(async (req, res) => {
    if (!await proxy.handle(req, res, new URL(req.url, 'http://fixture'))) { res.writeHead(404); res.end(); }
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(origin + '/fleet/Remote/chat', { headers: { 'x-forwarded-prefix': '/dashboard' } });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /data-base-path="\/dashboard\/fleet\/Remote"/);
  assert.match(html, /id="tab-chat"/);
  assert.match(html, /data-tab="chat"/);
  for (const asset of ['js/wb/conversation-page.js', 'js/wb/conversation-state.js', 'chat-schema.js']) {
    const result = await fetch(origin + '/fleet/Remote/_assets/' + asset);
    assert.equal(result.status, 200, asset);
    assert.match(result.headers.get('content-type'), /javascript/);
  }
  const stylesheet = await fetch(origin + '/fleet/Remote/_assets/css/conversation.css');
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get('content-type'), /css/);
  assert.match(html, /css\/conversation\.css/);
  assert.equal(upstream, 0);
});
