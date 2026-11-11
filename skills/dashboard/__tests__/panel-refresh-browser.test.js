import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { workbenchAnswer } from './fixtures/workbench-browser-api.js';
import { startPage } from './helpers/workbench-browser.js';

// Boundary: actual dashboard modules/styles and DOM in Chrome, fixed local HTTP APIs only.
// Run for host/detail redraw state or shell refresh/visibility changes; skip unrelated backend changes.
// Opt-in before allocation; sandbox proves private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket/DB paths,
// closes browser/server on pass/failure/timeout. No live Core, PM2, tmux, model or database starts.
test('background panel refresh preserves reading position and folds', { skip: !chatEnabled(), timeout: 180000 }, async t => {
  const sandbox = createChatSandbox(t);
  await sandbox.runCase(async () => {
    console.log('Panel browser isolation:', JSON.stringify(sandbox.assertIsolation()));
    const { base } = await startPage(sandbox);
    const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
    const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env,
      args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
    sandbox.addCleanup(() => browser.close());
    for (const width of [1280, 390]) for (const theme of ['light', 'dark']) await t.test(`${width} ${theme}: host request updates existing charts and clamps shorter content`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 700 } }); sandbox.addCleanup(() => context.close());
      try {
        await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
        await context.addInitScript(theme => { localStorage.setItem('zylos-dashboard-theme', theme); }, theme);
        const page = await context.newPage(); await page.goto(base + '/');
        await page.exposeFunction('captureHost', async name => {
          if (process.env.ZYLOS_CHAT_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.ZYLOS_CHAT_EVIDENCE_DIR, `${width}-${theme}-dynamic-host-${name}.png`) });
        });
        const result = await page.evaluate(async () => {
          const { createHostPanel } = await import('/_assets/js/wb/host-panel.js');
          const root = document.createElement('aside');
          root.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;height:350px;width:min(420px,100vw)';
          document.body.append(root);
          let release, pending = false, size = 60, cpu = 35, level = 'technical';
          const fixtureAt = Date.now();
          const value = () => ({ current: { cpu_pct: cpu }, series: Array.from({ length: size }, (_, i) => ({ at: fixtureAt - i * 60000, cpu: { avg: cpu, max: cpu + 5 } })) });
          const panel = createHostPanel({ root, detail: () => level, read: () => pending ? new Promise(resolve => { release = resolve; }) : Promise.resolve(value()) });
          try {
            await panel.open();
            root.querySelector('details').open = true;
            root.querySelector('.wb-detail-body').scrollTop = 300;
            const original = root.querySelector('.wb-detail-body');
            const header = root.querySelector('header'), fold = root.querySelector('details'), canvas = root.querySelector('canvas');
            const chart = Chart.getChart(canvas), tableRow = root.querySelector('tbody tr');
            const oldText = original.textContent;
            await window.captureHost('before');
            pending = true; const flight = panel.refresh();
            const retained = original === root.querySelector('.wb-detail-body') && original.scrollTop === 300;
            // Scrolling while the request is pending must not be undone by the response.
            original.scrollTop = 400;
            const latest = original.scrollTop;
            cpu = 72; release(value()); await flight;
            const preserved = root.querySelector('.wb-detail-body').scrollTop === latest && root.querySelector('details').open;
            const sameNodes = original === root.querySelector('.wb-detail-body') && header === root.querySelector('header') && fold === root.querySelector('details') && canvas === root.querySelector('canvas') && tableRow === root.querySelector('tbody tr');
            const chartUpdated = chart === Chart.getChart(canvas) && chart.data.datasets[0].data[0] === 72;
            const textUpdated = original.textContent !== oldText && original.textContent.includes('72.0%');
            await window.captureHost('after');
            const shortFlight = panel.refresh(); size = 0; release(value()); await shortFlight;
            const body = root.querySelector('.wb-detail-body');
            const top = body.scrollTop, max = body.scrollHeight - body.clientHeight;
            pending = false;
            root.querySelector('[data-range="24h"]').click(); await new Promise(resolve => setTimeout(resolve, 0));
            const rangeReset = body !== root.querySelector('.wb-detail-body') && root.querySelector('.wb-detail-body').scrollTop === 0;
            const rangedBody = root.querySelector('.wb-detail-body'); level = 'plain'; panel.setViewDetail();
            const levelReset = rangedBody !== root.querySelector('.wb-detail-body') && root.querySelector('.wb-detail-body').scrollTop === 0;
            const plainBody = root.querySelector('.wb-detail-body'); panel.close(); await panel.open();
            const openReset = plainBody !== root.querySelector('.wb-detail-body') && root.querySelector('.wb-detail-body').scrollTop === 0;
            return { retained, preserved, sameNodes, chartUpdated, textUpdated, rangeReset, levelReset, openReset, top, max, latest };
          } finally { panel.destroy(); root.remove(); }
        });
        console.log('Host pending/clamp', JSON.stringify(result));
        assert.equal(result.retained, true, 'pending request keeps the actual previous body');
        for (const key of ['sameNodes', 'chartUpdated', 'textUpdated', 'rangeReset', 'levelReset', 'openReset']) assert.equal(result[key], true, key);
        assert.equal(result.preserved, true, 'response retains the latest user scroll and fold');
        assert.ok(result.max < result.latest, 'short response actually shrinks scroll range');
        assert.equal(result.top, result.max, 'browser clamps to the new bottom');
      } finally { await context.close(); }
    });
    for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
      await t.test(`${width} ${theme}: host and overview retain user state`, async () => {
        const context = await browser.newContext({ viewport: { width, height: 700 } });
        sandbox.addCleanup(() => context.close());
        try {
          await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
          await context.addInitScript(theme => {
            localStorage.setItem('zylos-dashboard-locale', 'zh');
            localStorage.setItem('zylos-dashboard-theme', theme);
            localStorage.setItem('zylos-dashboard-detail-level', 'technical');
          }, theme);
          const page = await context.newPage(); page.setDefaultTimeout(10000);
          let boardReads = 0; const fixtureAt = Date.now();
          await page.route('**/api/workbench/groups', route => {
            const value = workbenchAnswer(new URL(route.request().url()), fixtureAt);
            value.rows[1].contextPct = 60 + ++boardReads;
            value.rows[1].preview.source = 'c4'; value.rows[1].preview.timestamp = fixtureAt;
            // Evidence is diagnostic-only; keep this group waiting across refreshes to exercise its fold.
            value.rows[1].state = { kind: 'waiting' };
            value.rows[1].tools = [];
            value.rows[1].queue.running.count = 0;
            value.rows[1].queue.pending.oldestAt = fixtureAt - 60000;
            value.rows[1].live.status = { valid: true, state: 'idle', sampledAt: fixtureAt };
            const cooldownUntil = Math.floor(fixtureAt / 1000) + 3600;
            value.rows[1].wait = { kind: 'rate_wait', runtime: 'claude', cooldownUntil };
            value.instance.runtimeHealth.claude = { health: 'rate_limited', updatedAt: fixtureAt, cooldownUntil };
            value.counts.busy--; value.counts.waiting++;
            return route.fulfill({ json: value });
          });
          await page.route('**/api/workbench/groups/*/config', route => route.fulfill({ json: { runtime: { ok: true, data: { resolved: { runtime: 'claude', model: 'default', effort: 'high' } } }, model: { ok: true, data: { resolved: { runtime: 'claude', model: 'default', effort: 'high' } } } } }));
          await page.route('**/api/actions/meta?*', route => route.fulfill({ json: { models: [{ id: 'default', display_name: 'Default' }], efforts_by_model: { '*': ['low', 'high'] }, current_model: 'default', model_thresholds: { default: 70 } } }));
          await page.route('**/api/workbench/groups/*/raw', route => route.fulfill({ json: { raw: 'Stored fixture message\nsecond line' } }));
          await page.route('**/api/workbench/host?*', route => route.fulfill({ json: { current: { cpu_pct: 35 }, pm2: { online: 6, total: 6 },
            series: Array.from({ length: 60 }, (_, i) => ({ at: Date.now() - i * 60000, cpu: { avg: 35, max: 42 } })) } }));
          await page.goto(base + '/');
          await page.locator('#wb-host-open').click();
          await page.locator('.wb-host-table').waitFor();
          const shot = async name => { if (process.env.ZYLOS_CHAT_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.ZYLOS_CHAT_EVIDENCE_DIR, `${width}-${theme}-${name}.png`) }); };
          const state = () => page.locator('#wb-side').evaluate(root => ({ top: root.querySelector('.wb-detail-body')?.scrollTop, open: root.querySelector('details')?.open }));
          await page.locator('.wb-host-table').evaluate(node => { node.open = true; node.closest('.wb-detail-body').scrollTop = 450; });
          await page.waitForTimeout(150);
          await page.locator('.wb-detail-body').evaluate(node => { node.scrollTop = 450; });
          await page.locator('#wb-side').evaluate(root => { window.hostNodes = [root.querySelector('.wb-detail-body'), root.querySelector('header'), root.querySelector('details'), root.querySelector('canvas')]; });
          const before = await state(); assert.ok(before.top > 0);
          await shot('host-before');
          // A genuine timer-driven board refresh updates the host through shell.setViewDetail.
          await page.waitForTimeout(5600);
          const after = await state(); await shot('host-after');
          console.log('Host refresh', JSON.stringify({ width, theme, before, after }));
          const hostNodesSame = await page.locator('#wb-side').evaluate(root => ['.wb-detail-body', 'header', 'details', 'canvas'].every((selector, i) => root.querySelector(selector) === window.hostNodes[i]));
          const hostGood = after.top === before.top && after.open === true && hostNodesSame;
          await page.locator('#wb-host-close').click();
          await page.locator('#wb-board .wb-row', { hasText: 'Telegram direct chat' }).click();
          await page.locator('.wb-detail-evidence').waitFor();
          await page.locator('.wb-now-raw > summary').click();
          await page.locator('.wb-now-raw pre').waitFor();
          await page.locator('.wb-detail-evidence').evaluate(node => { node.open = true; node.closest('.wb-detail-body').scrollTop = 250; });
          await page.locator('#wb-side').evaluate(root => { window.detailNodes = [root.querySelector('.wb-detail-body'), root.querySelector('header'), root.querySelector('details')]; });
          const detailTextBefore = await page.locator('#wb-side').textContent();
          const detailBefore = await state(); assert.ok(detailBefore.top > 0);
          await shot('detail-before'); await page.waitForTimeout(5600);
          const detailAfter = await state(); await shot('detail-after');
          console.log('Detail refresh', JSON.stringify({ width, theme, detailBefore, detailAfter }));
          assert.equal(await page.locator('#wb-side').evaluate(root => ['.wb-detail-body', 'header', 'details'].every((selector, i) => root.querySelector(selector) === window.detailNodes[i])), true, 'detail containers retain identity');
          assert.notEqual(await page.locator('#wb-side').textContent(), detailTextBefore, 'detail shows changed snapshot numbers');
          assert.ok((await page.locator('#wb-side').textContent()).includes(`${60 + boardReads}%`), 'context percentage reflects latest snapshot');
          assert.equal(detailAfter.top, detailBefore.top, 'overview scroll survives background refresh');
          assert.ok(hostGood, 'host scroll and table remain unchanged');
          assert.equal(await page.locator('.wb-detail-evidence').evaluate(node => node.open), true);
          assert.equal(await page.locator('.wb-now-raw').evaluate(node => node.open), true, 'raw remains open');
          // These handlers run after a background reconciliation, so they must reference retained live nodes.
          await page.locator('.wb-now-raw > summary').click();
          assert.equal(await page.locator('.wb-now-raw').evaluate(node => node.open), false);
          await page.locator('.wb-now-raw > summary').click();
          await page.locator('.wb-now-raw pre').waitFor();
          await page.locator('#wb-side [role="tab"]').nth(1).click();
          assert.equal(await page.locator('.wb-detail-body').evaluate(node => node === window.detailNodes[0]), false, 'tab switch rebuilds body');
          assert.equal((await state()).top, 0, 'explicit tab change starts at top');
          const runToggle = page.locator('.wb-timeline-run [aria-expanded]').first();
          await runToggle.waitFor();
          await page.waitForTimeout(5600);
          await runToggle.click();
          assert.equal(await runToggle.getAttribute('aria-expanded'), 'false', 'retained timeline toggle collapses after refresh');
          await runToggle.click();
          assert.equal(await runToggle.getAttribute('aria-expanded'), 'true', 'timeline toggle expands after refresh');
          await page.locator('#wb-side [role="tab"]').nth(0).click();
          assert.equal((await state()).top, 0, 'returning to overview starts at top');
          await page.locator('.wb-detail-config .wb-cfg-line button').click();
          await page.locator('.wb-cfg-edit').waitFor();
          // The metadata-backed model select proves the initial asynchronous editor reads have rendered.
          await page.waitForFunction(() => document.querySelectorAll('.wb-cfg-controls > select').length === 3);
          console.log('Config key before', await page.locator('.wb-cfg-edit').evaluate(node => { window.configEditor = node; return node.dataset.updateKey; }));
          await page.waitForTimeout(5600);
          console.log('Config key after', await page.locator('.wb-cfg-edit').evaluate(node => node.dataset.updateKey));
          assert.equal(await page.locator('.wb-cfg-edit').evaluate(node => node === window.configEditor), true, 'config editor retained across refresh');
          await page.locator('.wb-cfg-controls > button').last().click();
          await page.locator('.wb-cfg-edit').waitFor({ state: 'detached' });
          await page.locator('.wb-detail-evidence').evaluate(node => { node.open = false; });
          await page.waitForTimeout(5600);
          assert.equal(await page.locator('.wb-detail-evidence').evaluate(node => node.open), false, 'collapsed evidence stays collapsed');
          // Opening a different group gets a fresh body rather than the previous group's position.
          await page.locator('.wb-detail-body').evaluate(node => { node.scrollTop = 200; });
          await page.locator('#wb-side .wb-d-top > button').last().evaluate(node => node.click());
          await page.locator('#wb-board .wb-row').filter({ hasText: 'Product weekly' }).click();
          assert.equal((await state()).top, 0, 'another group starts at top');
        } finally { await context.close(); }
      });
    }
  }, { timeoutMs: 170000 });
});
