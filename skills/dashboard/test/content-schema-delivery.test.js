import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '../src/lib/http.js';
import { FleetProxy } from '../src/lib/fleet-proxy.js';

const publicRoot = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const schemaPath = fileURLToPath(new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url));
function privateEnvironment() {
  const canonical = value => {
    let ancestor = path.resolve(value); const suffix = [];
    while (!fs.existsSync(ancestor)) { suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
    return path.join(fs.realpathSync(ancestor), ...suffix);
  };
  const home = fs.realpathSync(process.env.HOME);
  assert.notEqual(home, fs.realpathSync(os.userInfo().homedir));
  for (const name of ['ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[name] && canonical(process.env[name]).startsWith(path.dirname(home) + path.sep), name);
  }
  console.log(JSON.stringify({ HOME: home, ZYLOS_DIR: process.env.ZYLOS_DIR, PM2_HOME: process.env.PM2_HOME,
    TMPDIR: process.env.TMPDIR, database: 'none', tmux: 'none', listener: 'random 127.0.0.1 port' }));
}
async function fixture(t, root = publicRoot) {
  privateEnvironment();
  const proxy = new FleetProxy({ rootDir: root, config: { fleet: { agents: [{ name: 'Peer', base_url: 'http://never.invalid' }] } },
    poller: {}, fetch: () => assert.fail('schema delivery must not fetch a remote instance') });
  const server = http.createServer(async (req, res) => {
    try {
      // Model the documented reverse proxy's prefix stripping before Dashboard.
      if (req.url.startsWith('/dashboard/')) req.url = req.url.slice('/dashboard'.length);
      const url = new URL(req.url, 'http://127.0.0.1');
      if (await proxy.handle(req, res, url)) return;
      if (serveStatic(req, res, root)) return;
      res.writeHead(404); res.end('not found');
    } catch { res.writeHead(500); res.end('fixture failure'); }
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function rawRequest(origin, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(origin + '/', { path: requestPath, timeout: 3000 }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 128 * 1024) { req.destroy(Error('response too large')); return; } chunks.push(chunk); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(Error('request timed out'))); req.on('error', reject);
  });
}

// Static-delivery boundary only. Run after schema URL/source or serveStatic/fleet
// changes; skip unrelated UI/business changes. No live DB/PM2/tmux/remote calls.
test('shared schema is delivered at local base and fleet module URLs', { timeout: 15000 }, async t => {
  const origin = await fixture(t), expected = fs.readFileSync(schemaPath);
  for (const prefix of ['', '/dashboard', '/fleet/Peer', '/dashboard/fleet/Peer']) {
    const entryPage = await fetch(origin + prefix + '/_assets/index.html');
    assert.equal(entryPage.status, 200);
    const pageText = await entryPage.text();
    const appPath = /src="__ASSET_ROOT__\/(js\/app\.js\?v=93)"/.exec(pageText)?.[1];
    assert.ok(appPath, 'the entry page loads the refreshed application module');
    const application = await fetch(origin + prefix + '/_assets/' + appPath);
    assert.equal(application.status, 200);
    assert.match(await application.text(), /from '\.\/wb\/chat\.js\?v=91'/);
    for (const moduleName of ['chat', 'chat-blocks', 'chat-questions']) {
      const version = moduleName === 'chat-blocks' ? 90 : 91;
      const moduleUrl = origin + prefix + `/_assets/js/wb/${moduleName}.js?v=${version}`;
      const entry = await fetch(moduleUrl);
      assert.equal(entry.status, 200);
      const body = await entry.text();
      const specifier = /from ['"]([^'"]*chat-schema\.js[^'"]*)['"]/.exec(body)?.[1];
      assert.equal(specifier, '../../chat-schema.js?v=90');
      const schemaUrl = new URL(specifier, moduleUrl);
      assert.equal(schemaUrl.pathname, prefix + '/_assets/chat-schema.js');
      assert.equal(schemaUrl.search, '?v=90');
      const response = await fetch(schemaUrl);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^text\/javascript; charset=utf-8$/);
      assert.equal(Buffer.from(await response.arrayBuffer()).equals(expected), true);
    }
  }
});

// Security boundary of the fixed alias. Run on alias/path routing changes;
// skip pure schema field changes. Only an owned loopback HTTP listener is used.
test('schema alias does not open neighboring scripts or traversal paths', { timeout: 15000 }, async t => {
  const origin = await fixture(t), secretSource = fs.readFileSync(new URL('../../comm-bridge/scripts/c4-config.js', import.meta.url));
  for (const prefix of ['', '/dashboard', '/fleet/Peer']) {
    for (const suffix of ['/_assets/c4-config.js', '/_assets/chat-schema.js/extra', '/_assets/chat-schema.js.map',
      '/_assets/../comm-bridge/scripts/c4-config.js', '/_assets/%2e%2e/%2e%2e/comm-bridge/scripts/c4-config.js',
      '/_assets/..%2f..%2fcomm-bridge/scripts/c4-config.js', '/_assets/%252e%252e/c4-config.js']) {
      const response = await rawRequest(origin, prefix + suffix);
      assert.notEqual(response.status, 200, prefix + suffix);
      assert.equal(response.body.equals(secretSource), false);
    }
  }
});

// Missing-source boundary, owned filesystem fixture only. Run when alias
// resolution changes; no dependency download or copied-schema fallback allowed.
test('missing schema source fails instead of serving a public copy', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-delivery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'skills/dashboard/public'); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'chat-schema.js'), 'export const copied = true;');
  const origin = await fixture(t, root);
  for (const prefix of ['', '/dashboard', '/fleet/Peer']) {
    const response = await fetch(origin + prefix + '/_assets/chat-schema.js');
    assert.equal(response.status, 404);
    assert.equal((await response.text()).includes('copied'), false);
  }
});
