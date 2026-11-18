import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';
import { startPage } from '../skills/dashboard/__tests__/helpers/workbench-browser.js';
import { openDashboardTab } from '../skills/dashboard/__tests__/helpers/browser-navigation.js';
import { BUDGETS, WARN_THRESHOLDS, measureMemoryText } from '../skills/zylos-memory/scripts/memory-budget.js';

// Boundary: actual Dashboard modules/styles/i18n with measured budget payloads, eight view combinations.
// Run when memory budget copy, payload or presentation changes; unrelated changes may skip.
// Harness proves private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/database targets before browser/HTTP.
// No DB, tmux or runtime starts; bounded browser cleanup is registered before connection.
test('memory budget display shows both startup dimensions at phone and desktop widths',
  { skip: !chatEnabled(), timeout: 150_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { base, actions } = await startPage(sandbox);
      const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE;
      const executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
      const chartAsset = process.env.ZYLOS_CHAT_CHART_ASSET;
      for (const target of [modulePath, executablePath, chartAsset]) assert.ok(target && fs.existsSync(target));
      const { chromium } = await import(pathToFileURL(modulePath));
      t.diagnostic(JSON.stringify(sandbox.assertIsolation()));
      const server = await chromium.launchServer({ executablePath, headless: true, env: sandbox.env, timeout: 15_000,
        args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
      sandbox.addCleanup(async () => {
        const child = server.process();
        const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
        try { await server.close(); } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
      });
      const browser = await chromium.connect(server.wsEndpoint(), { timeout: 15_000 });
      const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
      if (evidence) fs.mkdirSync(evidence, { recursive: true });
      for (const width of [1280, 390]) for (const locale of ['en', 'zh']) for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        sandbox.addCleanup(() => context.close());
        try {
          await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
          await context.route('**/_assets/vendor/chart.umd.js', route => route.fulfill({ path: chartAsset, contentType: 'text/javascript' }));
          await context.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
          await context.addInitScript(({ locale, theme }) => {
            try { localStorage.setItem('zylos-dashboard-locale', locale);
            localStorage.setItem('zylos-dashboard-theme', theme);
            localStorage.setItem('zylos-dashboard-detail-level', 'technical'); } catch {}
          }, { locale, theme });
          const page = await context.newPage(); page.setDefaultTimeout(10_000);
          const errors = [];
          page.on('pageerror', error => { if (errors.length < 3) errors.push(error.message); });
          await page.route('**/api/memory/backlog', route => route.fulfill({ json: {
            groups: [], hasOlder: false, budgets: { limits: BUDGETS, warnings: WARN_THRESHOLDS,
              checks: { 'identity.md': measureMemoryText('identity.md', '中'.repeat(3000)),
                'references.md': measureMemoryText('references.md', 'a'.repeat(8000)) } },
          } }));
          await page.goto(base + '/');
          await openDashboardTab(page, 'memory');
          const chart = page.locator('.wb-memory-budgets');
          await chart.waitFor();
          await page.waitForFunction(() => document.querySelector('.wb-memory-budgets')?.textContent.includes('2139'));
          const content = await chart.innerText();
          assert.ok(content.includes('3000/9759') && content.includes('2308/2139'), content);
          assert.ok(content.includes('8000/9759') && content.includes('2000/2139'), content);
          assert.ok(content.includes(locale === 'en' ? 'Exceeds startup display limit' : '超过启动显示上限'));
          assert.equal(await chart.locator('.excess').count(), 1);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width} ${locale} ${theme} page fits`);
          const clipped = await chart.locator('.wb-memory-chart-value').evaluateAll(nodes => nodes.some(node => node.scrollWidth > node.clientWidth + 1));
          assert.equal(clipped, false, `${width} ${locale} ${theme} values fit`);
          await page.evaluate(() => document.activeElement?.blur()); await page.mouse.move(0, 0);
          if (evidence) await page.screenshot({ path: path.join(evidence, `memory-${width}-${locale}-${theme}.png`), fullPage: true });
          assert.deepEqual(errors, []);
          t.diagnostic(`${width} ${locale} ${theme}: both dimensions, warning/over and overflow checks passed`);
        } finally { await context.close(); }
      }
      assert.deepEqual(actions, []);
    }, { timeoutMs: 140_000 });
    assert.equal(fs.existsSync(sandbox.root), false);
    assert.equal(sandbox.children.size, 0);
  });
