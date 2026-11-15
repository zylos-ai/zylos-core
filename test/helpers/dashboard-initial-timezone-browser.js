import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { workbenchAnswer } from '../../skills/dashboard/__tests__/fixtures/workbench-browser-api.js';

export async function runInitialTimezoneBrowser(sandbox, scenario) {
  for (const file of [process.env.ZYLOS_CHAT_BROWSER_MODULE, process.env.ZYLOS_CHAT_BROWSER_BIN, process.env.ZYLOS_CHAT_CHART_ASSET]) {
    assert.ok(file && fs.existsSync(file), 'explicit local browser, Playwright and Chart.js assets required');
  }
  const proof = sandbox.assertIsolation();
  console.info('Initial timezone isolation:', JSON.stringify(proof));
  const args = ['--experimental-test-module-mocks', fileURLToPath(new URL('./dashboard-initial-timezone-server.js', import.meta.url))];
  // No live commands on PATH: index probes version CLIs at import, but collectors
  // are never started. Private socket and DB paths were verified before spawn.
  console.info('Initial timezone child:', JSON.stringify({ executable: process.execPath, args, cwd: sandbox.paths.zylos, PATH: '/usr/bin:/bin' }));
  const child = sandbox.startChild(process.execPath, args, { env: { PATH: '/usr/bin:/bin' }, timeoutMs: 35000 });
  const listener = path.join(sandbox.paths.zylos, 'listener.json');
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(listener)) {
    if (child.exitCode !== null) { const result = await child.completion; assert.fail(JSON.stringify(result)); }
    assert.ok(Date.now() < deadline, 'isolated Dashboard starts promptly');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const { origin } = JSON.parse(fs.readFileSync(listener, 'utf8'));
  const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
  const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const started = performance.now();
  for (let load = 0; load < scenario.loads; load++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'zh-CN', timezoneId: 'America/Los_Angeles' });
    sandbox.addCleanup(() => context.close());
    const releases = [];
    let firstState;
    const stateStarted = new Promise(resolve => { firstState = resolve; });
    const release = () => { firstState(); for (const done of releases) done(); };
    sandbox.addCleanup(release);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/_assets/vendor/chart.umd.js') return route.fulfill({ path: process.env.ZYLOS_CHAT_CHART_ASSET, contentType: 'text/javascript' });
      // In reload cases A starts from refreshAll before SSE opens request B.
      if (url.pathname === '/api/stream' && scenario.kind === 'reload') await stateStarted;
      if (url.pathname === '/api/instance' && releases.length < 2) {
        firstState();
        await new Promise(resolve => releases.push(resolve));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          ...workbenchAnswer(url, Date.now()), updated_at: '2026-11-15T01:00:00Z', tz: 'Asia/Singapore',
          accounts: { claude: { used_percentage: 42, live: false, recordedAt: Date.parse('2026-11-14T15:59:00Z') } },
        }) });
      }
      return route.continue();
    });
    await context.addInitScript(() => {
      if (window !== window.top) return;
      localStorage.clear(); localStorage.setItem('zylos-dashboard-locale', 'zh');
      const observations = window.__zoneObservations = { values: [], requests: [], sse: null };
      const fetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        if (new URL(String(args[0]), location.href).pathname !== '/api/instance' || !new Error().stack.includes('refreshDashboardState')) return fetch(...args);
        const item = { start: performance.now(), end: null, source: new Error().stack.includes('refreshAll') ? 'startup' : 'sse-open' }; observations.requests.push(item);
        const result = await fetch(...args); item.end = performance.now(); return result;
      };
      const Source = window.EventSource;
      window.EventSource = class extends Source {
        constructor(...args) { super(...args); this.addEventListener('instance', () => { observations.sse ??= performance.now(); }); }
      };
      const observer = new MutationObserver(() => {
        const text = document.querySelector('.wb-quota-recorded')?.textContent;
        if (text && observations.values.at(-1)?.text !== text && observations.values.length < 10) observations.values.push({ text, at: performance.now() });
      });
      observer.observe(document, { subtree: true, childList: true, characterData: true });
      window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => { if (errors.length < 3) errors.push(error.message); });
    await page.goto(origin, { waitUntil: 'commit' });
    try { await page.waitForFunction(() => window.__zoneObservations.requests.length >= 2 && window.__zoneObservations.sse !== null); }
    catch (error) { console.info('Timezone pending observation:', JSON.stringify({ held: releases.length, observed: await page.evaluate(() => window.__zoneObservations), errors })); throw error; }
    const before = await page.evaluate(() => window.__zoneObservations);
    try {
      assert.equal(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), 'America/Los_Angeles');
      assert.ok(before.requests.every(item => item.end === null), 'both initial state requests are pending');
      if (scenario.kind === 'slow') {
        // Delay every initial state response, so no fast retry can mask startup.
        await page.locator('.tab[data-tab="overview"]').click();
        await page.waitForTimeout(1500);
        assert.ok((await page.evaluate(() => window.__zoneObservations.requests)).every(item => item.end === null));
      }
      if (scenario.kind === 'reload') releases[0](); else release();
      await page.waitForFunction(() => window.__zoneObservations.values.length);
      if (scenario.kind === 'reload') {
        const first = await page.evaluate(() => window.__zoneObservations);
        assert.equal(first.requests[0].source, 'startup');
        assert.equal(first.requests[1].end, null, 'older startup reply renders while SSE-open reply remains pending');
        assert.ok(first.values[0].text.includes('11/14 23:59'), first.values[0].text);
        release();
      }
      await page.waitForFunction(() => window.__zoneObservations.requests.filter(item => item.end !== null).length === 2);
      const after = await page.evaluate(() => window.__zoneObservations);
      assert.ok(after.sse < Math.min(...after.requests.map(item => item.end)), 'SSE state arrives before both HTTP replies');
      assert.equal(after.requests.length, 2, 'only the existing startup and SSE-open state requests run');
      assert.ok(after.values[0].text.includes('11/14 23:59'), `first timestamp must use Singapore: ${after.values[0].text}`);
      for (const value of after.values) assert.ok(value.text.includes('11/14 23:59'), value.text);
      assert.equal(errors.length, 0, errors.join('\n'));
      console.info('Initial timezone ordering:', JSON.stringify({ kind: scenario.kind, load, ...after }));
    } finally { release(); await context.close(); }
  }
  assert.ok(performance.now() - started < 30000, 'all fresh loads finish before the normal state poll');
}
