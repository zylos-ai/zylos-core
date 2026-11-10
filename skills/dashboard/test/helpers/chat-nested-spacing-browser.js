import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const schema = fileURLToPath(new URL('../../../comm-bridge/scripts/c4-content-schema.js', import.meta.url));
const fixture = fileURLToPath(new URL('./chat-nested-spacing-fixture.js', import.meta.url));
export async function runNestedSpacingBrowser(sandbox, { width, theme }) {
  assert.ok([1280, 390].includes(width)); assert.ok(['light', 'dark'].includes(theme));
  const isolation = sandbox.assertIsolation();
  console.info('component browser isolation', JSON.stringify({ ...isolation,
    databasesUsed: false, tmuxUsed: false, backendUsed: false, address: '127.0.0.1:ephemeral' }));
  const html = `<!doctype html><html lang="zh" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  ${['css/style.css','themes/light.css','themes/dark.css','css/wb.css','css/wb-icons.css','css/conversation.css'].map(file => `<link rel="stylesheet" href="/${file}">`).join('')}
  <style>body{margin:0}main.conversation-page{display:block;overflow:visible;height:auto;padding:16px}.conversation-message{margin-bottom:24px!important}</style>
  </head><body><main class="conversation-page"></main><script type="module" src="/fixture.js"></script></body></html>`;
  const errors = [], outside = [], missing = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html); }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const file = url.pathname === '/chat-schema.js' ? schema : url.pathname === '/fixture.js' ? fixture
      : path.resolve(publicDir, '.' + decodeURIComponent(url.pathname));
    if ((!file.startsWith(publicDir + path.sep) && ![schema, fixture].includes(file)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      if (missing.length < 5) missing.push(url.pathname); res.writeHead(404); return res.end();
    }
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
  });
  let browser;
  try {
    const origin = await sandbox.startHttp(server);
    const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
    const profile = path.join(sandbox.paths.tmp, 'chrome-profile'); fs.mkdirSync(profile);
    const chrome = sandbox.startChild(process.env.ZYLOS_CHAT_BROWSER_BIN, [
      '--headless', '--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run',
      '--disable-dev-shm-usage', '--disable-crash-reporter', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
    ], { timeoutMs: 35_000, maxOutputBytes: 65_536 });
    const endpoint = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => { chrome.stderr.off('data', read); reject(new Error('Chrome debugging endpoint timed out')); }, 10_000);
      function read(chunk) {
        text = (text + chunk.toString()).slice(-8192);
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text);
        if (match) { clearTimeout(timer); chrome.stderr.off('data', read); resolve(match[1]); }
      }
      chrome.stderr.on('data', read);
      chrome.completion.then(result => { clearTimeout(timer); chrome.stderr.off('data', read); reject(new Error('Chrome exited: ' + result.code)); });
    });
    browser = await chromium.connectOverCDP(endpoint);
    sandbox.addCleanup(() => browser.close());
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN', timezoneId: 'UTC' });
    await context.route('**/*', route => {
      if (route.request().url().startsWith(origin + '/')) return route.continue();
      if (outside.length < 5) outside.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
    await page.goto(origin);
    try { await page.waitForFunction(() => window.componentFixtureReady === true); }
    catch (error) { throw new Error(error.message + '; errors=' + errors.join('; ') + '; missing=' + missing.join('; ')); }
    await page.evaluate(() => document.fonts.ready);
    const actual = await page.evaluate(() => {
      const box = node => {
        const b = node.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
      };
      const style = node => {
        const s = getComputedStyle(node);
        return { display: s.display, rowGap: s.rowGap, marginTop: s.marginTop, marginBottom: s.marginBottom, alignItems: s.alignItems };
      };
      return [...document.querySelectorAll('article')].map(article => {
        const outer = article.querySelector('.chat-message-content').firstElementChild;
        const slot = outer.classList.contains('conversation-view-section') ? outer.querySelector(':scope > .conversation-view-body') : outer;
        const [before, inner, after] = slot.children;
        const inside = inner.classList.contains('conversation-view-section') ? inner.querySelector(':scope > .conversation-view-body') : inner;
        const [first, second] = inside.children;
        return { id: article.id,
          beforeGap: box(inner).top - box(before).bottom,
          afterGap: box(after).top - box(inner).bottom,
          innerGap: box(second).top - box(first).bottom,
          outer: style(outer), slot: style(slot), inner: style(inner), inside: style(inside),
          before: style(before), after: style(after), first: style(first), second: style(second),
          boxes: { before: box(before), inner: box(inner), after: box(after), first: box(first), second: box(second) },
        };
      });
    });
    assert.equal(actual.length, 6, 'all six nested compositions render');
    const near = (value, expected, label) => assert.ok(Math.abs(value - expected) <= .5, `${label}: expected ${expected}, got ${value}`);
    for (const item of actual) {
      for (const value of [item.beforeGap, item.afterGap, item.innerGap]) assert.ok(Number.isFinite(value));
      if (['section-stack', 'section-columns', 'section-section'].includes(item.id)) {
        near(item.beforeGap, 8, item.id + ' preceding block spacing');
        near(item.afterGap, 8, item.id + ' following block spacing');
      } else if (item.id !== 'columns-section' || width === 390) {
        const gap = item.id === 'compact-section' ? 6 : 12;
        near(item.beforeGap, gap, item.id + ' preceding item spacing');
        near(item.afterGap, gap, item.id + ' following item spacing');
      } else {
        near(item.boxes.before.top, item.boxes.inner.top, 'columns first two items align at top');
        near(item.boxes.after.top, item.boxes.inner.top, 'columns last two items align at top');
        near(item.boxes.inner.left - item.boxes.before.right, 12, 'columns first horizontal gap');
        near(item.boxes.after.left - item.boxes.inner.right, 12, 'columns second horizontal gap');
      }
      if (item.id === 'section-columns' && width === 1280) {
        near(item.boxes.first.top, item.boxes.second.top, 'nested columns retain top alignment');
        near(item.boxes.second.left - item.boxes.first.right, 12, 'nested columns horizontal gap');
      } else near(item.innerGap, item.id === 'section-stack' || item.id === 'section-columns' ? 12 : 8, item.id + ' internal spacing');
      assert.equal(item.second.marginBottom, '0px', item.id + ' last inner block keeps zero margin');
      assert.equal(item.after.marginBottom, '0px', item.id + ' last outer block keeps zero margin');
    }
    const output = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
    if (output) {
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output,`nested-spacing-${width}-${theme}.json`),JSON.stringify({width,theme,sourceHead:process.env.ZYLOS_CHAT_SOURCE_HEAD,actual},null,2));
      await page.screenshot({path:path.join(output,`nested-spacing-${width}-${theme}.png`),fullPage:true,animations:'disabled',scale:'css'});
    }
    console.info('nested spacing geometry',JSON.stringify({width,theme,actual}));
    assert.equal(errors.length,0,errors.join('; '));assert.equal(outside.length,0,outside.join('; '));assert.equal(missing.length,0,missing.join('; '));
    await context.close();
  } finally {
    await browser?.close();server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));
  }
}
