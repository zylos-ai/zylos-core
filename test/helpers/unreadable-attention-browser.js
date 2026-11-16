import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateToFleetRecord } from '../../skills/dashboard/src/lib/fleet-poller.js';
import { workbenchAnswer } from '../../skills/dashboard/__tests__/fixtures/workbench-browser-api.js';
import { startPage } from '../../skills/dashboard/__tests__/helpers/workbench-browser.js';
import { openDashboardTab, openMobileMore } from '../../skills/dashboard/__tests__/helpers/browser-navigation.js';

export async function runUnreadableAttentionBrowser(sandbox) {
  console.log('Unreadable attention isolation:', JSON.stringify(sandbox.assertIsolation()));
  const { base, actions } = await startPage(sandbox);
  const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true,
    env: sandbox.env, args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  for (const width of [390, 1280]) for (const locale of ['zh', 'en']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce',
      locale: locale === 'zh' ? 'zh-CN' : 'en-US' });
    try {
      await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
      await context.route('**/_assets/vendor/chart.umd.js', route => route.fulfill({
        path: process.env.ZYLOS_CHAT_CHART_ASSET, contentType: 'text/javascript' }));
      await context.addInitScript(locale => {
        try {
          localStorage.setItem('zylos-dashboard-locale', locale);
          localStorage.setItem('zylos-dashboard-theme', 'light');
          localStorage.setItem('zylos-dashboard-detail-level', 'plain');
        } catch {}
      }, locale);
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(10_000);
      page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
      const now = Date.now();
      const toggleDetails = async () => {
        if (width === 390) {
          await openMobileMore(page);
          await page.locator('[data-mobile-action="detail"]').click();
          await page.keyboard.press('Escape');
        } else await page.locator('#wb-tech-btn').click();
      };
      const openMachines = async () => {
        if (width === 390) {
          await openMobileMore(page);
          await page.locator('[data-mobile-action="machines"]').click();
        } else await page.locator('#fleet-manage-btn').click();
      };
      await page.route('**/api/**', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/fleet') {
          const record = (name, self) => stateToFleetRecord({ name }, { state: 'IDLE', session_mode: 'multi',
            group_summary: { running: 1, listKnown: true, counts: { busy: 0, idle: 1, waiting: 0, unknown: 0, error: 0, no_response: 0 }, problems: [], problemCount: 0,
              attention: self ? [{ kind: 'data_unreadable', group: 'origin', displayName: 'Operations room',
                reasonCode: 'identity_mismatch' }] : [] } }, { self, access: 'admin', nowMs: now });
          return route.fulfill({ json: { agents: [record('browser-case', true), record('remote-case', false)],
            updated_at: new Date(now).toISOString() } });
        }
        if (url.pathname === '/api/groups/running') {
          const data = workbenchAnswer(url, now);
          data.rows[0].displayName = 'Operations room';
          data.rows[0].flags = { unreadable: { reasons: ['identity_mismatch'] } };
          return route.fulfill({ json: data });
        }
        return route.fallback();
      });
      const unavailable = locale === 'zh' ? '\u72b6\u6001\u8bfb\u4e0d\u5230' : 'Status unavailable';
      const unreadable = locale === 'zh' ? '\u6570\u636e\u8bfb\u53d6\u5931\u8d25' : 'Unable to read data';
      const check = async (selector, technical, view) => {
        const item = page.locator(selector).filter({ hasText: unavailable });
        await item.waitFor({ state: 'visible' }).catch(async error => {
          console.log('Unreadable fixture failure:', JSON.stringify({ errors,
            text: (await page.locator('body').innerText()).slice(0, 4000) }));
          if (evidence) await page.screenshot({ path: path.join(evidence, 'unreadable-fixture-failure.png'), fullPage: true });
          throw error;
        });
        const text = await item.innerText();
        assert.ok(text.includes(unreadable), text);
        assert.ok(text.includes('Operations room'), text);
        assert.equal(text.includes('identity_mismatch'), technical, text);
        const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
          overflow: [...document.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1)
            .slice(0, 6).map(node => ({ tag: node.tagName, id: node.id, class: String(node.className) })) }));
        if (evidence) await page.screenshot({ path: path.join(evidence,
          `unreadable-${view}-${width}-${locale}-${technical ? 'technical' : 'plain'}-light.png`), fullPage: true });
        assert.ok(layout.scroll <= layout.width, JSON.stringify(layout));
        const geometry = await item.evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }));
        assert.ok(geometry.scroll <= geometry.width + 1, JSON.stringify(geometry));
        await page.evaluate(() => document.fonts.ready);
        console.log('Unreadable attention visible text:', JSON.stringify({ width, locale, view, technical, text }));
      };
      await page.goto(base + '/');
      const own = page.locator('#agent-fleet-root .wb-f-card[data-self="true"]');
      await check('#agent-fleet-root [data-self="true"] .wb-f-attention-item', false, 'fleet');
      await own.locator('.agent-open').click();
      await openDashboardTab(page, 'overview');
      await check('#wb-attention .wb-attention-item', false, 'overview');
      await toggleDetails();
      await check('#wb-attention .wb-attention-item', true, 'overview');
      await openMachines();
      await check('#agent-fleet-root [data-self="true"] .wb-f-attention-item', true, 'fleet');
      await own.locator('.agent-open').click();
      await toggleDetails();
      await check('#wb-attention .wb-attention-item', false, 'overview');
      await openMachines();
      await check('#agent-fleet-root [data-self="true"] .wb-f-attention-item', false, 'fleet');
      assert.deepEqual(errors, [], `${width}px ${locale} page errors`);
    } finally { await context.close(); }
  }
  assert.deepEqual(actions, [], 'view changes never submit instance actions');
}
