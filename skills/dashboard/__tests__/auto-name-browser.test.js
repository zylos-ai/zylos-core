import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { startPage } from './helpers/workbench-browser.js';

// Boundary: the real shell, confirmation/result dialogs, translations and shipped CSS.
// Run for naming lifecycle or machine-identity handling; unrelated server/layout changes may skip.
// API responses and identity are injected; polling is held so A -> B -> A happens before a read.
// Runner + sandbox prove HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/private socket and DB paths.
// No model, tmux, PM2 or database starts; teardown closes every browser/context/server on failure.
test('automatic naming recovers after a machine round trip in the browser', {
  skip: !chatEnabled(), timeout: 90000,
}, async t => {
  const sandbox = createChatSandbox(t);
  await sandbox.runCase(async () => {
    console.log('Naming browser isolation:', JSON.stringify(sandbox.assertIsolation()));
    const { base } = await startPage(sandbox);
    const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
    const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN,
      headless: true, env: sandbox.env,
      args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
    sandbox.addCleanup(() => browser.close());
    const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
    if (evidence) fs.mkdirSync(evidence, { recursive: true });
    let failed = false;
    for (const width of [1280, 390]) for (const locale of ['zh', 'en']) for (const theme of ['light', 'dark']) {
      if (failed) return; // A single counterexample is enough; do not launch more cases.
      await t.test(`${width}px ${locale} ${theme}`, async () => {
        const context = await browser.newContext({ viewport: { width, height: 844 } });
        sandbox.addCleanup(() => context.close());
        try {
          await context.route('**/*', route => {
            const url = route.request().url();
            if (!url.startsWith(base + '/')) return route.abort();
            // Mount the real shell explicitly, with controllable identity/transport, instead of the app bootstrap.
            if (url.endsWith('/vendor/chart.umd.js')) return route.fulfill({ path: process.env.ZYLOS_CHAT_CHART_ASSET, contentType: 'application/javascript' });
            if (url.endsWith('/js/app.js')) return route.fulfill({ contentType: 'application/javascript', body: '' });
            return route.continue();
          });
          const page = await context.newPage(); page.setDefaultTimeout(5000);
          const errors = []; page.on('pageerror', error => { if (errors.length < 3) errors.push(error.message); });
          await page.goto(base + '/');
          await page.evaluate(async ({ locale, theme }) => {
            const { mountWorkbench } = await import('/_assets/js/wb/shell.js');
            const { mountMobileNavigation } = await import('/_assets/js/wb/mobile-navigation.js');
            const i18n = await import('/_assets/js/i18n.js');
            i18n.setAssetRoot('/_assets'); await i18n.initI18n(locale);
            document.documentElement.dataset.theme = theme; i18n.renderI18n();
            document.querySelector('#agent-detail').hidden = false;
            mountMobileNavigation({ document, t: i18n.t });
            // Hold only background polling; product promises and DOM events run normally.
            const interval = window.setInterval;
            window.setInterval = () => 0;
            const state = window.namingCase = { owner: 'A', release: null };
            state.shell = mountWorkbench({ t: i18n.t, identity: () => state.owner,
              fetch: (url, options) => url.endsWith('/naming-prompt')
                ? new Promise(resolve => { state.release = () => resolve(new Response(JSON.stringify({ ok: true, controlId: 42, sessionGroup: 'origin' })) ); })
                : fetch(url, options) });
            window.setInterval = interval;
          }, { locale, theme });
          await page.waitForFunction(() => document.querySelectorAll('#wb-board .wb-row').length > 0);
          await page.locator('#wb-auto-name').click();
          await page.locator('.wb-modal:not(#wb-auto-name-dialog) .wb-btn-primary').click();
          await page.waitForFunction(() => window.namingCase.release !== null);
          assert.equal(await page.locator('#wb-auto-name').isDisabled(), true);
          await page.evaluate(() => { window.namingCase.owner = 'B'; window.namingCase.release(); });
          await page.waitForFunction(() => document.querySelector('#wb-auto-name-dialog').hidden);
          await page.evaluate(() => { window.namingCase.owner = 'A'; });
          assert.equal(await page.locator('#wb-auto-name').isEnabled(), true);
          assert.equal(await page.locator('#wb-auto-name-dialog').isHidden(), true);
          await page.locator('#wb-auto-name').click();
          await page.locator('.wb-modal:not(#wb-auto-name-dialog) .wb-btn:not(.wb-btn-primary)').click();
          assert.equal(await page.locator('#wb-auto-name').isEnabled(), true);
          await page.locator('#wb-auto-name').blur(); await page.mouse.move(0, 0);
          if (evidence) await page.screenshot({ path: path.join(evidence, `${width}-${locale}-${theme}-recovered.png`) });
          assert.deepEqual(errors, [], 'no browser script error');
          await page.evaluate(() => window.namingCase.shell.destroy());
        } catch (error) { failed = true; throw error; } finally { await context.close(); }
      });
    }
  }, { timeoutMs: 80000 });
});
