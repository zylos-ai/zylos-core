import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateToFleetRecord } from '../../src/lib/fleet-poller.js';
import { startPage } from './workbench-browser.js';

export async function runFleetCardBrowser(t, sandbox) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE;
  const executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  const chartAsset = process.env.ZYLOS_CHAT_CHART_ASSET;
  for (const filename of [modulePath, executablePath, chartAsset]) assert.ok(filename && fs.existsSync(filename), 'explicit installed browser dependencies required');
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const { base } = await startPage(sandbox);
  const { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(async () => { await browser.close(); assert.equal(browser.isConnected(), false); });
  const make = (name, state, extra = {}) => stateToFleetRecord({ name }, { state, session_mode: 'single', ...extra }, { nowMs: 0 });
  const fleet = { agents: [make('Busy remote', 'BUSY'), make('Idle remote', 'IDLE')], updated_at: new Date().toISOString() };
  // Deliberately include removed observations: card output must not revive Origin details.
  for (const record of fleet.agents) Object.assign(record, { has_subagent: true, subagent_count: 37 });
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    await t.test(`${width}px ${theme} Fleet cards retain aggregate status without Origin child badges`, async () => {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, locale: 'en-US',
        ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
      sandbox.addCleanup(() => context.close());
      try {
        await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
        await context.route('**/_assets/vendor/chart.umd.js', route => route.fulfill({ path: chartAsset, contentType: 'text/javascript' }));
        await context.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
        await context.addInitScript(({ theme }) => {
          try {
            localStorage.setItem('zylos-dashboard-locale', 'en');
            localStorage.setItem('zylos-dashboard-theme', theme);
            localStorage.setItem('zylos-dashboard-detail-level', 'technical');
          } catch {}
        }, { theme });
        const page = await context.newPage(), errors = [];
        page.setDefaultTimeout(10_000);
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/api/fleet', route => route.fulfill({ json: fleet }));
        await page.goto(base + '/');
        const busy = page.locator('.wb-f-card[data-agent="Busy remote"]');
        await busy.waitFor();
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        assert.equal(await page.locator('.fleet-subagent-badge').count(), 0);
        assert.match(await busy.innerText(), /Working/);
        assert.doesNotMatch(await busy.innerText(), /Standing by/);
        assert.equal(await busy.locator('.wb-f-act > :not(.wb-pill)').count(), 0);
        assert.equal(await busy.getAttribute('data-state'), 'busy');
        assert.match(await page.locator('.agent-fleet-summary').innerText(), /1 Working/);
        assert.doesNotMatch(await page.locator('#agent-fleet-root').innerText(), /Subagent|⚡37/);
        const geometry = await page.evaluate(() => ({
          viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
          cards: [...document.querySelectorAll('.wb-f-card')].map(card => {
            const box = card.getBoundingClientRect();
            return { name: card.dataset.agent, left: box.left, right: box.right, width: box.width,
              scrollWidth: card.scrollWidth, clientWidth: card.clientWidth,
              status: [...card.querySelectorAll('.wb-f-act')].map(node => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth })) };
          }),
        }));
        assert.ok(geometry.scrollWidth <= width, 'no page overflow');
        for (const card of geometry.cards) {
          assert.ok(card.left >= 0 && card.right <= width, 'card inside viewport');
          assert.ok(card.scrollWidth <= card.clientWidth, 'no card overflow');
          for (const row of card.status) assert.ok(row.scrollWidth <= row.clientWidth, 'no status clipping');
        }
        assert.deepEqual(errors, []);
        // Inspect actual loaded resource entries, proving cache-busted import paths reach the browser.
        const assets = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname + new URL(entry.name).search));
        for (const asset of ['/js/app.js?v=233', '/js/agent-fleet.js?v=210', '/js/fleet-sounds.js?v=210', '/css/style.css?v=65', '/css/wb.css?v=72']) {
          assert.ok(assets.includes('/_assets' + asset), `loaded ${asset}`);
        }
        console.log('Fleet card geometry:', JSON.stringify({ width, theme, ...geometry }));
        if (evidence) {
          const filename = path.join(evidence, `fleet-cards-${width}-${theme}.png`);
          await page.mouse.move(0, 0);
          await page.locator('body').click({ position: { x: 1, y: 1 } });
          await page.screenshot({ path: filename, fullPage: true });
          fs.writeFileSync(path.join(evidence, `fleet-cards-${width}-${theme}.json`), JSON.stringify({ geometry, assets }, null, 2));
          console.log('Fleet card screenshot:', filename);
        }
      } finally { await context.close(); }
    });
  }
}
