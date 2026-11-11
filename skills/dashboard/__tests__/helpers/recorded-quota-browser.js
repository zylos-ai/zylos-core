import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSessionReader } from '../../../../cli/lib/session-state-reader-async.js';
import { createGroupSnapshot } from '../../src/lib/workbench/group-snapshot.js';
import { sendHtml, sendJson, serveStatic } from '../../src/lib/http.js';
import { workbenchAnswer } from '../fixtures/workbench-browser-api.js';

export async function runRecordedQuotaBrowser(sandbox) {
  console.log('Recorded quota browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE, executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath)); assert.ok(executablePath && fs.existsSync(executablePath));
  const now = Date.now(), recordedAt = now - 86400000, services = new Map();
  const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
  for (const state of ['live', 'recorded', 'expired']) {
    const root = path.join(sandbox.paths.zylos, state), dir = path.join(root, 'activity-monitor/session-groups/origin');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'statusline.json'), JSON.stringify({ session_id: 'saved',
      zylos: { v: 1, runId: 'saved-run', capturedAt: recordedAt },
      rate_limits: { seven_day: { used_percentage: 4, resets_at: Math.floor(now / 1000) + (state === 'expired' ? -1 : 86400) } } }));
    const identity = { present: state === 'live', ready: state === 'live', runtime: 'claude', runId: 'saved-run', sessionId: 'saved' };
    const reader = createSessionReader({ env: { ZYLOS_DIR: root }, now: () => now,
      open: async () => ({ close: async () => {} }), observe: async () => identity,
      listSessions: async () => state === 'live' ? [{ sessionGroup: 'origin' }] : [] });
    const snapshot = createGroupSnapshot({ zylosDir: root, now: () => now,
      store: { latestEventByType: () => ({ metadata: { ready: state === 'live' ? 1 : 0, starting: 0, reclaiming: 0, waiting: 0 } }), queryEvents: () => [] },
      c4Reader: { getInboundTimes: () => [], listSlotOccupancy: () => [] }, readPm2: () => ({ processes: [] }),
      cli: { runC4Db: async args => ({ ok: true, data: args[0] === 'groups' ? { groups: [], hasOlder: false } : { groups: [], globalFence: null } }),
        readOverrides: async () => ({ ok: true, data: { baseline: { runtime: 'claude' }, runtime: [], model: [] } }) },
      loadCoreModule: async name => name === 'config.js' ? { readSessionMode: () => ({ mode: 'multi' }) }
        : name === 'session-state-reader.js' ? reader : { collectStatus: async ({ session }) => {
          await session('origin', { freshnessMs: 5000 });
          return { view: 'multi', origin: { presence: state === 'live' ? 'running' : 'not_running',
            status: { valid: state === 'live', state: 'idle' } }, groups: [], groupListError: null,
            runtimeHealth: { claude: { health: 'ok' } } };
        } },
    });
    const value = await snapshot.getSnapshot();
    if (state === 'recorded') {
      assert.equal(value.instance.pool.used, 0); assert.equal(value.rows[0].presence, 'not_running');
      assert.equal(value.instance.accounts.claude.used_percentage, 4); assert.equal(value.instance.accounts.claude.live, false);
      assert.equal(value.instance.accounts.claude.recordedAt, recordedAt);
    }
    if (state === 'expired') assert.equal(value.instance.accounts.claude, null);
    services.set(state, value);
  }
  let selected = 'recorded', serverError;
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return; }
      if (url.pathname === '/api/workbench/groups') return sendJson(res, 200, services.get(selected));
      if (url.pathname.startsWith('/api/')) {
        let value = workbenchAnswer(url, now);
        if (url.pathname === '/api/state') value = { ...value, state: selected === 'live' ? 'IDLE' : 'SLEEPING', tz: 'Asia/Shanghai' };
        if (url.pathname === '/api/instance-status') value.data.origin.presence = selected === 'live' ? 'running' : 'not_running';
        if (value === undefined) throw new Error(`Unserved API: ${url.pathname}`);
        return sendJson(res, 200, value);
      }
      if (url.pathname === '/') return sendHtml(res, 200, fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
        .replaceAll('__BASE_PATH__', '').replaceAll('__ASSET_ROOT__', '/_assets').replaceAll('__REMOTE_ACCESS__', 'admin'));
      if (!serveStatic(req, res, publicDir)) { res.writeHead(404); res.end(); }
    } catch (error) { serverError ??= error.message; sendJson(res, 500, { error: 'fixture_failed' }); }
  });
  const base = await sandbox.startHttp(server);
  const scratchParent = process.env.ZYLOS_CHAT_BROWSER_TMP_PARENT;
  assert.ok(scratchParent && path.isAbsolute(scratchParent));
  const scratch = fs.mkdtempSync(path.join(scratchParent, 'recorded-quota-'));
  sandbox.addCleanup(() => fs.rmSync(scratch, { recursive: true, force: true }));
  console.log('Recorded quota browser scratch:', scratch);
  const { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: { ...sandbox.env, TMPDIR: scratch },
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const metrics = [];
  for (const locale of ['zh', 'en']) for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale, timezoneId: 'UTC', reducedMotion: 'reduce' });
    sandbox.addCleanup(() => context.close());
    await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
    await context.addInitScript(({ locale, theme }) => {
      if (window !== window.top) return;
      localStorage.setItem('zylos-dashboard-locale', locale); localStorage.setItem('zylos-dashboard-theme', theme);
      localStorage.setItem('zylos-dashboard-detail-level', 'technical');
    }, { locale, theme });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    let pageError, responseError;
    page.on('pageerror', error => { pageError ??= error.message; });
    page.on('response', response => { if (response.status() >= 400) responseError ??= `${response.status()} ${new URL(response.url()).pathname}`; });
    for (const state of ['live', 'recorded', 'expired']) {
      selected = state;
      await page.goto(base + '/');
      const strip = page.locator('#wb-instance .wb-account').first();
      try { await strip.waitFor(); } catch (error) {
        if (evidence) await page.screenshot({ path: path.join(evidence, 'quota-failure.png'), fullPage: true });
        throw new Error(JSON.stringify({ pageError, responseError, serverError,
          body: (await page.locator('body').innerText()).slice(0, 2500) }), { cause: error });
      }
      await page.waitForFunction(() => document.querySelector('#wb-instance .wb-account')?.textContent.includes('%') ||
        /暂无数据|No data/.test(document.querySelector('#wb-instance .wb-account')?.textContent));
      const text = await strip.textContent(), title = await strip.getAttribute('title');
      assert.ok(text.includes(state === 'expired' ? (locale === 'zh' ? '暂无数据' : 'No data') : '96%'), text);
      assert.equal(/记录|Recorded/.test(text), state === 'recorded');
      if (state === 'recorded') {
        const year = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(recordedAt);
        assert.ok(!text.includes(year)); assert.match(title, /最近一次记录|most recent recorded/);
        assert.match(title, /没有会话上报额度|No session is currently reporting quota/);
      }
      assert.equal(pageError, undefined, pageError); assert.equal(serverError, undefined, serverError);
      const measured = await page.evaluate(() => ({
        accounts: [...document.querySelectorAll('#wb-instance .wb-account')].map(node => ({ width: node.getBoundingClientRect().width, scrollWidth: node.scrollWidth })),
        records: [...document.querySelectorAll('.wb-quota-recorded')].map(node => ({ text: node.textContent, width: node.getBoundingClientRect().width, scrollWidth: node.scrollWidth })) }));
      for (const account of measured.accounts) assert.ok(account.scrollWidth <= account.width + 1, JSON.stringify({ state, locale, width, theme, account }));
      for (const record of measured.records) assert.ok(record.scrollWidth <= record.width + 1);
      if (evidence) await page.screenshot({ path: path.join(evidence, `quota-${state}-${locale}-${width}-${theme}.png`), fullPage: true });
      metrics.push({ state, locale, width, theme, text, title, ...measured });
    }
    await context.close();
  }
  if (evidence) fs.writeFileSync(path.join(evidence, 'recorded-quota-metrics.json'), JSON.stringify({ now, recordedAt, metrics }, null, 2));
  console.log('Recorded quota browser: 24 real-page states verified, retained groups/no live sessions reproduces 96% with recorded time; expired records show no data.');
}
