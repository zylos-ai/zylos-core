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
test('automatic naming preserves machine identity, permission explanations and transport outcomes in the browser', {
  skip: !chatEnabled(), timeout: 200000,
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
            const state = window.namingCase = { t: i18n.t, owner: 'A', release: null, writable: true, reply: { status: 200, body: { ok: true, controlId: 42, sessionGroup: 'origin' } } };
            state.shell = mountWorkbench({ t: i18n.t, identity: () => state.owner, writable: () => state.writable,
              fetch: (url, options) => url.endsWith('/naming-prompt')
                ? new Promise((resolve, reject) => { state.release = () => state.reply.network
                  ? reject(new TypeError('Failed to fetch'))
                  : resolve(new Response(JSON.stringify(state.reply.body), { status: state.reply.status })); })
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
          // Same shell and real fetchJson/result renderer: exercise HTTP and transport outcomes.
          // Run on naming error/copy changes. Private fixture transport only; no remote agent or C4 starts.
          for (const scenario of [
            { name: 'sent', status: 200, body: { ok: true, controlId: 42, sessionGroup: 'origin' }, key: 'wb.name.sent' },
            ...['not_allowed_via_fleet', 'admin_required', 'insufficient_scope', 'same_origin_required', 'unauthorized'].map(code => ({
              name: code, status: code === 'unauthorized' ? 401 : 403, body: { ok: false, error: { code, message: code === 'not_allowed_via_fleet'
                ? "This change can't be made when opening another agent from the fleet" : code } } })),
            { name: 'client-rejection', status: 400, body: { error: { code: 'invalid_json' } }, key: 'wb.name.rejected' },
            { name: 'server-failure', status: 503, body: { error: { code: 'unavailable' } }, key: 'wb.name.failed' },
            { name: 'unknown', status: 502, body: { unknown: true, error: { code: 'RESULT_UNKNOWN' } }, key: 'wb.name.unknown' },
            { name: 'network', network: true, key: 'wb.name.unknown' },
          ]) {
            await page.evaluate(reply => { window.namingCase.reply = reply; window.namingCase.release = null; }, scenario);
            await page.locator('#wb-auto-name').click();
            const capture = async state => {
              await page.locator(':focus').evaluateAll(nodes => nodes.forEach(node => node.blur()));
              await page.mouse.move(0, 0);
              assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no page overflow');
              const dialog = page.locator('.wb-modal:visible').last();
              const box = await dialog.boundingBox();
              assert.ok(box.x >= 0 && box.x + box.width <= width + 1, 'dialog fits viewport');
              if (evidence) await page.screenshot({ path: path.join(evidence, `${width}-${locale}-${theme}-${state}.png`) });
            };
            if (scenario.name === 'sent') await capture('confirmation');
            await page.locator('.wb-modal:not(#wb-auto-name-dialog) .wb-btn-primary').click();
            await page.waitForFunction(() => window.namingCase.release !== null);
            if (scenario.name === 'sent') await capture('sending');
            await page.evaluate(() => window.namingCase.release());
            await page.locator('#wb-auto-name-dialog button').waitFor();
            const message = await page.locator('#wb-auto-name-dialog .wb-name-status').textContent();
            if (scenario.key) assert.equal(message, await page.evaluate(key => window.namingCase.t(key), scenario.key));
            else {
              assert.doesNotMatch(message, /稍后再试|try again later|not_allowed_via_fleet/i);
              assert.equal(await page.locator('#wb-auto-name-dialog details').getAttribute('open'), null);
              assert.equal(await page.locator('#wb-auto-name-dialog details pre').textContent(),
                scenario.body.error.message === scenario.name ? scenario.name : `${scenario.name} · ${scenario.body.error.message}`);
            }
            await capture(scenario.name);
            if (scenario.name === 'not_allowed_via_fleet') {
              await page.evaluate(() => { const toggle = document.querySelector('#wb-detail-toggle'); toggle.checked = !toggle.checked; toggle.dispatchEvent(new Event('change', { bubbles: true })); });
              await page.locator('#wb-auto-name-dialog details summary').click();
              assert.equal(await page.locator('#wb-auto-name-dialog details pre').isVisible(), true);
              await capture('permission-detail');
              await page.evaluate(() => { const toggle = document.querySelector('#wb-detail-toggle'); toggle.checked = !toggle.checked; toggle.dispatchEvent(new Event('change', { bubbles: true })); });
            }
            await page.locator('#wb-auto-name-dialog button').click();
          }
          await page.evaluate(() => { window.namingCase.writable = false; window.namingCase.shell.setViewDetail(); });
          await page.waitForFunction(() => document.querySelector('#wb-auto-name').disabled);
          assert.equal(await page.locator('#wb-auto-name').isDisabled(), true);
          if (evidence) await page.screenshot({ path: path.join(evidence, `${width}-${locale}-${theme}-read-only.png`) });
          assert.deepEqual(errors, [], 'no browser script error after all outcomes');
          await page.evaluate(() => window.namingCase.shell.destroy());
        } catch (error) { failed = true; throw error; } finally { await context.close(); }
      });
    }
  }, { timeoutMs: 190000 });
});
