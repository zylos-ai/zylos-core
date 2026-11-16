import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { serveStatic, sendHtml } from '../skills/dashboard/src/lib/http.js';
import { FleetProxy } from '../skills/dashboard/src/lib/fleet-proxy.js';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';
import { startPage } from '../skills/dashboard/__tests__/helpers/workbench-browser.js';

const publicDir = fileURLToPath(new URL('../skills/dashboard/public/', import.meta.url));

// Real serveStatic and FleetProxy with a copied public tree and a small page that
// isolates the browser's CSS/module cache from unrelated Dashboard API fixtures.
// The official runner and sandbox prove private HOME, instance, PM2, temporary,
// socket and database paths before any listener or browser is started.
for (const fleet of [false, true]) {
  test(`browser revalidates unchanged and changed Dashboard assets through ${fleet ? 'FleetProxy' : 'serveStatic'}`, {
    skip: !chatEnabled(), timeout: 60_000,
  }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE;
      const executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
      for (const filename of [modulePath, executablePath]) {
        assert.ok(filename && path.isAbsolute(filename) && fs.existsSync(filename), 'explicit existing local browser dependencies required');
      }
      const rootDir = path.join(sandbox.root, 'public');
      fs.cpSync(publicDir, rootDir, { recursive: true });
      fs.writeFileSync(path.join(rootDir, 'index.html'), '<!doctype html><link rel="stylesheet" href="__ASSET_ROOT__/css/cache-probe.css"><p id="probe"></p><script type="module" src="__ASSET_ROOT__/js/cache-probe.js"></script>');
      fs.writeFileSync(path.join(rootDir, 'js/cache-probe.js'), "import { formatDuration } from './wb/duration-format.js'; document.querySelector('#probe').textContent = formatDuration(60);\n");
      const css = path.join(rootDir, 'css/cache-probe.css');
      fs.writeFileSync(css, '#probe { color: rgb(10, 20, 30); }\n');
      const proxy = new FleetProxy({ rootDir, config: { fleet: { agents: [{ name: 'Cache fixture' }] } },
        poller: { getSessionToken: async () => 'fixture', getAgentAccess: () => 'read' } });
      const requests = [];
      const server = http.createServer(async (req, res) => {
        const record = { url: req.url, validator: req.headers['if-none-match'] };
        const writeHead = res.writeHead;
        res.writeHead = function (status, headers) {
          record.headers = { ...headers };
          return writeHead.call(this, status, headers);
        };
        res.on('finish', () => { if (requests.length < 100) requests.push({ ...record, status: res.statusCode }); });
        try {
          if (fleet) { await proxy.handle(req, res, new URL(req.url, 'http://fixture')); return; }
          if (req.url === '/') { sendHtml(res, 200, fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8').replaceAll('__ASSET_ROOT__', '/_assets')); return; }
          if (!serveStatic(req, res, rootDir)) { res.writeHead(404); res.end(); }
        } catch (error) { res.writeHead(500); res.end(error.message); }
      });
      const origin = await sandbox.startHttp(server);
      const prefix = fleet ? '/fleet/Cache%20fixture' : '';
      const { chromium } = await import(pathToFileURL(modulePath));
      sandbox.assertIsolation();
      const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
      sandbox.addCleanup(() => browser.close());
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => { if (errors.length < 10) errors.push(error.message.slice(0, 1000)); });
      const assets = ['/js/cache-probe.js', '/js/wb/duration-format.js', '/css/cache-probe.css'];
      const matching = suffix => requests.filter(record => new URL(record.url, origin).pathname.endsWith(suffix));
      const assertAppearance = async (text, color) => {
        await page.waitForFunction(({ text, color }) => {
          const node = document.querySelector('#probe');
          return node?.textContent === text && getComputedStyle(node).color === color;
        }, { text, color });
      };
      await page.goto(origin + prefix + '/', { waitUntil: 'networkidle' });
      await assertAppearance('1m', 'rgb(10, 20, 30)');
      for (const asset of assets) {
        const [first] = matching(asset);
        assert.equal(first?.status, 200, `${asset}: first load sends body`);
        assert.equal(first.headers['cache-control'], 'no-cache');
        assert.ok(first.headers.etag, `${asset}: validator supplied`);
      }
      await page.reload({ waitUntil: 'networkidle' });
      await assertAppearance('1m', 'rgb(10, 20, 30)');
      for (const asset of assets) {
        const records = matching(asset);
        assert.equal(records.length, 2, `${asset}: refresh reaches server`);
        assert.equal(records[1].validator, records[0].headers.etag);
        assert.equal(records[1].status, 304, `${asset}: refresh reuses cached body`);
      }
      // Simulate an upgrade by changing only the private copy of a real deep
      // product module and stylesheet; this is an upgrade fixture, not a mutation
      // of the checkout or a negative-control implementation.
      const deepModule = path.join(rootDir, 'js/wb/duration-format.js');
      fs.writeFileSync(deepModule, fs.readFileSync(deepModule, 'utf8').replace("parts.join(' ')", "parts.join(' ') + ' updated'"));
      fs.writeFileSync(css, '#probe { color: rgb(40, 50, 60); }\n');
      await page.reload({ waitUntil: 'networkidle' });
      await assertAppearance('1m updated', 'rgb(40, 50, 60)');
      for (const asset of ['/js/wb/duration-format.js', '/css/cache-probe.css']) {
        const records = matching(asset);
        assert.equal(records.length, 3);
        assert.equal(records[2].status, 200, `${asset}: changed bytes replace cached body`);
        assert.notEqual(records[2].headers.etag, records[0].headers.etag);
      }
      assert.equal(matching('/js/cache-probe.js')[2].status, 304, 'unchanged parent module remains cached');
      assert.deepEqual(errors, [], 'module graph executes without browser errors');
      console.info('Static cache browser evidence:', JSON.stringify({ fleet, requests }));
    }, { timeoutMs: 50_000 });
    assert.equal(fs.existsSync(sandbox.root), false, 'private tree reclaimed');
    assert.ok([...sandbox.servers].every(server => !server.listening), 'HTTP listeners reclaimed');
  });
}

test('full Dashboard page revalidates its real JavaScript and CSS on ordinary reload', {
  skip: !chatEnabled(), timeout: 60_000,
}, async t => {
  const sandbox = createChatSandbox(t);
  await sandbox.runCase(async () => {
    const { base } = await startPage(sandbox);
    const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
    sandbox.assertIsolation();
    const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN,
      headless: true, env: sandbox.env, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'] });
    sandbox.addCleanup(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const responses = [];
    for (const server of sandbox.servers) server.prependListener('request', (req, res) => {
      const writeHead = res.writeHead;
      res.writeHead = function (status, headers) {
        if (responses.length < 1000 && req.url.startsWith('/_assets/')) responses.push({ status, url: req.url, headers: { ...headers } });
        return writeHead.call(this, status, headers);
      };
    });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('.wb-row');
    const first = responses.filter(record => /javascript|text\/css/.test(String(record.headers['content-type'])));
    assert.ok(first.length >= 5, 'full product page loads its real module graph and styles');
    assert.ok(first.every(record => record.status === 200));
    assert.ok(first.every(record => record.headers['cache-control'] === 'no-cache' && record.headers.etag),
      JSON.stringify(first.filter(record => record.headers['cache-control'] !== 'no-cache' || !record.headers.etag)));
    responses.length = 0;
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.wb-row');
    const refreshed = responses.filter(record => /javascript|text\/css/.test(String(record.headers['content-type'])));
    assert.equal(refreshed.length, first.length, JSON.stringify({ missing: first.filter(record => !refreshed.some(next => next.url === record.url)).map(record => record.url) }));
    assert.ok(refreshed.every(record => record.status === 304));
    console.info('Full Dashboard cache counts:', JSON.stringify({ first200: first.length, reload304: refreshed.length }));
  }, { timeoutMs: 50_000 });
});
