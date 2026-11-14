import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const publicDir = fileURLToPath(new URL('../../public/', import.meta.url));
const schema = fileURLToPath(new URL('../../../comm-bridge/scripts/c4-content-schema.js', import.meta.url));
const fixture = fileURLToPath(new URL('./unknown-blocks-fixture.js', import.meta.url));
export async function runUnknownBlocksBrowser(sandbox, width) {
  console.info('unknown-block browser isolation', JSON.stringify({ ...sandbox.assertIsolation(),
    databaseUsed: false, tmuxUsed: false, backendUsed: false, listen: '127.0.0.1:ephemeral' }));
  const html = `<!doctype html><html lang="zh" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  ${['css/style.css', 'themes/light.css', 'themes/dark.css', 'css/wb.css', 'css/wb-icons.css', 'css/conversation.css'].map(file => `<link rel="stylesheet" href="/${file}">`).join('')}
  <style>body{margin:0;padding:16px}.conversation-message{max-width:900px;margin:auto}</style></head>
  <body><article class="conversation-message"><div class="conversation-message-body"></div></article><script type="module" src="/fixture.js"></script></body></html>`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html); }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const file = url.pathname === '/chat-schema.js' ? schema : url.pathname === '/fixture.js' ? fixture
      : path.resolve(publicDir, '.' + decodeURIComponent(url.pathname));
    if ((!file.startsWith(publicDir) && ![schema, fixture].includes(file)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); return res.end();
    }
    res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  let browser;
  try {
    const origin = await sandbox.startHttp(server);
    const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
    const profile = path.join(sandbox.paths.tmp, 'chrome'); fs.mkdirSync(profile);
    const chrome = sandbox.startChild(process.env.ZYLOS_CHAT_BROWSER_BIN, ['--headless', '--no-sandbox', '--disable-background-networking',
      '--disable-component-update', '--no-first-run', '--disable-crash-reporter', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
    { timeoutMs: 20_000, maxOutputBytes: 65_536 });
    const endpoint = await new Promise((resolve, reject) => {
      let tail = '';
      const timer = setTimeout(() => { chrome.stderr.off('data', read); reject(Error('Chrome endpoint timed out')); }, 8000);
      function read(chunk) {
        tail = (tail + chunk).slice(-8192);
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(tail);
        if (match) { clearTimeout(timer); chrome.stderr.off('data', read); resolve(match[1]); }
      }
      chrome.stderr.on('data', read);
      chrome.completion.then(result => { clearTimeout(timer); chrome.stderr.off('data', read); reject(Error('Chrome exited: ' + result.code)); });
    });
    browser = await chromium.connectOverCDP(endpoint);
    sandbox.addCleanup(() => browser.close());
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN' });
    let pageError, outside;
    await context.route('**/*', route => {
      if (route.request().url().startsWith(origin + '/')) return route.continue();
      outside ??= route.request().url(); return route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    page.on('pageerror', error => { pageError ??= error.message; });
    await page.goto(origin);
    try { await page.waitForFunction(() => window.unknownFixture?.ready); }
    catch (error) { throw Error(error.message + '; page error=' + pageError); }
    assert.equal(pageError, undefined);
    assert.equal(outside, undefined);
    assert.deepEqual(await page.locator('[data-block-id]').evaluateAll(nodes => nodes.map(node => node.dataset.blockId)), ['before', 'future', 'chart', 'after']);
    const future = page.locator('[data-block-id="future"]');
    assert.equal(await future.textContent(), await page.evaluate(() => window.unknownFixture.fallback));
    assert.equal(await future.locator('img,a,script,button,input,canvas,table').count(), 0);
    assert.equal(await page.locator('[data-block-id="chart"] table').count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    const output = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
    if (output) {
      fs.mkdirSync(output, { recursive: true });
      await page.screenshot({ path: path.join(output, `unknown-block-${width}.png`), fullPage: true });
    }
    for (const fallback of ['   ', '\n\r\n']) {
      await page.evaluate(value => window.unknownFixture.setFallback(value), fallback);
      assert.equal(await page.locator('[data-block-id]').count(), 0);
      assert.equal(await page.locator('.chat-invalid-fallback').textContent(), await page.evaluate(() => window.unknownFixture.wholeFallback));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    }
    assert.equal(pageError, undefined);
    if (output) await page.screenshot({ path: path.join(output, `unknown-block-blank-${width}.png`), fullPage: true });
  } finally { if (browser) await browser.close(); }
}
