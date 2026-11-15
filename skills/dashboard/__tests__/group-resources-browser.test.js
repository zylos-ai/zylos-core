import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { startPage } from './helpers/workbench-browser.js';
import { openDashboardTab } from './helpers/browser-navigation.js';

// Boundary: real page/modules/styles with inert loopback HTTP answers, both list sides, group detail,
// resource/usage/settings consumers and responsive width. Run when these API consumers or layouts change;
// skip unrelated runtime-only work. The runner and sandbox prove private HOME/ZYLOS_DIR/PM2_HOME/short
// TMPDIR/socket/database paths before HTTP. No runtime, PM2, tmux, live database or external service runs.
// Sandbox teardown owns server/browser/context closure on success, failure and timeout.
test('separate group and instance resources render across desktop and phone pages',
  { skip: !chatEnabled(), timeout: 180_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      console.info('Resource page isolation:', JSON.stringify(sandbox.assertIsolation()));
      const fixture = await startPage(sandbox);
      const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
      const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, env: sandbox.env, headless: true,
        args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
      sandbox.addCleanup(() => browser.close());
      const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
      if (evidence) fs.mkdirSync(evidence, { recursive: true });
      for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({ viewport: { width, height: 1000 } });
        sandbox.addCleanup(() => context.close());
        await context.route('**/*', route => route.request().url().startsWith(fixture.base + '/') ? route.continue() : route.abort());
        await context.addInitScript(theme => { try { localStorage.setItem('zylos-dashboard-theme', theme); localStorage.setItem('zylos-dashboard-detail-level', 'technical'); localStorage.setItem('zylos-dashboard-locale', 'en'); } catch {} }, theme);
        const page = await context.newPage(); page.setDefaultTimeout(10000);
        const errors = []; page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
        const shot = async name => {
          await page.evaluate(() => document.fonts.ready);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, name + ' fits viewport');
          if (evidence) await page.screenshot({ path: path.join(evidence, `${width}-${theme}-${name}.png`), fullPage: true });
        };
        try {
          await page.goto(fixture.base + '/');
          await page.locator('#wb-board .wb-row').first().waitFor();
          assert.equal(await page.locator('#wb-board .wb-row').count(), 2);
          await shot('overview-running');
          await page.locator('#wb-host-open').click();
          await page.locator('.wb-host-body').waitFor();
          await shot('instance-resources');
          await page.locator('#wb-host-close').click();
          await page.getByRole('button', { name: 'Offline · 2', exact: true }).click();
          await page.waitForFunction(() => document.querySelectorAll('#wb-board .wb-row').length === 1);
          const heldRefresh = fixture.holdOffline();
          await heldRefresh.waiting;
          await page.getByRole('button', { name: 'Load more offline groups', exact: true }).click();
          await page.waitForFunction(() => document.querySelectorAll('#wb-board .wb-row').length === 2);
          heldRefresh.release();
          await page.waitForTimeout(200);
          assert.equal(await page.locator('#wb-board .wb-row').count(), 2, 'the earlier first-page refresh cannot discard a loaded second page');
          const nextRefresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/groups/offline' && !new URL(response.url()).searchParams.has('cursor'));
          await nextRefresh;
          await page.waitForFunction(() => document.querySelectorAll('#wb-board .wb-row').length === 2);
          await shot('overview-offline');
          await page.locator('#wb-board .wb-row').first().click();
          await page.getByRole('heading', { name: 'Usage', exact: true }).waitFor();
          await shot('group-detail');
          const detailUsage = page.locator('#wb-side .wb-detail-body > .wb-ip-card').last();
          await detailUsage.scrollIntoViewIfNeeded();
          await shot('group-detail-usage');
          await page.keyboard.press('Escape');
          for (const [tab, selector] of [['trends', '#wb-usage-body .wb-usage-summary'], ['settings', '#settings-defaults'], ['schedule', '#wb-schedule'], ['memory', '#tab-memory'], ['chat', '#wb-chat']]) {
            await openDashboardTab(page, tab);
            await page.locator(selector).waitFor({ state: 'visible' });
            await shot(tab);
          }
          assert.deepEqual(errors, [], 'no product script errors');
          console.info('Captured resource pages:', JSON.stringify({ width, theme, reads: Object.fromEntries(fixture.reads), unserved: [...fixture.unserved].slice(0, 10) }));
        } finally { await context.close(); }
      }
    }, { timeoutMs: 170_000 });
  });
