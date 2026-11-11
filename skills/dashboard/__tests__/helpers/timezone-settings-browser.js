import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendHtml, sendJson, serveStatic, readJsonBody } from '../../src/lib/http.js';
import { workbenchAnswer } from '../fixtures/workbench-browser-api.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const serviceList = [{ name: 'scheduler', status: 'online' }, { name: 'activity-monitor', status: 'online' }, { name: 'c4-dispatcher', status: 'online' }];
async function startPage(sandbox) {
  const writes = [], restarts = [], reads = [], zones = new Map(), now = Date.now();
  const state = { initialTimezone: 'Asia/Calcutta', partialRestart: false, unavailableAfterProgress: false, rejectTimezone: false };
  const server = http.createServer(async (req, res) => {
    try {
      const original = new URL(req.url, 'http://127.0.0.1');
      const prefix = original.pathname.match(/^\/fleet\/(admin|reader)/)?.[0] ?? '';
      const route = original.pathname.slice(prefix.length) || '/';
      const url = new URL(route + original.search, original.origin);
      const settings = () => ({ tz: zones.get(prefix) ?? state.initialTimezone, writable: true, read_only_reason: null,
        restart_services: serviceList, restart_status: 'known' });
      if (route === '/api/settings/timezone') {
        if (req.method === 'GET') { reads.push(original.pathname); sendJson(res, 200, settings()); return; }
        if (req.method === 'PUT') {
          const body = await readJsonBody(req, 4096);
          if (state.rejectTimezone) { state.rejectTimezone = false; sendJson(res, 400, { error: 'timezone_unavailable_on_host' }); return; }
          writes.push({ path: original.pathname, body }); zones.set(prefix, body.tz);
          sendJson(res, 200, { ok: true, changed: true, previous: 'UTC', ...settings() }); return;
        }
      }
      if (route === '/api/actions/restart-timezone-services' && req.method === 'POST') {
        const body = await readJsonBody(req, 4096); restarts.push({ path: original.pathname, body });
        if (state.unavailableAfterProgress) {
          state.unavailableAfterProgress = false;
          sendJson(res, 503, { ok: false, error: 'service_discovery_unavailable', restarted: ['scheduler'], failed: [], restart_status: 'unknown', restart_services: [serviceList[1]] });
        } else if (state.partialRestart) {
          state.partialRestart = false;
          sendJson(res, 200, { ok: false, restarted: ['activity-monitor'], failed: [{ name: 'scheduler', error: 'restart_failed' }], restart_services: [serviceList[0]] });
        } else sendJson(res, 200, { ok: true, restarted: body.services, failed: [], restart_services: [] }); return;
      }
      if (route === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return; }
      if (route.startsWith('/api/')) {
        let value = req.method === 'GET' ? workbenchAnswer(url, now) : undefined;
        if (route === '/api/state') value = { ...value, tz: zones.get(prefix) ?? state.initialTimezone };
        sendJson(res, value === undefined ? 404 : 200, value ?? { error: 'not_found' }); return;
      }
      if (['/', '/settings', '/usage', '/memory'].includes(route)) {
        sendHtml(res, 200, fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
          .replaceAll('__BASE_PATH__', prefix).replaceAll('__ASSET_ROOT__', prefix + '/_assets')
          .replaceAll('__REMOTE_ACCESS__', prefix.endsWith('/reader') ? 'read' : 'admin')); return;
      }
      req.url = route + original.search;
      if (serveStatic(req, res, publicDir)) return;
      sendJson(res, 404, { error: 'not_found' });
    } catch (error) { sendJson(res, 500, { error: error.message }); }
  });
  return { base: await sandbox.startHttp(server), writes, restarts, reads, state };
}

function measure() {
  const card = document.querySelector('#settings-timezone');
  const controls = [...card.querySelectorAll('button, select')].filter(node => !node.hidden && !node.closest('[hidden]'));
  const boxes = controls.map(node => { const b = node.getBoundingClientRect(); return { id: node.id, width: b.width, height: b.height, top: b.top }; });
  const input = boxes.find(node => node.id === 'settings-timezone-value'), save = boxes.find(node => node.id === 'settings-timezone-save');
  return { boxes, width: document.documentElement.scrollWidth, inputStyle: { disabled: card.querySelector('select').disabled, borderStyle: getComputedStyle(card.querySelector('select')).borderTopStyle, cursor: getComputedStyle(card.querySelector('select')).cursor },
    aligned: Math.abs(input.top - save.top) < 1 && Math.abs(input.height - save.height) < 1 };
}

export async function runTimezoneSettingsBrowser(t, sandbox) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE, executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath), 'Existing Playwright module required');
  assert.ok(executablePath && fs.existsSync(executablePath), 'Existing browser required');
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  console.log('Timezone browser launch:', JSON.stringify({ isolation: sandbox.assertIsolation(), modulePath, executablePath, publicDir }));
  const api = await startPage(sandbox);
  const { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const metrics = [];
  async function open(width, locale, prefix = '') {
    const context = await browser.newContext({ viewport: { width, height: 844 }, locale: locale === 'zh' ? 'zh-CN' : 'en-US', timezoneId: 'Pacific/Honolulu',
      ...(width < 761 ? { isMobile: true, hasTouch: true } : {}) });
    sandbox.addCleanup(() => context.close());
    await context.route('**/*', request => request.request().url().startsWith(api.base + '/') ? request.continue() : request.abort());
    await context.addInitScript(locale => {
      try {
        localStorage.setItem('zylos-dashboard-locale', locale);
        localStorage.setItem('zylos-dashboard-theme', 'light');
      } catch { /* Sandboxed embedded documents have no local storage. */ }
    }, locale);
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => { if (errors.length < 4) errors.push(error.message); });
    await page.goto(api.base + prefix + '/settings');
    if (width < 761) {
      await page.locator('.wb-set-drawer-btn').click();
      await page.locator('[data-settings-section="defaults"]').click();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.wb-set-nav')).visibility === 'hidden');
    } else await page.locator('[data-settings-section="defaults"]').click();
    await page.locator('#settings-timezone-value').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#settings-timezone-value').value !== '');
    await page.locator('#settings-timezone').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#settings-timezone h4 .wb-ico-clock[aria-hidden="true"]').count(), 1);
    const layout = await page.evaluate(measure);
    assert.equal(layout.width, width, 'No horizontal overflow');
    assert.equal(layout.aligned, true, 'Input and save share a row and height');
    if (width >= 761) assert.ok(layout.boxes.find(box => box.id === 'settings-timezone-value').width <= 280, 'Desktop input stays bounded');
    if (prefix.endsWith('/reader')) { assert.equal(layout.inputStyle.borderStyle, 'dashed'); assert.equal(layout.inputStyle.cursor, 'not-allowed'); }
    for (const box of layout.boxes) { assert.ok(box.height >= 40 && box.width >= 40, JSON.stringify(box)); }
    metrics.push({ width, locale, prefix, ...layout });
    const shot = async kind => { if (evidence) {
      await page.locator('#settings-timezone').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(evidence, `${locale}-${width}-${kind}.png`) });
      if (['editable', 'readonly', 'saved'].includes(kind)) await page.locator('#settings-timezone').screenshot({ path: path.join(evidence, `${locale}-${width}-${kind}-card.png`) });
    } };
    return { page, context, errors, shot };
  }
  const dialog = page => page.locator('.wb-modal[role="alertdialog"]');
  async function answer(page, yes) { await dialog(page).waitFor(); await dialog(page).locator('.wb-modal-acts button').nth(yes ? 1 : 0).click(); await dialog(page).waitFor({ state: 'detached' }); }

  // Sequential and fail-fast: a first assertion stops the matrix, rather than accumulating browser failures.
  for (const locale of ['en', 'zh']) for (const width of [1280, 390]) {
    const { page, context, errors, shot } = await open(width, locale, '/fleet/admin');
    try {
      assert.equal(await page.locator('#settings-timezone-value').isDisabled(), false);
      if (api.writes.length === 0) {
        assert.equal(await page.locator('#settings-timezone-value').inputValue(), 'Asia/Calcutta');
        assert.equal(await page.locator('#settings-timezone-save').isDisabled(), true);
        await page.locator('#settings-timezone-value').selectOption('Asia/Kolkata');
      }
      const choices = await page.locator('#settings-timezone-value option').evaluateAll(nodes => nodes.filter(node => !node.disabled).map(node => node.value));
      assert.equal(new Set(choices).size, choices.length);
      for (const old of ['Asia/Calcutta', 'Europe/Kiev', 'Asia/Saigon', 'Pacific/Truk', 'Pacific/Ponape', 'Africa/Asmera']) assert.equal(choices.includes(old), false, old);
      assert.ok(await page.locator('#settings-timezone-value optgroup').count() > 1);
      await shot('editable');
      api.state.rejectTimezone = true;
      const savedBeforeRejection = api.writes.length;
      await page.locator('#settings-timezone-value').selectOption('Asia/Kolkata');
      await page.locator('#settings-timezone-save').click(); await answer(page, true);
      const reason = locale === 'zh' ? '主机系统的时区数据不支持此名称' : 'unavailable in the host system';
      await page.waitForFunction(reason => document.querySelector('#settings-timezone-result').textContent.includes(reason), reason);
      assert.equal(api.writes.length, savedBeforeRejection);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await shot('host-unsupported');
      const before = api.writes.length, restarts = api.restarts.length;
      await page.locator('#settings-timezone-value').selectOption('Asia/Singapore');
      await page.locator('#settings-timezone-save').click(); await answer(page, false);
      assert.equal(api.writes.length, before, 'Cancel never writes');
      await page.locator('#settings-timezone-save').click(); await answer(page, true);
      await page.locator('#settings-timezone-pending').waitFor({ state: 'visible' });
      assert.deepEqual(api.writes.at(-1), { path: '/fleet/admin/api/settings/timezone', body: { tz: 'Asia/Singapore' } });
      assert.equal(api.writes.length, before + 1); assert.equal(api.restarts.length, restarts, 'Saving never restarts');
      assert.equal(await page.locator('#settings-timezone-services li').count(), 4);
      await shot('saved');
      await page.locator('#settings-timezone-restart').click();
      await dialog(page).waitFor();
      if (width < 761) {
        const controls = await dialog(page).locator('button').evaluateAll(nodes => nodes.map(node => { const b = node.getBoundingClientRect(); return { width: b.width, height: b.height }; }));
        for (const box of controls) assert.ok(box.height >= 40 && box.width >= 40, JSON.stringify(box));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      }
      await shot('confirmation');
      assert.equal(await dialog(page).locator('p').innerText().then(text => text.includes('Asia/Singapore')), true);
      await answer(page, false); assert.equal(api.restarts.length, restarts, 'Cancel keeps saved zone without restart');
      await page.locator('#settings-timezone-restart').click(); await answer(page, true);
      await page.locator('#settings-timezone-pending').waitFor({ state: 'hidden' });
      assert.deepEqual(api.restarts.at(-1), { path: '/fleet/admin/api/actions/restart-timezone-services', body: { tz: 'Asia/Singapore', confirm: true, services: ['scheduler', 'activity-monitor', 'c4-dispatcher'] } });
      assert.equal(api.restarts.length, restarts + 1); assert.deepEqual(errors, []);
    } finally { await context.close(); }
    const readOnly = await open(width, locale, '/fleet/reader');
    try {
      assert.equal(await readOnly.page.locator('#settings-timezone-value').isDisabled(), true);
      assert.equal(await readOnly.page.locator('#settings-timezone-save').isDisabled(), true);
      const before = api.writes.length;
      await readOnly.page.locator('#settings-timezone-save').dispatchEvent('click');
      assert.equal(api.writes.length, before); await readOnly.shot('readonly'); assert.deepEqual(readOnly.errors, []);
    } finally { await readOnly.context.close(); }
  }
  const local = await open(1280, 'en');
  try {
    await local.page.locator('#settings-timezone-value').selectOption('Europe/London');
    await local.page.locator('#settings-timezone-save').click(); await answer(local.page, true);
    await local.page.locator('#settings-timezone-pending').waitFor({ state: 'visible' });
    api.state.partialRestart = true;
    await local.page.locator('#settings-timezone-restart').click(); await answer(local.page, true);
    await local.page.waitForFunction(() => document.querySelector('#settings-timezone-result').textContent.includes('Some services'));
    assert.equal(await local.page.locator('#settings-timezone-services li').count(), 1);
    assert.equal(await local.page.locator('#settings-timezone-pending').isVisible(), true);
    await local.page.locator('#settings-timezone-restart').click(); await answer(local.page, true);
    await local.page.locator('#settings-timezone-pending').waitFor({ state: 'hidden' });
    assert.deepEqual(api.restarts.at(-2).body.services, ['scheduler', 'activity-monitor', 'c4-dispatcher']);
    assert.deepEqual(api.restarts.at(-1).body.services, ['scheduler'], 'Immediate retry excludes the service that already succeeded');
    assert.deepEqual(api.writes.at(-1), { path: '/api/settings/timezone', body: { tz: 'Europe/London' } });
    await local.page.locator('#settings-timezone-save').click(); await answer(local.page, true);
    await local.page.locator('#settings-timezone-pending').waitFor({ state: 'visible' });
    api.state.unavailableAfterProgress = true;
    await local.page.locator('#settings-timezone-restart').click(); await answer(local.page, true);
    await local.page.waitForFunction(() => document.querySelector('#settings-timezone-retry').hidden === false);
    assert.equal(await local.page.locator('#settings-timezone-restart').isDisabled(), true);
    assert.equal(await local.page.locator('#settings-timezone-services li').count(), 1);
    assert.equal(await local.page.locator('#settings-timezone-services li').innerText(), 'Web console');
    await local.page.locator('#settings-timezone-retry').click();
    assert.equal(await local.page.locator('#settings-timezone-services li').count(), 1);
    await local.page.locator('#settings-timezone-restart').click(); await answer(local.page, true);
    await local.page.locator('#settings-timezone-pending').waitFor({ state: 'hidden' });
    assert.deepEqual(api.restarts.at(-2).body.services, ['scheduler', 'activity-monitor', 'c4-dispatcher']);
    assert.deepEqual(api.restarts.at(-1).body.services, ['activity-monitor'], 'A real HTTP503 retains prior progress across rediscovery');
    const beforeLeave = api.writes.length;
    await local.page.locator('#settings-timezone-value').selectOption('America/New_York');
    await local.page.locator('#settings-timezone-save').click(); await dialog(local.page).waitFor();
    await local.page.locator('.tab[data-tab=overview]').dispatchEvent('click');
    await answer(local.page, true);
    assert.equal(api.writes.length, beforeLeave, 'Navigating away invalidates an outstanding save confirmation');
    assert.equal(await local.page.locator('#tab-settings').isVisible(), false);
    assert.deepEqual(local.errors, []);
  } finally { await local.context.close(); }
  const stale = await open(1280, 'en', '/fleet/admin');
  try {
    await stale.page.locator('#settings-timezone-value').selectOption('Europe/London');
    await stale.page.locator('#settings-timezone-save').click(); await answer(stale.page, true);
    await stale.page.locator('#settings-timezone-pending').waitFor({ state: 'visible' });
    const beforeRestart = api.restarts.length;
    await stale.page.locator('#settings-timezone-restart').click(); await dialog(stale.page).waitFor();
    await stale.page.locator('.tab[data-tab=overview]').dispatchEvent('click');
    await answer(stale.page, true);
    assert.equal(api.restarts.length, beforeRestart, 'Leaving the instance setting invalidates an outstanding restart confirmation');
    assert.deepEqual(stale.errors, []);
  } finally { await stale.context.close(); }
  if (evidence) fs.writeFileSync(path.join(evidence, 'metrics.json'), JSON.stringify({ metrics, writes: api.writes, restarts: api.restarts, reads: api.reads }, null, 2));
  console.log('Timezone browser verified:', JSON.stringify({ screenshots: evidence ? 32 : 0, viewportLocalePairs: 4, writes: api.writes.length, confirmedRestarts: api.restarts.length }));
}
