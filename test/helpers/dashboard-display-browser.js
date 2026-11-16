import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startPage } from '../../skills/dashboard/__tests__/helpers/workbench-browser.js';
import { workbenchAnswer } from '../../skills/dashboard/__tests__/fixtures/workbench-browser-api.js';
import { openDashboardTab } from '../../skills/dashboard/__tests__/helpers/browser-navigation.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const now = Date.parse('2026-11-16T13:00:00Z');
const until = '2026-11-16T14:54:23Z';
const recorded = '2026-11-16T11:56:57.612Z';
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

export async function runDashboardDisplayBrowser(t, sandbox) {
  // No dependencies are installed by the test. Callers explicitly provision browser and Chart artifacts.
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE;
  const executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  const chartPath = process.env.ZYLOS_CHAT_CHART_MODULE || path.join(repo, 'node_modules/chart.js/dist/chart.umd.js');
  for (const [name, value] of Object.entries({ ZYLOS_CHAT_BROWSER_MODULE: modulePath, ZYLOS_CHAT_BROWSER_BIN: executablePath, ZYLOS_CHAT_CHART_MODULE: chartPath })) {
    assert.ok(value && fs.existsSync(value), `${name} must name a provisioned artifact`);
  }
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) {
    const destination = path.resolve(evidence);
    assert.ok(destination !== repo && !destination.startsWith(repo + path.sep), 'screenshots must remain outside the repository');
    fs.mkdirSync(destination, { recursive: true });
    assert.ok(!fs.realpathSync(destination).startsWith(fs.realpathSync(repo) + path.sep), 'artifact directory may not link into the repository');
  }
  console.log('Dashboard display isolation:', JSON.stringify(sandbox.assertIsolation()));
  const { base } = await startPage(sandbox);
  const { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());

  for (const width of [1280, 390]) for (const language of ['zh', 'en']) for (const theme of ['light', 'dark']) {
    let failure;
    await t.test(`${width}px ${language} ${theme}: Fleet, settings, history, memory and usage`, async () => {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 },
        locale: language === 'zh' ? 'zh-CN' : 'en-GB', timezoneId: 'America/Los_Angeles',
        reducedMotion: 'reduce' });
      sandbox.addCleanup(() => context.close());
      let hold = deferred(), instanceRequests = 0, fleetRequests = 0;
      const blocked = [], errors = [], writes = [];
      try {
        await context.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== base) { if (blocked.length < 10) blocked.push(url.origin); return route.abort(); }
          if (url.pathname === '/_assets/vendor/chart.umd.js') return route.fulfill({ path: chartPath, contentType: 'text/javascript' });
          if (!url.pathname.startsWith('/api/')) return route.continue();
          if (request.method() !== 'GET') { if (writes.length < 10) writes.push(`${request.method()} ${url.pathname}`); return route.fulfill({ status: 405, json: { error: 'read_only_fixture' } }); }
          let value = workbenchAnswer(url, now);
          if (url.pathname === '/api/instance') {
            instanceRequests++;
            const waiting = hold; if (waiting) await waiting.promise;
            value = { ...value, tz: 'Asia/Singapore', runtimeHealth: { claude: { health: 'ok' }, codex: { health: 'rate_limited', cooldownUntil: until } } };
          } else if (url.pathname === '/api/fleet') {
            fleetRequests++;
            const group_summary = { running: 2, listKnown: true, counts: { busy: 1, idle: 1, unknown: 0 }, problems: [], problemCount: 0,
              attention: [{ kind: 'rate_limited', runtime: 'codex', until }] };
            value = { agents: [{ name: 'primary', self: true, state: 'IDLE', session_mode: 'multi', access: 'admin', group_summary },
              { name: 'peer', self: false, state: 'IDLE', session_mode: 'multi', access: 'read', group_summary }], updated_at: new Date(now).toISOString() };
          } else if (url.pathname === '/api/settings/timezone') value = { tz: 'Asia/Singapore' };
          else if (url.pathname === '/api/instance/runtime-options') {
            value = structuredClone(value); value.runtime = url.searchParams.get('runtime') || 'claude';
            if (value.runtime === 'claude') Object.assign(value, { current_model: 'haiku', models: [{ id: 'haiku', display_name: 'Haiku' }, { id: 'opus', display_name: 'Opus' }], efforts_by_model: { haiku: [], opus: ['low', 'medium', 'high'] } });
          } else if (url.pathname === '/api/observer/status') value = { state: 'installed', desired: { enabled: true }, agentSize: { cols: 100, rows: 30 } };
          else if (url.pathname === '/api/observer/history/sessions') value = { current: 'sample', sessions: [{ id: 'sample', kind: 'main', title: 'History sample', startedAt: recorded }] };
          else if (url.pathname === '/api/observer/history/entries') value = { entries: [{ id: 'entry', kind: 'inbound', ts: recorded, fields: { body: { text: 'Example', total: 7 } } }], updates: [], hasOlder: false };
          else if (url.pathname === '/api/memory/tree') {
            value = structuredClone(value);
            for (const node of value.root.children) if (node.type === 'file') node.size_bytes = ({ 'identity.md': 512, 'references.md': 2048, 'state.md': 2097152 })[node.path] ?? node.size_bytes;
          } else if (url.pathname === '/api/memory/backlog') value = { ...value, budgets: { limits: { 'identity.md': 2048, 'references.md': 2097152 }, warnings: {} } };
          if (value !== undefined) return route.fulfill({ json: value });
          return route.continue();
        });
        await context.addInitScript(({ language, theme }) => {
          if (window !== window.top) return;
          localStorage.setItem('zylos-dashboard-locale', language);
          localStorage.setItem('zylos-dashboard-theme', theme);
          localStorage.setItem('zylos-dashboard-detail-level', 'technical');
          window.__displayClocks = [];
          const observer = new MutationObserver(() => {
            const text = document.querySelector('.wb-f-card.self .wb-f-attention-item')?.textContent;
            if (text && window.__displayClocks.at(-1) !== text && window.__displayClocks.length < 10) window.__displayClocks.push(text);
          });
          observer.observe(document, { subtree: true, childList: true, characterData: true });
          window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
        }, { language, theme });
        const page = await context.newPage(); page.setDefaultTimeout(10_000);
        page.on('pageerror', error => { if (errors.length < 10) errors.push(error.message); });
        await page.clock.setFixedTime(now);
        const shot = async name => {
          await page.mouse.move(0, 0);
          await page.evaluate(() => document.activeElement?.blur());
          if (evidence) await page.screenshot({ path: path.join(evidence, `display-${width}-${language}-${theme}-${name}.png`), animations: 'disabled', fullPage: name.startsWith('settings') });
        };
        await page.goto(base + '/', { waitUntil: 'commit' });
        // The product must not invent a UTC clock while metadata is outstanding.
        for (let i = 0; fleetRequests === 0 && i < 100; i++) await page.waitForTimeout(25);
        assert.ok(fleetRequests > 0, 'cold entry requested Fleet data');
        await page.locator('.wb-f-card.self .wb-f-attention-item').waitFor({ state: 'visible' });
        const initial = await page.locator('.wb-f-card.self .wb-f-attention-item').innerText();
        assert.doesNotMatch(initial, /14:54|22:54/);
        assert.match(initial, language === 'zh' ? /恢复时间未知/ : /recovery time unknown/);
        await shot('fleet-loading');
        await page.locator('#agent-fleet-root').hover();
        hold.resolve(); hold = null;
        await page.waitForFunction(() => document.querySelector('.wb-f-card.self .wb-f-attention-item')?.textContent.includes('22:54'), null, { timeout: 2000 });
        assert.ok(instanceRequests > 0);
        assert.ok((await page.evaluate(() => window.__displayClocks)).every(text => !text.includes('14:54')), 'no transient UTC fallback was rendered');
        await shot('fleet');
        const beforeRefresh = fleetRequests;
        await page.reload();
        await page.waitForFunction(() => document.querySelector('.wb-f-card.self .wb-f-attention-item')?.textContent.includes('22:54'));
        for (let i = 0; fleetRequests === beforeRefresh && i < 20; i++) await page.waitForTimeout(25);
        assert.ok(fleetRequests > beforeRefresh, 'Fleet refresh actually requested data');
        assert.match(await page.locator('.wb-f-card.self .wb-f-attention-item').innerText(), /22:54/);
        await page.goto(base + '/');
        await page.waitForFunction(() => document.querySelector('.wb-f-card.self .wb-f-attention-item')?.textContent.includes('22:54'));
        assert.ok((await page.evaluate(() => window.__displayClocks)).every(text => !text.includes('14:54')), 'direct entry never renders UTC fallback');
        await page.locator('.agent-open[data-self="true"]').click();
        await page.locator('#wb-attention .wb-attention-text').filter({ hasText: 'Codex' }).waitFor();
        assert.match(await page.locator('#wb-attention').innerText(), /22:54/);

        await openDashboardTab(page, 'settings');
        const model = page.locator('#settings-model-claude');
        await model.waitFor({ state: 'attached' });
        // Navigate to Defaults through the actual mobile drawer when necessary.
        if (width === 390) await page.locator('.wb-set-drawer-btn').click();
        await page.locator('[data-settings-section="defaults"]').click();
        await model.scrollIntoViewIfNeeded();
        await model.selectOption('haiku');
        const fieldState = () => page.locator('#settings-effort-claude').evaluate(node => {
          const label = node.closest('label'), rect = label.getBoundingClientRect();
          return { hidden: label.hidden, width: rect.width, height: rect.height, text: label.textContent };
        });
        assert.deepEqual({ ...(await fieldState()), text: undefined }, { hidden: true, width: 0, height: 0, text: undefined }, 'the entire effort field and its label leave layout');
        const alignment = async kind => {
          const positions = await page.evaluate(kind => ['claude', 'codex'].map(runtime => {
            const node = document.querySelector(`#settings-${kind}-${runtime}`).closest('label');
            const rect = node.getBoundingClientRect();
            return { x: rect.x, width: rect.width };
          }), kind);
          assert.ok(Math.abs(positions[0].x - positions[1].x) <= 1, `${kind} columns align: ${JSON.stringify(positions)}`);
        };
        await alignment('threshold');
        await shot('settings-haiku');
        await model.selectOption('opus');
        assert.equal((await fieldState()).hidden, false, 'supported model restores effort label and wrapper');
        assert.ok(await page.locator('#settings-effort-claude').isVisible());
        await alignment('effort');
        await shot('settings-supported');

        await openDashboardTab(page, 'observer');
        await page.locator('[data-observer-view="history"]').click();
        await page.locator('.history-entry header').waitFor();
        const session = await page.locator('[data-history="sessions"]').innerText();
        const header = await page.locator('.history-entry header').innerText();
        assert.match(session, /11-16 19:56/);
        assert.match(header, /19:56/);
        assert.doesNotMatch(header, /2026-11-16T11:56|\.612Z|11:56:57/);
        await shot('history');

        await openDashboardTab(page, 'memory');
        await page.locator('.memory-file-meta').first().waitFor();
        await page.locator('.wb-memory-budgets .wb-memory-chart-value').first().waitFor();
        const files = (await page.locator('.memory-file-meta').allTextContents()).join(' ');
        const budgets = (await page.locator('.wb-memory-budgets .wb-memory-chart-value').allTextContents()).join(' ');
        for (const text of [files, budgets]) {
          assert.match(text, /512\s*B/); assert.match(text, /2(?:\.0)?\s*KB/); assert.match(text, /2(?:\.0)?\s*MB/);
          assert.doesNotMatch(text, /[KMGT]iB/);
        }
        await shot('memory');
        await page.locator('.wb-memory-budgets').scrollIntoViewIfNeeded();
        await shot('memory-budgets');

        await openDashboardTab(page, 'trends');
        await page.waitForFunction(() => [...document.querySelectorAll('#wb-usage canvas')].some(canvas => {
          const chart = window.Chart?.getChart(canvas);
          return chart?.config.type === 'line' && chart.data.datasets.some(dataset => dataset.data.filter(value => value != null).length === 1);
        }));
        // The fixture's fixed Date keeps Chart's wall-clock animator at its first frame.
        // Settle through Chart's public API; retain the product dataset and point options.
        await page.evaluate(() => {
          const canvas = [...document.querySelectorAll('#wb-usage canvas')].find(canvas => window.Chart.getChart(canvas)?.config.type === 'line');
          const chart = window.Chart.getChart(canvas);
          chart.stop(); chart.update('none');
        });
        const marker = await page.evaluate(() => {
          const canvas = [...document.querySelectorAll('#wb-usage canvas')].find(canvas => window.Chart.getChart(canvas)?.config.type === 'line');
          const chart = window.Chart.getChart(canvas), dataset = chart.data.datasets[0], index = dataset.data.findIndex(value => value != null);
          const point = chart.getDatasetMeta(0).data[index];
          return { label: dataset.label, data: dataset.data, radius: point.options.radius, skip: point.skip,
            x: point.x, y: point.y, expectedY: chart.scales.y.getPixelForValue(dataset.data[index]), width: chart.width, height: chart.height, color: point.options.backgroundColor };
        });
        assert.deepEqual(marker.data.filter(value => value != null), [65]);
        assert.ok(marker.radius >= 2, `the lone cache-hit value has a visible marker: ${JSON.stringify(marker)}`);
        assert.equal(marker.skip, false);
        assert.ok(Math.abs(marker.y - marker.expectedY) < 0.5, 'the marker is drawn at the recorded cache-hit percentage');
        assert.ok(marker.x >= 0 && marker.x <= marker.width && marker.y >= 0 && marker.y <= marker.height);
        // Locate by the actual Chart instance's canvas label, in the current language.
        await page.locator(`#wb-usage canvas[aria-label=${JSON.stringify(marker.label)}]`).scrollIntoViewIfNeeded();
        await shot('usage-cache');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal page overflow');
        assert.ok(blocked.every(origin => origin === 'https://fonts.googleapis.com'), `only optional webfonts were requested outside the fixture and all were blocked: ${JSON.stringify(blocked)}`);
        assert.ok(writes.every(request => request === 'POST /api/observer/leases'), `only automatic Observer lease attempts were blocked by the read-only fixture: ${JSON.stringify(writes)}`);
        assert.deepEqual(errors, [], 'no product page errors');
        console.log('Dashboard display checked:', JSON.stringify({ width, language, theme, session, header, files, budgets, marker }));
      } catch (error) {
        failure = error;
        console.error('Dashboard display browser failure:', width, language, theme, error.stack);
        throw error;
      } finally { hold?.resolve(); await context.close(); }
    });
    if (failure) throw failure;
  }
}
