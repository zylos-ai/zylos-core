import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createChatSandbox, chatEnabled } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';
import { sendHtml, sendJson, serveStatic } from '../skills/dashboard/src/lib/http.js';
import { workbenchSnapshot, workbenchSnapshotAnswer } from '../skills/dashboard/__tests__/fixtures/workbench-browser-api.js';

// Real mounted Dashboard against identical fixed read-only API observations;
// baseline/head assets are compared at desktop/phone x English/Chinese x light/dark.
// Run for demand polling/collector changes; skip unrelated backend changes.
// Gated sandbox owns browser/HTTP resources and never starts a runtime or live DB.
test('Dashboard demand polling preserves group page and instance strip visuals', {
  skip: !chatEnabled() || !process.env.ZYLOS_CHAT_BASELINE_PUBLIC, timeout: 90000,
}, async t => {
  const s = createChatSandbox(t); s.env.TZ = 'Asia/Singapore';
  await s.runCase(async () => {
    console.log('Visual isolation:', JSON.stringify({ ...s.assertIsolation(), TZ: s.env.TZ }));
    const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
    const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: s.env, args: ['--no-sandbox','--disable-background-networking','--disable-component-update','--no-first-run'] });
    s.addCleanup(() => browser.close());
    const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR; assert(evidence); fs.mkdirSync(evidence, { recursive: true });
    const now = 1800000000000, streams = new Set();
    s.addCleanup(() => { for(const stream of streams) stream.end(); });
    let publicDir;
    const server = http.createServer((req,res) => {
      const url = new URL(req.url, 'http://fixture'), p = url.pathname;
      if(p === '/api/stream') { res.writeHead(200, { 'content-type':'text/event-stream' }); res.write(': ready\n\n'); streams.add(res); res.once('close', () => streams.delete(res)); return; }
      if(p.startsWith('/api/')) {
        const snapshot = workbenchSnapshot(now);
        // A relay has no native account quota. Both native runtimes must show —.
        snapshot.instance.accounts = { claude: null, codex: null };
        const value = workbenchSnapshotAnswer(url, snapshot, now);
        return sendJson(res, value === undefined ? 404 : 200, value ?? {error:'not_found'});
      }
      if(p === '/') return sendHtml(res,200,fs.readFileSync(path.join(publicDir,'index.html'),'utf8').replaceAll('__BASE_PATH__','').replaceAll('__ASSET_ROOT__','/_assets').replaceAll('__REMOTE_ACCESS__','admin'));
      if(!serveStatic(req,res,publicDir)) sendJson(res,404,{error:'not_found'});
    });
    const base = await s.startHttp(server), results = [];
    for(const version of ['baseline','head']) {
      publicDir = version === 'baseline' ? process.env.ZYLOS_CHAT_BASELINE_PUBLIC : path.resolve(fileURLToPath(new URL('../skills/dashboard/public/',import.meta.url)));
      for(const width of [1280,390]) for(const locale of ['en','zh']) for(const theme of ['light','dark']) {
        const context = await browser.newContext({viewport:{width,height:900},locale:locale === 'zh'?'zh-CN':'en-US',reducedMotion:'reduce'});
        try {
          await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
          await context.addInitScript(({locale,theme}) => {try {localStorage.setItem('zylos-dashboard-theme',theme);localStorage.setItem('zylos-dashboard-locale',locale);} catch {}}, {locale,theme});
          const page = await context.newPage(); page.setDefaultTimeout(10000);
          await page.clock.install({time:now});
          const errors=[]; page.on('pageerror',error=>{ if (!errors.length) errors.push(error.message); });
          await page.goto(base);
          try { await page.locator('.wb-row[data-group]').first().waitFor(); } catch(error) { await page.screenshot({path:path.join(evidence,`${version}-${width}-${locale}-${theme}-failure.png`)}); throw new Error(`${version} ${width} ${locale} ${theme}: ${errors.join('; ')}; ${await page.locator('body').innerText()}`); }
          await page.clock.pauseAt(now+1000);
          await page.screenshot({path:path.join(evidence,`${version}-${width}-${locale}-${theme}-groups.png`),animations:'disabled'});
          const stripSelector = '#wb-instance';
          const stripText = await page.locator(stripSelector).innerText();
          assert.match(stripText,/—/, 'Relay quota retains unavailable marker');
          await page.locator(stripSelector).screenshot({path:path.join(evidence,`${version}-${width}-${locale}-${theme}-strip.png`),animations:'disabled'});
          assert.equal(errors.length,0,errors[0]);
          results.push({version,width,locale,theme,stripText});
        } finally {await context.close();}
      }
    }
    for(const width of [1280,390]) for(const locale of ['en','zh']) for(const theme of ['light','dark']) for(const kind of ['groups','strip']) {
      const suffix = `${width}-${locale}-${theme}-${kind}.png`;
      assert(fs.readFileSync(path.join(evidence,`baseline-${suffix}`)).equals(fs.readFileSync(path.join(evidence,`head-${suffix}`))), `Screenshot changed: ${suffix}`);
    }
    fs.writeFileSync(path.join(evidence,'visual-matrix.json'),JSON.stringify(results,null,2));
  }, {timeoutMs:85000});
});
