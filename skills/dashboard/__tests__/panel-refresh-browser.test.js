import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { workbenchAnswer, workbenchSnapshot, workbenchSnapshotAnswer } from './fixtures/workbench-browser-api.js';
import { startPage } from './helpers/workbench-browser.js';
import { createGroupConfig } from '../src/lib/workbench/group-config.js';
import { jsonResponse } from '../src/lib/http.js';
import { createConfigHandler, parseConfigArgs } from '../../comm-bridge/scripts/c4-config-handler.js';
import { fixture as createConfigStore } from '../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';

// Boundary: actual dashboard modules/styles and DOM in Chrome, fixed local HTTP APIs only.
// Run for host/detail redraw, group configuration layout, or shell refresh/visibility changes; skip unrelated backend changes.
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
          await context.addInitScript(({ theme, width }) => {
            localStorage.setItem('zylos-dashboard-locale', width === 390 ? 'en' : 'zh');
            localStorage.setItem('zylos-dashboard-theme', theme);
            localStorage.setItem('zylos-dashboard-detail-level', 'technical');
          }, { theme, width });
          const page = await context.newPage(); page.setDefaultTimeout(10000);
          let boardReads = 0; const fixtureAt = Date.now();
          await page.route('**/api/**', route => {
            const url = new URL(route.request().url());
            if (!url.pathname.startsWith('/api/groups/') && url.pathname !== '/api/instance') return route.fallback();
            const snapshot = workbenchSnapshot(fixtureAt), row = snapshot.rows[1];
            if (url.pathname === '/api/groups/running') boardReads++;
            row.contextPct = 60 + boardReads;
            row.preview.source = 'c4'; row.preview.timestamp = fixtureAt;
            // The group is idle with queued work blocked on rate limiting; its evidence fold persists.
            row.state = { kind: 'idle' }; row.flags = { queued: { count: 1 }, blocked: { reason: 'rate_limited', runtime: 'claude' } };
            row.tools = []; row.queue.running.count = 0; row.queue.pending.oldestAt = fixtureAt - 60000;
            row.live.status = { valid: true, state: 'idle', sampledAt: fixtureAt };
            const cooldownUntil = Math.floor(fixtureAt / 1000) + 3600;
            row.wait = { kind: 'rate_wait', runtime: 'claude', cooldownUntil };
            snapshot.instance.runtimeHealth.claude = { health: 'rate_limited', updatedAt: fixtureAt, cooldownUntil };
            const value = workbenchSnapshotAnswer(url, snapshot, fixtureAt);
            if (/^\/api\/groups\/[^/]+$/.test(url.pathname) && value) {
              value.raw = 'Stored fixture message\nsecond line';
              value.config = { runtime: { ok: true, data: { resolved: { runtime: 'claude', model: 'default', effort: 'high' } } },
                model: { ok: true, data: { runtime: 'claude', desired: { runtime: 'claude', mode: 'default' } } },
                modelOverrides: [] };
            }
            return value === undefined ? route.fallback() : route.fulfill({ json: value });
          });
          await page.route('**/api/instance/runtime-options?*', route => route.fulfill({ json: { models: [{ id: 'default', display_name: 'Default' }], efforts_by_model: { '*': ['low', 'high'] }, current_model: 'default', model_thresholds: { default: 70 } } }));
          await page.route('**/api/instance/resources?*', route => route.fulfill({ json: { current: { cpu_pct: 35 }, pm2: { online: 6, total: 6 },
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
          const editor = page.locator('.wb-cfg-edit');
          await editor.locator('.wb-cfg-model select').first().locator('option[value="default"]').waitFor({ state: 'attached' });
          const { boxes, labels, dropdowns, fits, modelText, modelTextFits } = await editor.evaluate(async form => {
            await document.fonts.ready;
            const selects = [...form.querySelectorAll('select')];
            const model = selects[1];
            const style = getComputedStyle(model);
            const text = model.selectedOptions[0].label;
            const canvas = document.createElement('canvas').getContext('2d');
            canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            return {
              boxes: selects.map(node => node.getBoundingClientRect().toJSON()),
              labels: [...form.querySelectorAll('.wb-cfg-label')].map(node => {
                const { fontSize, fontWeight, lineHeight } = getComputedStyle(node);
                return { fontSize, fontWeight, lineHeight };
              }),
              dropdowns: selects.map(node => ({ fontSize: getComputedStyle(node).fontSize,
                appearance: getComputedStyle(node).appearance,
                sharedChevron: !!node.parentElement.matches('.wb-select-wrap') && !!node.nextElementSibling?.matches('.wb-ico-chev[aria-hidden="true"]'),
                fullWidth: node.getBoundingClientRect().width === node.closest('label').getBoundingClientRect().width })),
              fits: form.scrollWidth <= form.clientWidth && form.getBoundingClientRect().right <= innerWidth,
              modelText: text,
              modelTextFits: canvas.measureText(text).width <= model.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
            };
          });
          const mobile = width === 390;
          const [engine, model, effort] = boxes;
          assert.deepEqual(boxes.map(box => box.height), Array(3).fill(mobile ? 36 : 26));
          assert.deepEqual(labels, Array(3).fill({ fontSize: mobile ? '14px' : '13px', fontWeight: '550', lineHeight: '20px' }));
          assert.deepEqual(dropdowns, Array(3).fill({ fontSize: mobile ? '16px' : '12.5px', appearance: 'none', sharedChevron: true, fullWidth: true }));
          assert.ok(fits && engine.bottom < model.top, 'the engine sits above the model without overflowing the drawer');
          if (mobile) {
            assert.ok(model.bottom < effort.top && model.left === effort.left && model.width === effort.width, 'model and effort fill separate rows');
            assert.equal(modelText, 'Follow global default');
            assert.ok(modelTextFits, 'the complete English selection fits inside the model dropdown');
          } else {
            assert.ok(Math.abs(model.y - effort.y) <= 1 && model.right < effort.left, 'model and effort share the desktop row');
          }
          console.log('Config key before', await page.locator('.wb-cfg-edit').evaluate(node => { window.configEditor = node; return node.dataset.updateKey; }));
          await page.waitForTimeout(5600);
          console.log('Config key after', await page.locator('.wb-cfg-edit').evaluate(node => node.dataset.updateKey));
          assert.equal(await page.locator('.wb-cfg-edit').evaluate(node => node === window.configEditor), true, 'config editor retained across refresh');
          await editor.locator('.wb-cfg-actions button').last().click();
          await page.locator('.wb-cfg-edit').waitFor({ state: 'detached' });
          await page.locator('.wb-detail-evidence').evaluate(node => { node.open = false; });
          await page.waitForTimeout(5600);
          assert.equal(await page.locator('.wb-detail-evidence').evaluate(node => node.open), false, 'collapsed evidence stays collapsed');
          // Opening a different group gets a fresh body rather than the previous group's position.
          await page.locator('.wb-detail-body').evaluate(node => { node.scrollTop = 200; });
          await page.locator('#wb-side .wb-d-top > button').last().evaluate(node => node.click());
          await page.locator('.wb-group-sides button').nth(1).click();
          await page.locator('#wb-board .wb-row').filter({ hasText: 'Product weekly' }).click();
          assert.equal((await state()).top, 0, 'another group starts at top');
        } finally { await context.close(); }
      });
    }
  }, { timeoutMs: 170000 });
});

// Real browser, Dashboard CLI adapter and Core configuration handler with an in-memory
// store. Only process transport, running observation and supervisor submission are
// injected. Run for group save/confirmation/restart feedback; skip unrelated UI or reads.
test('confirmed configuration of single-mode Origin displays the one CLI restart result', {
  skip: !chatEnabled(), timeout: 120_000,
}, async t => {
  const sandbox = createChatSandbox(t);
  await sandbox.runCase(async () => {
    console.log('Group configuration browser isolation:', JSON.stringify(sandbox.assertIsolation()));
    const { base } = await startPage(sandbox);
    const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
    const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env,
      args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
    sandbox.addCleanup(() => browser.close());
    const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
    if (evidence) fs.mkdirSync(evidence, { recursive: true });

    for (const width of [1280, 390]) for (const locale of ['en', 'zh']) for (const theme of ['light', 'dark']) {
      await t.test(`${width} ${locale} ${theme}`, async variant => {
        const snapshot = workbenchSnapshot(Date.now());
        const origin = snapshot.rows[0];
        Object.assign(snapshot, { mode: 'single', view: 'single', rows: [origin] });
        const sameEngine = locale === 'zh';
        const refused = theme === 'dark';
        const { store } = createConfigStore(variant, { readConfig: () => ({ state: 'ok',
          config: { runtime: 'claude', session_mode: 'single' } }) });
        if (sameEngine) store.setSessionRuntimeConfig({ sessionGroup: 'origin', runtime: 'claude' });
        const runId = origin.live.runId;
        const restarts = [], writes = [], argsSent = [];
        const handler = createConfigHandler({ store, readSessionMode: () => 'single',
          observeRunning: () => ({ hasProcess: true, identityVerified: true, ready: true, runId, launchConfig: origin.launchConfig }),
          restart: target => {
            restarts.push({ ...target, config: store.resolveSessionLaunchConfig({ sessionGroup: 'origin', sessionMode: 'single' }) });
            return refused ? { status: 'not_restarted', reason: 'fence_conflict' } : { status: 'accepted' };
          },
        });
        const config = createGroupConfig({ zylosDir: sandbox.paths.zylos, execute: async (file, argv) => {
          assert.equal(file, 'zylos');
          const [, kind, ...args] = argv;
          const { request } = parseConfigArgs(kind, args);
          if (request.action !== 'get') argsSent.push(args);
          try { return { stdout: JSON.stringify(await handler(kind, request)) }; }
          catch (error) { return { stdout: JSON.stringify({ ok: false, error: { code: error.code, message: error.message } }) }; }
        } });
        const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 },
          hasTouch: width === 390, timezoneId: 'Asia/Singapore', reducedMotion: 'reduce' });
        try {
          await context.addInitScript(({ locale, theme }) => {
            localStorage.setItem('zylos-dashboard-locale', locale);
            localStorage.setItem('zylos-dashboard-theme', theme);
          }, { locale, theme });
          await context.route('**/*', async route => {
            const req = route.request(), url = new URL(req.url());
            if (url.origin !== base) return route.abort();
            if (url.pathname === '/_assets/vendor/chart.umd.js') return route.fulfill({ path: process.env.ZYLOS_CHAT_CHART_ASSET, contentType: 'text/javascript' });
            if (!url.pathname.startsWith('/api/')) return route.continue();
            if (req.method() !== 'GET') {
              const body = req.postDataJSON();
              writes.push({ method: req.method(), path: url.pathname, body });
              if (req.method() !== 'PUT' || url.pathname !== '/api/groups/origin/config') return route.fulfill({ status: 404, json: {} });
              const { status, body: result } = jsonResponse(200, await config.submit('origin', body), { command: true, write: true });
              return route.fulfill({ status, json: result });
            }
            const value = workbenchSnapshotAnswer(url, snapshot, snapshot.readAt);
            if (url.pathname === '/api/groups/origin') value.config = { ...await config.get('origin'), modelOverrides: [] };
            if (url.pathname === '/api/instance/runtime-options' && url.searchParams.get('runtime') === 'codex') {
              return route.fulfill({ json: { models: [{ id: 'gpt', display_name: 'GPT' }], efforts_by_model: { '*': ['high'] } } });
            }
            return value === undefined ? route.continue() : route.fulfill({ json: value });
          });
          const page = await context.newPage();
          page.setDefaultTimeout(6000);
          await page.goto(base + '/');
          await page.locator('#wb-board .wb-row').first().click();
          await page.locator('.wb-detail-config .wb-cfg-line button').click();
          const editor = page.locator('.wb-cfg-edit');
          await editor.locator('.wb-cfg-engine select').selectOption(sameEngine ? 'inherit' : 'codex');
          const model = editor.locator('.wb-cfg-model select').nth(0);
          const effort = editor.locator('.wb-cfg-model select').nth(1);
          const modelId = sameEngine ? 'sonnet' : 'gpt';
          const runtime = sameEngine ? 'claude' : 'codex';
          await model.selectOption(modelId);
          await effort.selectOption('high');
          const save = editor.getByRole('button', { name: locale === 'zh' ? '保存' : 'Save', exact: true });
          const dialog = page.getByRole('alertdialog');
          await save.click();
          await dialog.getByRole('button', { name: locale === 'zh' ? '取消' : 'Cancel' }).click();
          assert.deepEqual(writes, []);
          assert.deepEqual(restarts, []);
          await save.click();
          await dialog.waitFor();
          const shot = async stage => {
            if (evidence) await page.screenshot({ path: path.join(evidence, `origin-config-${width}-${locale}-${theme}-${stage}.png`) });
          };
          assert.match(await dialog.textContent(), locale === 'zh' ? /会打断这个组正在做的事/ : /interrupts this group’s current work/);
          await shot('confirm');
          await dialog.getByRole('button', { name: locale === 'zh' ? '保存并重启' : 'Save and restart' }).click();
          const feedback = page.locator('.wb-config-result').last();
          await page.getByText(refused ? /fence_conflict/ : locale === 'zh' ? '重启请求已接受' : 'Restart request accepted', { exact: !refused }).waitFor();
          await feedback.scrollIntoViewIfNeeded();
          await shot('result');
          const modelEdit = { kind: 'model', runtime, model: modelId, effort: 'high', confirmed: true };
          const runtimeEdit = { kind: 'runtime', value: sameEngine ? 'inherit' : 'codex', confirmed: true };
          assert.deepEqual(writes, (sameEngine ? [runtimeEdit, modelEdit] : [modelEdit, runtimeEdit])
            .map(body => ({ method: 'PUT', path: '/api/groups/origin/config', body })));
          assert.equal(argsSent.length, 2);
          assert.ok(argsSent.every(args => args.filter(arg => arg === '--yes').length === 1));
          assert.deepEqual(restarts, [{ sessionGroup: 'origin', runId, config: { runtime, mode: 'override', model: modelId, effort: 'high' } }]);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          assert.equal(await editor.evaluate(form => form.scrollWidth <= form.clientWidth + 1), true);
        } finally { await context.close(); }
      });
    }
  }, { timeoutMs: 110_000 });
});
