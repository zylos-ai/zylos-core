import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendHtml, serveStatic } from '../../src/lib/http.js';

const GiB = 1024 ** 3;
const fitted = {
  valid: true, fresh: true, source: 'auto', reason: 'memory', limitedBy: 'model', kMemory: 4,
  memory: { source: 'cgroup2', limitBytes: 8 * GiB, usedBytes: 3617128448, reserveBytes: 858993459 },
  model: { state: 'fitted', slopeBytes: 268435456, interceptBytes: 6138175488, windowDays: 7,
    buckets: [8011563008, 8007245824, 6684057600, 7211917312, 7517503488, 7675977728, 6677467136]
      .map((highBytes, i) => ({ n: i + 1, highBytes, hours: 7, samples: [2511, 2424, 322, 152, 97, 65, 81][i] })) },
};
const variants = {
  fitted,
  accumulating: { ...fitted, limitedBy: 'live', model: { state: 'default', slopeBytes: 512 * 1024 ** 2,
    windowDays: 7, buckets: [fitted.model.buckets[0]] } },
  empty: { ...fitted, limitedBy: 'live', model: { state: 'default', slopeBytes: 512 * 1024 ** 2, windowDays: 7, buckets: [] } },
  floor: { ...fitted, reason: 'floor' },
  fixed: { ...fitted, source: 'fixed', reason: 'fixed' },
  fallback: { valid: true, fresh: true, source: 'fallback', reason: 'inputs_unreadable' },
  stale: { ...fitted, fresh: false },
  missing: { valid: false, fresh: false },
};

export async function runPoolCapacityBrowser(sandbox) {
  console.log('Pool browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE, executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath)); assert.ok(executablePath && fs.existsSync(executablePath));
  const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/css/style.css"><link rel="stylesheet" href="/themes/light.css"><link rel="stylesheet" href="/themes/dark.css">
    <link rel="stylesheet" href="/css/wb.css"><link rel="stylesheet" href="/css/wb-icons.css">
    <style>body{margin:0;padding:16px;background:var(--bg);color:var(--text);font-family:Arial,sans-serif}#strip{display:flex;flex-wrap:wrap;gap:12px}#host{max-width:680px;margin-top:20px}section{min-width:0}</style></head>
    <body><div id="strip"></div><section id="host"></section><script type="module">
    import { instanceStrip } from '/_assets/js/wb/instance-strip.js';
    import { renderHostPool } from '/_assets/js/wb/host-panel.js';
    const locale = new URL(location.href).searchParams.get('locale') || 'zh';
    document.documentElement.lang = locale;
    const strings = await (await fetch('/i18n/wb.' + locale + '.json')).json();
    const t = (key, params = {}) => { let value = strings[key] ?? key; for (const [name, text] of Object.entries(params)) value = value.replaceAll('{' + name + '}', text); return value; };
    window.renderPool = record => { const pool = {used:2, capacity:record.source === 'fixed' ? 6 : 4, capacityRecord:record};
      instanceStrip(document.querySelector('#strip'), {mode:'multi',readAt:Date.now(),instance:{pool}}, {t,level:'technical'});
      renderHostPool(document.querySelector('#host'), {mode:'multi',pool}, {t}); };
    window.ready = true;
    </script></body></html>`;
  let serverError;
  const server = http.createServer((req, res) => {
    try {
      if (new URL(req.url, 'http://localhost').pathname === '/') return sendHtml(res, 200, html);
      if (!serveStatic(req, res, publicDir)) { res.writeHead(404); res.end(); }
    } catch (error) { serverError ??= error.message; res.writeHead(500); res.end(); }
  });
  const base = await sandbox.startHttp(server);
  const { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  let count = 0;
  for (const locale of ['zh', 'en']) for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    sandbox.addCleanup(() => context.close());
    await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    let pageError, consoleError, responseError;
    page.on('pageerror', error => { pageError ??= error.message; });
    page.on('console', message => { if (message.type() === 'error') consoleError ??= message.text(); });
    page.on('response', response => { if (response.status() >= 400) responseError ??= `${response.status()} ${response.url()}`; });
    await page.goto(base + '/?locale=' + locale);
    try { await page.waitForFunction(() => window.ready === true); }
    catch (error) { throw new Error(JSON.stringify({ pageError, consoleError, responseError, serverError, body: await page.locator('body').innerHTML() }), { cause: error }); }
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const [name, record] of Object.entries(variants)) {
      await page.evaluate(record => window.renderPool(record), record);
      const text = await page.locator('#host').innerText(), tooltip = await page.locator('.wb-pool').getAttribute('title');
      const freshAuto = record.valid && record.fresh && record.source === 'auto';
      assert.equal(/上限 =|Limit =/.test(text), Boolean(freshAuto), name + ': algorithm visibility');
      assert.equal(/由近 7 天各档|由眼下剩余|由手动设定|由下限托|Determined by|minimum keeps the limit/.test(text), Boolean(record.valid && record.fresh && record.source !== 'fallback'), name + ': decision visibility');
      assert.equal(/2511/.test(text), Boolean(record.model?.buckets?.length), name + ': bucket visibility');
      assert.equal(/2511/.test(tooltip), false, 'Long bucket list stays out of tooltip');
      if (locale === 'zh' && name === 'fitted') {
        assert.ok(text.includes('已用 3.37 GiB（不含文件缓存和交换区）'), text);
        assert.ok(text.includes('固定开销约 5.72 GiB（各档的中间值）'), text);
        assert.ok(text.includes('1 个会话时一般最高 7.46 GiB（7 个小时、2511 个样本）'), text);
        assert.ok(tooltip.includes('由近 7 天各档的用量决定'), tooltip);
      }
      if (locale === 'en' && name === 'fitted') {
        assert.ok(text.includes('Session count 1: typical peak 7.46 GiB (7 h, 2511 samples); Session count 2:'), text);
        assert.doesNotMatch(text, /；|1 sessions/);
      }
      assert.equal(pageError, undefined, pageError); assert.equal(serverError, undefined, serverError);
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth,
        notes: [...document.querySelectorAll('#host li')].map(node => ({ width: node.clientWidth, scroll: node.scrollWidth })) }));
      assert.ok(geometry.page <= geometry.viewport, JSON.stringify({ name, width, theme, geometry }));
      for (const note of geometry.notes) assert.ok(note.scroll <= note.width + 1, JSON.stringify({ name, width, theme, note }));
      if (evidence && name === 'fitted') await page.screenshot({ path: path.join(evidence, `pool-capacity-${locale}-${width}-${theme}.png`), fullPage: true });
      count++;
    }
    await context.close();
  }
  console.log(`Pool browser: ${count} real-module states verified`);
}
