import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '../src/lib/http.js';
import { FleetProxy } from '../src/lib/fleet-proxy.js';
import { COMPONENT_DEFINITIONS, REGISTERED_COMPONENT_KEYS, VIEW_SCHEMA, FORM_CONDITION_SCHEMA, HOST_SCHEMA_SOURCE } from '../../comm-bridge/scripts/c4-content-schema.js';

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
// changes, active browser cache versions or retiring active browser modules;
// skip UI/business changes that do not alter those URLs.
// No live DB/PM2/tmux/remote calls.
test('shared schema is delivered at local base and fleet module URLs', { timeout: 15000 }, async t => {
  const origin = await fixture(t), expected = fs.readFileSync(schemaPath);
  assert.ok(expected.includes(Buffer.from('export const COMPONENT_DEFINITIONS = ' + JSON.stringify(COMPONENT_DEFINITIONS))));
  assert.ok(expected.includes(Buffer.from('export const REGISTERED_COMPONENT_KEYS = ' + JSON.stringify(REGISTERED_COMPONENT_KEYS))));
  for (const [name, value] of Object.entries({ VIEW_SCHEMA, FORM_CONDITION_SCHEMA, HOST_SCHEMA_SOURCE })) {
    assert.ok(expected.includes(Buffer.from(`export const ${name} = ${JSON.stringify(value)}`)), name);
  }
  assert.ok(expected.includes(Buffer.from('export function evaluateFormState(fields, values)')));
  assert.ok(expected.includes(Buffer.from('export function validateFormFields(fields, values)')));
  assert.doesNotMatch(expected.toString(), /^import\s/m, 'browser schema remains one generated-data module without runtime imports');
  for (const prefix of ['', '/dashboard', '/fleet/Peer', '/dashboard/fleet/Peer']) {
    const entryPage = await fetch(origin + prefix + '/_assets/index.html');
    assert.equal(entryPage.status, 200);
    const pageText = await entryPage.text();
    const appPath = /src="__ASSET_ROOT__\/(js\/app\.js\?v=\d+)"/.exec(pageText)?.[1];
    assert.equal(appPath, 'js/app.js?v=134', 'the entry page invalidates the application module cache');
    const cache = new Map();
    async function moduleAt(url) {
      if (cache.has(url)) return cache.get(url);
      const response = await fetch(url);
      assert.equal(response.status, 200, url);
      const body = await response.text();
      cache.set(url, body);
      return body;
    }
    const appUrl = origin + prefix + '/_assets/' + appPath;
    // Keep failed import diagnostics bounded even for the large application module.
    const importLine = (source, name) => (source.split('\n').find(line => line.startsWith('import ') && line.includes(name)) || '').slice(0, 512);
    const appSource = await moduleAt(appUrl);
    assert.match(importLine(appSource, 'markdown-config.js'), /from ['"]\.\/markdown-config\.js\?v=3['"]/);
    assert.match(importLine(appSource, 'observer-history.js'), /from ['"]\.\/observer-history\.js\?v=5['"]/);
    const observerUrl = new URL('./observer-history.js?v=5', appUrl).href;
    const observerSource = await moduleAt(observerUrl);
    assert.match(importLine(observerSource, 'markdown-it-cjk-friendly/index.js'), /from ['"]\.\/markdown-it-cjk-friendly\/index\.js\?v=1['"]/);
    const markdownUrl = new URL('./markdown-config.js?v=3', appUrl).href;
    const markdownSource = await moduleAt(markdownUrl);
    assert.match(importLine(markdownSource, 'markdown-it-cjk-friendly/index.js'), /from ['"]\.\/markdown-it-cjk-friendly\/index\.js\?v=1['"]/);
    const pluginUrl = new URL('./markdown-it-cjk-friendly/index.js?v=1', markdownUrl).href;
    assert.equal(await moduleAt(pluginUrl), fs.readFileSync(path.join(publicRoot, 'js/markdown-it-cjk-friendly/index.js'), 'utf8'));
    let parentUrl = appUrl;
    const activeModules = new Map();
    for (const [name, version] of [['conversation-page', 132], ['conversation-content', 111], ['chat-blocks', 107]]) {
      const parent = await moduleAt(parentUrl);
      const specifiers = [...parent.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)].map(match => match[1]);
      const specifier = specifiers.find(value => value.endsWith(`/${name}.js?v=${version}`));
      assert.ok(specifier, `${parentUrl} loads ${name}`);
      parentUrl = new URL(specifier, parentUrl).href;
      activeModules.set(name, parentUrl);
    }
    const pageUrl = activeModules.get('conversation-page');
    assert.match(importLine(await moduleAt(activeModules.get('conversation-content')), 'markdown-it-cjk-friendly/index.js'), /from ['"]\.\.\/markdown-it-cjk-friendly\/index\.js\?v=1['"]/);
    const page = await moduleAt(pageUrl);
    for (const [name, version] of [['conversation-state', 128], ['chat-questions', 104], ['conversation-activity', 103], ['conversation-delete', 4]]) {
      const specifier = [...page.matchAll(/from ['"]([^'"]+)['"]/g)]
        .map(match => match[1]).find(value => value.endsWith(`/${name}.js?v=${version}`));
      assert.ok(specifier, `${name} belongs to the active page graph`);
      activeModules.set(name, new URL(specifier, pageUrl).href);
    }
    for (const [parent, names] of [[appUrl, [['chat-drafts', 102]]],
      [activeModules.get('conversation-content'), [['chat-view', 104], ['conversation-charts', 106]]]]) {
      const source = await moduleAt(parent);
      for (const [name, version] of names) {
        const specifier = [...source.matchAll(/from ['"]([^'"]+)['"]/g)]
          .map(match => match[1]).find(value => value.endsWith(`/${name}.js?v=${version}`));
        assert.ok(specifier, `${name} belongs to the current cache graph`);
        const url = new URL(specifier, parent).href;
        assert.equal(await moduleAt(url), fs.readFileSync(path.join(publicRoot, 'js/wb', name + '.js'), 'utf8'));
      }
    }
    const schemaVersions = new Set(), deliveryUrls = new Set();
    let schemaImports = 0, deliveryImports = 0;
    assert.doesNotMatch(await moduleAt(appUrl), /(?:from\s*|import\s*)['"][^'"]*\/(?:chat|chat-state)\.js(?:[?'"])/);
    for (const name of ['chat', 'chat-state']) {
      assert.equal(fs.existsSync(path.join(publicRoot, 'js/wb', name + '.js')), false, `${name} is retired`);
      assert.equal((await fetch(origin + prefix + '/_assets/js/wb/' + name + '.js')).status, 404);
    }
    for (const moduleUrl of activeModules.values()) {
      const body = await moduleAt(moduleUrl);
      for (const match of body.matchAll(/from ['"]([^'"]*chat-schema\.js[^'"]*)['"]/g)) {
        schemaImports++;
        const schemaUrl = new URL(match[1], moduleUrl);
        assert.equal(schemaUrl.pathname, prefix + '/_assets/chat-schema.js');
        assert.equal(schemaUrl.search, '?v=102', 'the shipped form renderer advances every shared schema cache key together');
        schemaVersions.add(schemaUrl.search);
        const response = await fetch(schemaUrl);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /^text\/javascript; charset=utf-8$/);
        assert.equal(Buffer.from(await response.arrayBuffer()).equals(expected), true);
      }
      assert.doesNotMatch(body, /(?:from\s*|import\s*)['"][^'"]*\/(?:chat|chat-state)\.js(?:[?'"])/,
        'active page modules must not reference retired implementations');
      for (const match of body.matchAll(/from ['"]([^'"]*chat-delivery-state\.js[^'"]*)['"]/g)) {
        deliveryImports++;
        const deliveryUrl = new URL(match[1], moduleUrl);
        assert.equal(deliveryUrl.pathname, prefix + '/_assets/js/wb/chat-delivery-state.js');
        assert.equal(deliveryUrl.search, '?v=100');
        deliveryUrls.add(deliveryUrl.href);
        assert.equal(await moduleAt(deliveryUrl.href), fs.readFileSync(path.join(publicRoot, 'js/wb/chat-delivery-state.js'), 'utf8'));
      }
    }
    assert.ok(schemaImports >= 4, 'all schema imports and re-exports are checked');
    assert.equal(schemaVersions.size, 1, 'one shared schema module instance');
    assert.equal(deliveryImports, 3, 'page, controller and questions share delivery state');
    assert.equal(deliveryUrls.size, 1, 'one exact shared delivery-state module URL');

  }
});

// Security boundary of the fixed alias. Run on alias/path routing changes;
// skip pure schema field changes. Only an owned loopback HTTP listener is used.
test('schema alias does not open neighboring scripts or traversal paths', { timeout: 15000 }, async t => {
  const origin = await fixture(t), secretSource = fs.readFileSync(new URL('../../comm-bridge/scripts/c4-config.js', import.meta.url));
  for (const prefix of ['', '/dashboard', '/fleet/Peer']) {
    for (const suffix of ['/_assets/c4-config.js', '/_assets/c4-component-catalog.js', '/comm-bridge/scripts/c4-component-catalog.js',
      '/_assets/../comm-bridge/scripts/c4-component-catalog.js', '/_assets/chat-schema.js/extra', '/_assets/chat-schema.js.map',
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
