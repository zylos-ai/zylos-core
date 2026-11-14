import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendHtml, sendJson, serveStatic } from '../../skills/dashboard/src/lib/http.js';
import { workbenchAnswer } from '../../skills/dashboard/__tests__/fixtures/workbench-browser-api.js';
import { openDashboardTab } from '../../skills/dashboard/__tests__/helpers/browser-navigation.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../skills/dashboard/public/', import.meta.url)));
const originId = 'g:6F726967696E';
const conversations = Array.from({ length: 18 }, (_, index) => ({
  id: index ? `d:focus-${index}` : originId, localId: `focus-${index}`,
  sessionGroup: index ? null : 'origin', session_group: index ? null : 'origin',
  channel: 'dashboard', state: 'active', displayName: index ? `Focus conversation ${index}` : 'Origin',
  display_name: index ? `Focus conversation ${index}` : 'Origin',
}));

// Read computed browser geometry, never product source or a rewritten stylesheet.
function focusGeometry(control) {
  const style = getComputedStyle(control), rect = control.getBoundingClientRect();
  const outline = style.outlineStyle === 'none' ? 0 : Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
  const extent = { left: outline, right: outline, top: outline, bottom: outline };
  // Split only outside color functions: rgb()/color() contain their own commas.
  const shadows = style.boxShadow.split(/,(?![^()]*\))/);
  for (const shadow of shadows) {
    if (/\binset\b/.test(shadow) || shadow === 'none') continue;
    const lengths = shadow.replace(/(?:rgba?|hsla?|color|color-mix)\([^)]*\)/g, '').match(/-?[\d.]+px/g)?.map(parseFloat) ?? [];
    if (lengths.length < 2) continue;
    const [x, y, blur = 0, spread = 0] = lengths;
    const outer = Math.max(0, spread + blur);
    extent.left = Math.max(extent.left, outer - x); extent.right = Math.max(extent.right, outer + x);
    extent.top = Math.max(extent.top, outer - y); extent.bottom = Math.max(extent.bottom, outer + y);
  }
  const clips = [];
  for (let parent = control.parentElement; parent; parent = parent.parentElement) {
    const css = getComputedStyle(parent), r = parent.getBoundingClientRect();
    const x = /^(auto|scroll|hidden|clip)$/.test(css.overflowX), y = /^(auto|scroll|hidden|clip)$/.test(css.overflowY);
    if (!x && !y) continue;
    const borderLeft = parseFloat(css.borderLeftWidth), borderRight = parseFloat(css.borderRightWidth);
    const borderTop = parseFloat(css.borderTopWidth), borderBottom = parseFloat(css.borderBottomWidth);
    // client dimensions round to integer pixels. Preserve fractional CSS bounds
    // while excluding any actual non-overlay scrollbar from the visible viewport.
    const scrollbarX = parent.offsetWidth - parent.clientWidth - borderLeft - borderRight;
    const scrollbarY = parent.offsetHeight - parent.clientHeight - borderTop - borderBottom;
    const left = r.left + borderLeft, top = r.top + borderTop;
    const right = r.right - borderRight - (scrollbarX > 1 ? scrollbarX : 0);
    const bottom = r.bottom - borderBottom - (scrollbarY > 1 ? scrollbarY : 0);
    clips.push({ name: parent.id || parent.className || parent.tagName, x, y,
      gap: { left: rect.left - left, right: right - rect.right,
        top: rect.top - top, bottom: bottom - rect.bottom } });
  }
  return { focused: document.activeElement === control, visible: control.matches(':focus-visible'),
    outline: style.outline, offset: style.outlineOffset, shadow: style.boxShadow, extent, clips,
    width: rect.width, height: rect.height };
}

export async function runFocusClippingBrowser(sandbox, { width, theme }) {
  console.info('Focus browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const errors = [], streams = new Set(), observations = [];
  let closing = false, state = 'asleep';
  const recordError = error => { if (!closing && errors.length < 5) errors.push(String(error.message ?? error).slice(0, 1000)); };
  sandbox.addCleanup(() => { closing = true; for (const stream of streams) stream.end(); });
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1'), p = url.pathname;
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'fixture_read_only' });
      if (p === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(': ready\n\n'); streams.add(res); res.on('close', () => streams.delete(res)); return;
      }
      if (p === '/api/chat/conversations') return sendJson(res, 200, { items: conversations, nextCursor: null, tz: 'UTC', deletionAllowed: true });
      if (p.startsWith('/api/chat/conversations/')) {
        const id = decodeURIComponent(p.split('/')[4]);
        const conversation = conversations.find(item => item.id === id) ?? conversations[0];
        return sendJson(res, 200, p.endsWith('/activity') ? { now: new Date().toISOString(), items: [] }
          : /\/(messages|questions|status)$/.test(p) ? { items: [], nextCursor: null, tz: 'UTC' }
          : { conversation, stored: true });
      }
      if (p.startsWith('/api/')) {
        const value = workbenchAnswer(url, Date.now());
        if (p === '/api/workbench/groups') {
          const origin = value.rows.find(row => row.sessionGroup === 'origin');
          origin.presence = 'not_running'; origin.state = { kind: 'not_running' }; origin.live = null;
          origin.wait = state === 'pending' ? { kind: 'pool_wait', pendingCount: 1 } : null;
          origin.queue.pending.count = state === 'pending' ? 1 : 0;
        }
        if (p === '/api/settings') {
          // Normal saved custom rows stay visible without a show-unused action.
          for (const runtime of ['claude', 'codex']) value.runtimes[runtime].builtInModels = [];
        }
        return sendJson(res, value === undefined ? 404 : 200, value ?? { error: 'not_found' });
      }
      if (['/', '/chat'].includes(p)) return sendHtml(res, 200, fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
        .replaceAll('__BASE_PATH__', '').replaceAll('__ASSET_ROOT__', '/_assets').replaceAll('__REMOTE_ACCESS__', 'admin'));
      if (!serveStatic(req, res, publicDir)) sendJson(res, 404, { error: 'not_found' });
    } catch (error) { recordError(error); if (!res.headersSent) sendJson(res, 500, { error: 'fixture_failed' }); else res.end(); }
  });
  const base = await sandbox.startHttp(server);
  const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
  const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const context = await browser.newContext({ viewport: { width, height: 960 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  sandbox.addCleanup(() => context.close());
  let requests = 0;
  await context.route('**/*', async route => {
    try {
      if (new URL(route.request().url()).origin !== base) return await route.abort();
      if (++requests > 600) { recordError('fixture request bound exceeded'); return await route.abort(); }
      await route.continue();
    } catch (error) { recordError(error); }
  });
  await context.addInitScript(({ theme }) => {
    try {
      localStorage.setItem('zylos-dashboard-theme', theme);
      localStorage.setItem('zylos-dashboard-locale', 'zh');
      localStorage.setItem('zylos-dashboard-detail-level', 'technical');
    } catch {}
  }, { theme });
  const page = await context.newPage(); page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(10000);
  page.on('pageerror', recordError);
  await page.goto(base + '/');
  await page.locator('.wb-row[data-group]').first().waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), theme);

  async function check(control, name, requiredClips) {
    await control.waitFor({ state: 'visible' });
    // Enter the actual sequential keyboard focus order and return to this real
    // control. Merely calling DOM focus does not establish :focus-visible.
    await control.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    const geometry = await control.evaluate(focusGeometry);
    const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
    if (evidence) {
      fs.mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: path.join(evidence, `focus-${width}-${theme}-${name}.png`), animations: 'disabled', timeout: 5000 });
    }
    assert.ok(geometry.focused && geometry.visible, `${name}: keyboard focus and :focus-visible are active`);
    assert.ok(Object.values(geometry.extent).some(value => value > 0), `${name}: real outer focus indicator exists`);
    for (const required of requiredClips) assert.ok(geometry.clips.some(item => item.name.split(' ').includes(required)),
      `${name}: ${required} retains its clipping/scrolling behavior`);
    if (name === 'memory-editor') assert.equal(geometry.height, 520, 'default editor height is preserved');
    for (const ancestor of geometry.clips) for (const side of ['left', 'right', 'top', 'bottom']) {
      if ((side === 'left' || side === 'right') ? !ancestor.x : !ancestor.y) continue;
      const required = Math.max(4, geometry.extent[side]);
      assert.ok(ancestor.gap[side] >= required - 0.1,
        `${name}: ${side} focus extent/reserve ${required}px exceeds ${ancestor.name} gap ${ancestor.gap[side]}px; ${JSON.stringify(geometry)}`);
    }
    observations.push({ name, extent: geometry.extent, clips: geometry.clips });
  }

  await openDashboardTab(page, 'chat');
  const rows = page.locator('.conversation-list-item'); await rows.first().waitFor();
  if (width === 1280) {
    for (const [position, row] of [['first', rows.first()], ['last', rows.last()]]) {
      await check(row, `conversation-${position}`, ['conversation-items', 'conversation-page']);
      if (position === 'last') await check(row.locator('..').locator('.conversation-delete'), 'conversation-delete', ['conversation-items']);
    }
    assert.ok(await page.locator('.conversation-items').evaluate(node => node.scrollHeight > node.clientHeight), 'conversation fixture exercises a real scrolling list');
  } else {
    for (const value of ['asleep', 'pending']) {
      state = value;
      if (value === 'pending') { await page.goto(base + '/'); await page.locator('.wb-row[data-group]').first().waitFor(); await openDashboardTab(page, 'chat'); }
      await page.locator(`[data-conversation-id="${originId}"]`).click();
      const status = page.locator('.conversation-running');
      await page.waitForFunction(expected => document.querySelector('.conversation-running')?.dataset.state === expected, value === 'asleep' ? 'asleep' : 'waiting');
      await check(status, `status-${value}`, ['conversation-page']);
    }
  }

  if (width === 390) await page.locator('.conversation-back').click();
  await openDashboardTab(page, 'settings');
  if (width === 390) await page.locator('.wb-set-drawer-btn').click();
  await page.locator('[data-settings-section="pricing"]').click();
  for (const runtime of ['claude', 'codex']) {
    const tab = page.locator(`#settings-price-tab-${runtime}`);
    await check(tab, `pricing-tab-${runtime}`, ['wb-rt-tabs']);
    await tab.press('Enter');
    const inputs = page.locator('#settings-price-rows tr').first().locator('input');
    // Tab through every real cell: Chromium scrolls the table to its focused cell.
    for (let index = 0; index < await inputs.count(); index++) await check(inputs.nth(index), `pricing-${runtime}-${index}`, ['settings-table-scroll']);
  }
  await openDashboardTab(page, 'memory');
  const files = page.locator('.memory-file'); await files.first().waitFor();
  await check(files.first(), 'memory-tree-first', ['memory-tree', 'memory-tree-card']);
  await check(files.last(), 'memory-tree-last', ['memory-tree', 'memory-tree-card']);
  await files.filter({ hasText: 'state.md' }).first().click();
  await page.locator('#memory-edit-btn').click();
  // A modestly shorter real viewport exposes the desktop caret-only focus bug:
  // the 520px editor fits, but its bottom initially sits 8px under the pane.
  // Keep that initial scroll position; keyboard entry must reveal the whole ring.
  await page.setViewportSize({ width, height: 900 });
  await check(page.locator('#memory-editor'), 'memory-editor', ['memory-content', 'memory-viewer']);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'document has no horizontal overflow');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.info('Focus clipping observations:', JSON.stringify({ width, theme, controls: observations.length, observations }));
}
