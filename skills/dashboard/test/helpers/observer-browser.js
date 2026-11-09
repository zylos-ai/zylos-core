import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendHtml, sendJson, serveStatic } from '../../src/lib/http.js';
import { GROUP, workbenchAnswer } from '../fixtures/workbench-browser-api.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const OTHER = 'lark:team.topic';
// The fixture frame says it is ready, and reports the terminal size a case hands it ("fixture-metrics"), as the
// real frame reports its rendered size.
const frame = '<!doctype html><html><body>Private observer fixture<script>let p=null;addEventListener("message",e=>{if(e.data?.type==="observer-init"){p=e.ports[0];p.start();p.postMessage({type:"ready"});}else if(e.data?.type==="fixture-metrics"&&p)p.postMessage({type:"metrics",width:e.data.width,height:e.data.height});})</script></body></html>';

// Full shipped entry/modules and native browser events. API/iframe/WebSocket are
// fixtures, so these cases do not replace manager concurrency or native tmux tests.
export async function runObserverBrowser(t, sandbox, signal) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE;
  const executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath));
  assert.ok(executablePath && fs.existsSync(executablePath));
  console.log('Observer browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const writes = [], reads = [], errors = [], held = new Set(), waits = new Set();
  let mode = 'multi', scenario = 'normal', groupCount = 2, counter = 0, heldLease = null;
  let rapidInterval = 150, rapidCalls = 0, base;
  const now = Date.now();
  const record = (rows, value) => { assert.ok(rows.length < 1000, 'fixture trace is bounded'); rows.push(value); };
  const pause = ms => new Promise((resolve, reject) => {
    const wait = { timer: null, abort: () => { clearTimeout(wait.timer); waits.delete(wait); reject(new Error('observer browser case stopped')); } };
    wait.timer = setTimeout(() => { waits.delete(wait); if (signal.aborted) reject(new Error('observer browser case stopped')); else resolve(); }, ms);
    waits.add(wait);
  });
  async function until(check, label, timeout = 5000) {
    const end = Date.now() + timeout;
    for (let attempt = 0; attempt < 300; attempt++) {
      signal.throwIfAborted();
      if (check()) return;
      if (Date.now() >= end) break;
      await pause(20);
    }
    throw new Error('Timed out: ' + label);
  }
  function answer(url) {
    const p = url.pathname;
    if (p === '/api/observer/status') {
      const group = url.searchParams.get('session_group');
      const legacy = mode === 'legacy';
      const running = mode === 'single' || legacy || Boolean(group && group !== 'origin' && groupCount);
      return { state: 'installed', desired: { enabled: true, generation: 1, teardownFence: false },
        ...(legacy ? {} : { sessionMode: mode, target: running ? { sessionGroup: mode === 'single' ? null : group, runId: 'run-' + (group || 'single'), runtime: 'claude' } : null }),
        runtime: { state: 'idle' }, agentSize: running ? { cols: 120, rows: 40 } : null };
    }
    if (p.startsWith('/api/observer/history/')) return { sessions: [], entries: [], hasMore: false };
    const value = workbenchAnswer(url, now) ?? {};
    if (p === '/api/state') { value.state = mode === 'multi' ? 'SLEEPING' : 'IDLE'; value.runId = mode === 'multi' ? null : 'origin-run'; value.sessionId = null; }
    if (p === '/api/instance-status') value.data.origin = { presence: mode === 'multi' ? 'not_running' : 'running' };
    if (p === '/api/workbench/groups') {
      value.mode = mode === 'single' ? 'single' : 'multi';
      value.rows[0] = { ...value.rows[0], presence: mode === 'multi' ? 'not_running' : 'running', state: { kind: mode === 'multi' ? 'not_running' : 'idle' }, live: mode === 'multi' ? null : { runId: 'origin-run', sessionId: 's0' } };
      value.rows[2] = { ...value.rows[2], sessionGroup: OTHER, name: null, presence: 'running', state: { kind: 'idle' }, live: { runId: 'run-lark', sessionId: 's2' }, launchConfig: { runtime: 'claude', mode: 'default' } };
      if (!groupCount) for (const row of value.rows) { row.presence = 'not_running'; row.live = null; row.state = { kind: 'not_running' }; }
    }
    return value;
  }
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname.startsWith('/api/')) record(reads, { path: url.pathname, scenario });
      if (req.method !== 'GET') {
        let body = '';
        req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
        req.on('end', () => {
          try {
            const entry = { path: url.pathname, body: JSON.parse(body || '{}'), scenario }; record(writes, entry);
            if (url.pathname === '/api/observer/leases') {
              const group = entry.body.sessionGroup;
              const lease = { id: 'fixture-' + (++counter), ...(mode === 'legacy' || scenario === 'single-undefined' ? {} : { sessionGroup: scenario === 'wrong-group' ? 'origin' : group }), ticket: 'fixture-ticket' };
              if (scenario === 'pending-lease' && group === GROUP) { heldLease = { res, lease }; held.add(res); return; }
              if (scenario === 'rapid') {
                const call = ++rapidCalls;
                if (call <= 2) { held.add(res); const wait = setTimeout(() => { held.delete(res); if (!res.destroyed) sendJson(res, call === 1 ? 503 : 201, call === 1 ? { error: 'operation_obsolete' } : lease); }, rapidInterval * 3 + 100); sandbox.addCleanup(() => clearTimeout(wait)); return; }
                if (call === 3) { sendJson(res, 503, { error: 'operation_obsolete' }); return; }
              }
              sendJson(res, 201, lease); return;
            }
            if (url.pathname.endsWith('/release')) { if (scenario === 'pending-release') { held.add(res); return; } sendJson(res, 200, { released: true }); return; }
            if (url.pathname.endsWith('/renew')) { sendJson(res, 200, { id: url.pathname.split('/').at(-2), sessionGroup: mode === 'single' ? null : GROUP, ticket: 'renew-ticket' }); return; }
            sendJson(res, 409, { error: 'fixture_unsupported' });
          } catch (error) { record(errors, error.message); if (!res.destroyed) sendJson(res, 500, { error: 'fixture_error' }); }
        });
        return;
      }
      if (url.pathname === '/observer/frame') { sendHtml(res, 200, frame); return; }
      if (url.pathname === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return; }
      if (url.pathname.startsWith('/api/')) { sendJson(res, 200, answer(url)); return; }
      if (['/', '/observer', '/settings'].includes(url.pathname)) { sendHtml(res, 200, fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8').replaceAll('__BASE_PATH__', '').replaceAll('__ASSET_ROOT__', '/_assets').replaceAll('__REMOTE_ACCESS__', 'admin')); return; }
      if (!serveStatic(req, res, publicDir)) sendJson(res, 404, { error: 'not_found' });
    } catch (error) { record(errors, error.message); if (!res.destroyed) sendJson(res, 500, { error: 'fixture_error' }); }
  });
  base = await sandbox.startHttp(server);
  const { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  sandbox.addCleanup(() => { for (const res of held) res.destroy(); held.clear(); for (const wait of waits) wait.abort(); });
  async function open(locale = 'en', width = 1280) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: locale === 'en' ? 'en-US' : 'zh-CN' });
    sandbox.addCleanup(() => context.close());
    await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
    await context.addInitScript(locale => {
      if (window === window.top) { try { localStorage.setItem('zylos-dashboard-locale', locale); localStorage.setItem('zylos-dashboard-theme', 'light'); localStorage.setItem('zylos-dashboard-detail-level', 'technical'); } catch {} }
      window.__observerSockets = [];
      window.WebSocket = class {
        constructor(url, protocols) { this.url = String(url); this.protocols = protocols; this.readyState = 1; window.__observerSockets.push(this); }
        close(code, reason) { this.readyState = 3; this.closed = { code, reason }; }
        send() {}
      };
    }, locale);
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    const startup = [];
    page.on('console', message => { if (message.type() === 'error' && startup.length < 8) startup.push(message.text().slice(0, 400)); });
    page.on('response', response => { if (response.status() >= 400 && startup.length < 8) startup.push(`${response.status()} ${response.url()}`); });
    page.on('requestfailed', request => { if (startup.length < 8) startup.push(`${request.failure()?.errorText} ${request.url()}`); });
    page.on('pageerror', error => record(errors, error.message));
    try {
      await page.goto(base + '/'); await page.locator('#observer-tab').waitFor({ state: 'visible' });
      return { page, context };
    } catch (error) {
      console.log('Observer startup diagnostics:', JSON.stringify({ startup, errors: errors.slice(0, 5), reads: reads.slice(-15) }));
      await context.close();
      throw error;
    }
  }
  const select = (page, group) => page.locator('#observer-group-select').selectOption(group);
  async function observing(page, group = GROUP) { await page.locator('#observer-tab').click(); await select(page, group); await page.waitForFunction(() => window.__observerSockets.length > 0); }
  const leaseWrites = start => writes.slice(start).filter(row => row.path === '/api/observer/leases');
  const step = async (name, fn) => {
    let failure;
    await t.test(name, async () => {
    signal.throwIfAborted();
    let context;
    try { const opened = await open(); context = opened.context; await fn(opened.page); assert.equal(errors.length, 0, errors[0]); }
    catch (error) { console.log('Observer case diagnostics:', JSON.stringify({ name, errors: errors.slice(0, 5), writes: writes.slice(-10), reads: reads.slice(-10) })); failure = error; throw error; }
    finally { await context?.close(); for (const res of held) res.destroy(); held.clear(); heldLease = null; }
    });
    if (failure) throw failure;
  };

  mode = 'multi'; scenario = 'normal'; groupCount = 2;
  await step('group detail activates observation directly and sends the selected group', async page => {
    await page.locator(`[data-group="${GROUP}"]`).click();
    const button = page.locator(`button[data-observer-group="${GROUP}"]`); await button.waitFor({ state: 'visible' });
    await page.evaluate(() => { document.querySelector('#observer-tab').click = () => { throw new Error('Observer entry must activate the page directly'); }; });
    const before = writes.length, groupReads = reads.filter(row => row.path === '/api/workbench/groups').length;
    await button.click(); await page.waitForFunction(() => window.__observerSockets.length > 0);
    assert.equal(leaseWrites(before)[0].body.sessionGroup, GROUP);
    assert.ok(reads.filter(row => row.path === '/api/workbench/groups').length > groupReads);
    assert.equal(await page.locator('#observer-group-picker').isVisible(), false);
  });
  await step('top observer entry clears a previously observed group after its detail closes', async page => {
    await page.locator(`[data-group="${GROUP}"]`).click();
    await page.locator(`button[data-observer-group="${GROUP}"]`).click();
    await page.waitForFunction(() => window.__observerSockets.length > 0);
    assert.equal(leaseWrites(0).at(-1).body.sessionGroup, GROUP);

    await page.locator('.tab[data-tab="overview"]').click();
    await page.locator('#wb-side').waitFor({ state: 'visible' });
    assert.equal(await page.locator(`#wb-board [data-group="${GROUP}"]`).getAttribute('aria-current'), 'true');
    await page.keyboard.press('Escape');
    await page.locator('#wb-side').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#wb-board [aria-current="true"]').count(), 0, 'closing detail leaves no current group');

    const before = writes.length, sockets = await page.evaluate(() => window.__observerSockets.length);
    await page.locator('#observer-tab').click();
    await page.locator('#tab-observer').waitFor({ state: 'visible' });
    await page.locator('#observer-group-picker').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#observer-group-select').inputValue(), '', 'top entry must clear the stale observed group');
    await page.waitForFunction(() => /Choose a running group/.test(document.querySelector('#observer-notice')?.textContent || ''));
    assert.equal(leaseWrites(before).length, 0, 'no selected detail means no automatic lease acquisition');
    assert.equal(await page.evaluate(() => window.__observerSockets.length), sockets, 'stale observation must not reconnect');
    assert.equal(await page.locator('.observer-frame-shell').isVisible(), false);
  });
  // The status row describes the live connection: the history view hides it (the view switch re-renders the
  // page), and going back to the live view shows it again.
  await step('the history view hides the live status row', async page => {
    await observing(page);
    const row = page.locator('.wb-o-notice');
    await row.waitFor({ state: 'visible' });
    await page.locator('[data-observer-view="history"]').click();
    await page.locator('#observer-history').waitFor({ state: 'visible' });
    assert.equal(await row.isVisible(), false, 'history view: no live status row');
    await page.locator('[data-observer-view="live"]').click();
    await row.waitFor({ state: 'visible' });
    await page.locator('[data-observer-view="history"]').click();
    await page.locator('#observer-history').waitFor({ state: 'visible' });
    assert.equal(await row.isVisible(), false, 'history view again: no live status row');
  });
  // Status row, wide-terminal hint and size button follow the page state: hidden while a running group is to be
  // picked; a terminal wider than its frame marks the frame and shows the hint; the size button goes with the form.
  await step('the status row, the wide-terminal hint and the size button follow the page state', async page => {
    await page.locator('#observer-tab').click();
    await page.locator('#observer-group-picker').waitFor({ state: 'visible' });
    await page.waitForFunction(() => /Choose a running group/.test(document.querySelector('#observer-notice')?.textContent || ''));
    assert.equal(await page.locator('.wb-o-notice').isVisible(), false, 'choosing among running groups: the picker speaks, the row is hidden');
    await select(page, GROUP); await page.waitForFunction(() => window.__observerSockets.length > 0);
    await page.locator('.wb-o-notice').waitFor({ state: 'visible' });
    const shell = page.locator('.observer-frame-shell'), hint = page.locator('.wb-o-wide-hint');
    await shell.waitFor({ state: 'visible' });
    const report = width => page.evaluate(width => document.querySelector('#observer-frame').contentWindow.postMessage({ type: 'fixture-metrics', width, height: 400 }, '*'), width);
    await report(5000);
    await page.waitForFunction(() => document.querySelector('.observer-frame-shell').classList.contains('wb-o-wide'));
    assert.equal(await hint.isVisible(), true, 'a terminal wider than its frame shows the sideways hint');
    await report(200);
    await page.waitForFunction(() => !document.querySelector('.observer-frame-shell').classList.contains('wb-o-wide'));
    assert.equal(await hint.isVisible(), false, 'a terminal that fits shows no hint');
    const size = () => page.evaluate(() => ({ form: document.querySelector('#observer-size-form').hidden, button: document.querySelector('#observer-size-toggle').hidden }));
    assert.deepEqual(await size(), { form: false, button: false }, 'live view with a known agent size: form and button offered');
    await page.locator('[data-observer-view="history"]').click();
    await page.locator('#observer-history').waitFor({ state: 'visible' });
    assert.deepEqual(await size(), { form: true, button: true }, 'history view: no size form, and no button for it');
  });
  scenario = 'pending-lease';
  await step('late lease acquisition cannot block selecting another group and is released', async page => {
    await page.locator('#observer-tab').click(); await select(page, GROUP); await until(() => heldLease, 'pending lease');
    const started = Date.now(); await select(page, OTHER); await page.waitForFunction(() => window.__observerSockets.length > 0);
    assert.ok(Date.now() - started < 2500, 'navigation cannot wait for the unresolved old lease');
    const old = heldLease; heldLease = null; held.delete(old.res); sendJson(old.res, 201, old.lease);
    await until(() => writes.some(row => row.path.endsWith('/' + old.lease.id + '/release')), 'late lease release');
  });
  scenario = 'pending-release';
  await step('unresolved release cannot block navigation to a new group', async page => {
    await observing(page); const started = Date.now(); await select(page, OTHER); await page.waitForFunction(() => window.__observerSockets.length >= 2);
    assert.ok(Date.now() - started < 2500, 'new group must connect before release resolves');
  });
  scenario = 'wrong-group';
  await step('mismatched lease is released without a live frame or retry', async page => {
    const before = writes.length; await page.locator('#observer-tab').click(); await select(page, GROUP);
    await page.waitForFunction(() => /does not support/.test(document.querySelector('#observer-notice')?.textContent || ''));
    await until(() => writes.slice(before).some(row => row.path.endsWith('/release')), 'wrong lease release');
    await pause(1200); assert.equal(leaseWrites(before).length, 1); assert.equal(await page.evaluate(() => window.__observerSockets.length), 0);
    assert.equal(await page.locator('.observer-frame-shell').isVisible(), false);
  });
  scenario = 'normal';
  await step('every public child or upstream failure code reconnects', async page => {
    await observing(page);
    for (const reason of ['child_failure', 'upstream_closed', 'stream_error', 'dashboard_shutdown']) {
      const before = await page.evaluate(() => window.__observerSockets.length);
      await page.evaluate(reason => {
        const ws = window.__observerSockets.at(-1);
        ws.onmessage({ data: new Uint8Array([65]).buffer });
        ws.onclose({ reason });
      }, reason);
      await page.waitForFunction(before => window.__observerSockets.length > before, before);
    }
  });
  for (const interval of [150, 500, 1000]) {
    scenario = 'rapid'; rapidInterval = interval; rapidCalls = 0;
    await step(`alternating groups recover a superseded request at ${interval}ms`, async page => {
      await page.locator('#observer-tab').click(); await select(page, GROUP); await until(() => rapidCalls === 1, 'first alternating request');
      await pause(interval); await select(page, OTHER); await until(() => rapidCalls === 2, 'second alternating request');
      await pause(interval); await select(page, GROUP); await page.waitForFunction(() => window.__observerSockets.length > 0);
      assert.ok(rapidCalls >= 4, 'the latest obsolete request must retry');
      assert.equal(await page.evaluate(() => window.__observerSockets.at(-1).readyState), 1);
      assert.doesNotMatch(await page.locator('#observer-notice').textContent(), /target_mismatch/);
      assert.equal(await page.locator('#observer-group-select').inputValue(), GROUP);
      await until(() => held.size === 0, 'obsolete responses finish');
    });
  }
  mode = 'legacy'; scenario = 'normal';
  await step('legacy producer still observes Origin without a lease group field', async page => {
    const before = writes.length; await page.locator('#observer-tab').click(); await page.waitForFunction(() => window.__observerSockets.length > 0);
    assert.equal(Object.hasOwn(leaseWrites(before)[0].body, 'sessionGroup'), false);
  });
  await step('legacy producer rejects other groups before creating a lease', async page => {
    await page.locator(`[data-group="${GROUP}"]`).click(); const before = writes.length;
    await page.locator(`button[data-observer-group="${GROUP}"]`).click();
    await page.waitForFunction(() => /does not support/.test(document.querySelector('#observer-notice')?.textContent || ''));
    assert.equal(leaseWrites(before).length, 0); assert.equal(await page.evaluate(() => window.__observerSockets.length), 0);
    assert.equal(await page.locator('.observer-frame-shell').isVisible(), false);
  });
  mode = 'single'; scenario = 'normal';
  await step('modern single mode sends and accepts the explicit null binding', async page => {
    const before = writes.length; await page.locator('#observer-tab').click(); await page.waitForFunction(() => window.__observerSockets.length > 0);
    assert.equal(leaseWrites(before)[0].body.sessionGroup, null);
  });
  scenario = 'single-undefined';
  await step('modern single mode rejects an absent lease binding', async page => {
    const before = writes.length; await page.locator('#observer-tab').click();
    await page.waitForFunction(() => /does not support/.test(document.querySelector('#observer-notice')?.textContent || ''));
    await until(() => writes.slice(before).some(row => row.path.endsWith('/release')), 'single mismatch release');
    assert.equal(await page.evaluate(() => window.__observerSockets.length), 0);
  });
  mode = 'multi'; scenario = 'normal';
  for (const locale of ['en', 'zh']) for (const width of [1280, 390]) {
    const { page, context } = await open(locale, width);
    try {
      await page.goto(base + '/settings');
      const status = page.locator('#observer-settings-state');
      if (width < 761) await page.locator('.wb-set-drawer-btn').click();
      await page.locator('[data-settings-section="observer"]').first().click();
      await page.waitForFunction(() => document.querySelector('#observer-settings-state')?.textContent.includes('2'));
      if (width < 761) {
        // Closing the drawer removes its open class before the CSS slide and
        // scrim fade finish. Capture the settled content, not that transition.
        await page.waitForFunction(() => {
          const nav = document.querySelector('.wb-set-nav'), scrim = document.querySelector('.wb-set-scrim');
          return !document.querySelector('.wb-set').classList.contains('wb-set-drawer-open') && !history.state?.settingsDrawer
            && getComputedStyle(nav).visibility === 'hidden' && getComputedStyle(scrim).visibility === 'hidden';
        });
        assert.equal(await page.locator('.wb-set-nav').isVisible(), false, 'closed mobile navigation cannot cover the settings screenshot');
        assert.equal(await page.locator('.wb-set-scrim').isVisible(), false, 'closed mobile scrim cannot cover the settings screenshot');
      }
      await status.scrollIntoViewIfNeeded();
      assert.equal(await status.isVisible(), true, 'observer settings status is visible before capture');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      if (evidence) await page.screenshot({ path: path.join(evidence, `observer-settings-${locale}-${width}.png`) });
      groupCount = 0; await page.reload();
      if (!await status.isVisible()) { if (width < 761) await page.locator('.wb-set-drawer-btn').click(); await page.locator('[data-settings-section="observer"]').first().click(); }
      await page.waitForFunction(() => /No groups|没有运行/.test(document.querySelector('#observer-settings-state')?.textContent || ''));
      groupCount = 2;
    } finally { await context.close(); }
  }
  assert.equal(errors.length, 0, errors[0]);
  console.log('Observer browser completed:', JSON.stringify({ writes: writes.length, reads: reads.length, contextsClosed: true, databaseUnused: true }));
}
