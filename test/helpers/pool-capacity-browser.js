import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendHtml, serveStatic } from '../../skills/dashboard/src/lib/http.js';

const variants = {
  available: { used: 2, capacity: 4 },
  zero: { used: 0, capacity: 4 },
  full: { used: 4, capacity: 4 },
  aboveCapacity: { used: 4, capacity: 3 },
  unknownUsed: { used: null, capacity: 4 },
  unknownCapacity: { used: 2, capacity: null },
  unknownBoth: { used: null, capacity: null },
  queued: { used: 4, capacity: 4, waiting: 2 },
};

async function numericPoolView(page) {
  return page.evaluate(() => {
    const host = document.querySelector('#host'), strip = document.querySelector('.wb-pool');
    const shown = node => node.classList?.contains('wb-vh') ? '' : [...node.childNodes].map(child => child.nodeType === Node.TEXT_NODE ? child.textContent : shown(child)).join('');
    return { host: host.textContent, shown: shown(strip), tooltip: strip.title,
      notes: host.querySelectorAll('ul,li,.wb-host-pool-notes,.wb-host-pool-bucket').length,
      viewport: innerWidth, page: document.documentElement.scrollWidth,
      hostOverflow: host.scrollWidth - host.clientWidth,
      retiredReads: window.retiredReads,
      copy: window.poolCopy };
  });
}

export async function runPoolCapacityBrowser(sandbox) {
  console.log('Pool browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE, executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath)); assert.ok(executablePath && fs.existsSync(executablePath));
  const publicDir = path.resolve(fileURLToPath(new URL('../../skills/dashboard/public/', import.meta.url)));
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
    window.poolCopy = { host: t('wb.host.pool'), slots: t('wb.host.poolSlots'), pool: t('wb.inst.pool'),
      used: t('wb.inst.inUse'), unknown: t('wb.unknown'), hint: t('wb.inst.poolHint'), queued: t('wb.inst.queuedTech', {count:2}) };
    window.renderPool = value => {
      const pool = {used:value.used, capacity:value.capacity};
      window.retiredReads = 0;
      const retired = () => { window.retiredReads++; throw Error('Retired capacity provenance must not be read'); };
      Object.defineProperty(pool, 'capacityRecord', {get:retired});
      const instance = {pool}; Object.defineProperty(instance, 'poolCapacityRecord', {get:retired});
      instanceStrip(document.querySelector('#strip'), {mode:'multi',readAt:Date.now(),instance,
        groupCounts:{offline:{waitingSlot:value.waiting ?? 0}}}, {t,level:'technical'});
      renderHostPool(document.querySelector('#host'), {mode:'multi',pool}, {t});
    };
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
  let count = 0, sweepCount = 0;
  const sweepWidths = [...Array.from({ length: 37 }, (_, index) => 320 + index * 3), 430];
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
    for (const [name, value] of Object.entries(variants)) {
      await page.evaluate(value => window.renderPool(value), value);
      const actual = await numericPoolView(page);
      const amount = value.used == null ? actual.copy.unknown : value.capacity == null ? String(value.used) : value.used + ' / ' + value.capacity;
      assert.equal(actual.host, actual.copy.host + actual.copy.slots + amount, name + ': numeric host values only');
      const occupancy = value.used == null ? '—' : value.capacity == null ? String(value.used) : value.used + ' / ' + value.capacity;
      assert.equal(actual.shown, occupancy + (value.waiting ? '· ' + actual.copy.queued : ''), name + ': numeric occupancy and queue');
      assert.equal(actual.tooltip, [actual.copy.pool, value.used == null ? actual.copy.unknown : actual.copy.used + ' ' + occupancy,
        value.waiting ? actual.copy.queued : '', actual.copy.hint].filter(Boolean).join(' · '), name + ': tooltip has no capacity provenance');
      assert.equal(actual.notes, 0, name + ': no algorithm, source or bucket notes');
      assert.equal(actual.retiredReads, 0, name + ': neither renderer reads retired fields');
      assert.equal(pageError, undefined, pageError); assert.equal(serverError, undefined, serverError);
      assert.ok(actual.page <= actual.viewport && actual.hostOverflow <= 1, JSON.stringify({name,width,theme,actual}));
      if (evidence && name === 'available') await page.screenshot({path:path.join(evidence, `pool-capacity-${locale}-${width}-${theme}.png`),fullPage:true});
      count++;
    }
    if (locale === 'zh' && width === 390) {
      await page.evaluate(value => window.renderPool(value), variants.queued);
      for (const sweepWidth of sweepWidths) {
        await page.setViewportSize({width:sweepWidth,height:900});
        const actual = await numericPoolView(page);
        assert.equal(actual.notes, 0);
        assert.equal(actual.retiredReads, 0);
        assert.ok(actual.page <= actual.viewport && actual.hostOverflow <= 1, JSON.stringify({sweepWidth,theme,actual}));
        sweepCount++;
      }
    }
    await context.close();
  }
  console.log(`Pool browser: ${count} real-module states verified`);
  console.log(`Pool browser: ${sweepCount} queued zh width measurements (${sweepWidths.join(',')}) across light/dark; no capacity-provenance reads or notes`);
}
