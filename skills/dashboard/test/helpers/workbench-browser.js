import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendHtml, sendJson, serveStatic } from '../../src/lib/http.js';
import { GROUP, GROUP_FILE, LONG_FILE, workbenchAnswer } from '../fixtures/workbench-browser-api.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const PAGES = ['/', '/index.html', '/memory', '/schedule', '/usage', '/settings'];

// The real page, stylesheets and modules, served the way the dashboard serves them, with fixed API answers
// (fixtures/workbench-browser-api.js). Dashboard actions are recorded and answered as done; nothing runs.
async function startPage(sandbox) {
  const actions = [], unserved = new Set();
  const now = Date.now();
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/actions/') && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
        req.on('end', () => {
          actions.push({ action: url.pathname.slice('/api/actions/'.length), body: body ? JSON.parse(body) : null });
          sendJson(res, 200, { ok: true });
        });
        return;
      }
      if (url.pathname === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return; }
      if (url.pathname.startsWith('/api/')) {
        const value = req.method === 'GET' ? workbenchAnswer(url, now) : undefined;
        if (value === undefined) unserved.add(`${req.method} ${url.pathname}`);
        sendJson(res, value === undefined ? 404 : 200, value ?? { error: 'not_found' }); return;
      }
      if (PAGES.includes(url.pathname)) {
        sendHtml(res, 200, fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
          .replaceAll('__BASE_PATH__', '').replaceAll('__ASSET_ROOT__', '/_assets').replaceAll('__REMOTE_ACCESS__', 'admin')); return;
      }
      if (serveStatic(req, res, publicDir)) return;
      sendJson(res, 404, { error: 'not_found' });
    } catch (error) { sendJson(res, 500, { error: error.message }); }
  });
  const base = await sandbox.startHttp(server);
  return { base, actions, unserved };
}

// Tappable controls narrower or shorter than 40px, the document width, and where the
// rows this case checks sit on the screen. A checkbox or radio is measured by its label.
function measure() {
  const visible = node => {
    if (!node) return null;
    const box = node.getBoundingClientRect(), style = getComputedStyle(node);
    if (box.width <= 0 || box.height <= 0 || style.visibility === 'hidden' || style.display === 'none' || node.closest('[hidden]')) return null;
    return box;
  };
  const small = [], seen = new Set();
  for (const control of document.querySelectorAll('button, a[href], summary, select, input:not([type=hidden]), textarea, [role=button], [role=tab]')) {
    const target = control.matches('input[type=checkbox], input[type=radio]') ? control.closest('label') ?? control : control;
    if (seen.has(target) || target.matches('textarea, .wb-vh') || target.closest('[aria-hidden=true], #tab-chat')) continue;
    seen.add(target);
    const box = visible(target);
    if (box && (box.width < 40 || box.height < 40) && small.length < 10) {
      small.push(`${target.tagName.toLowerCase()}.${String(target.className).trim().split(/\s+/).join('.')} "${(target.getAttribute('aria-label') ?? target.textContent).trim().slice(0, 24)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
  }
  const box = selector => { const found = visible(document.querySelector(selector)); return found && { top: found.top, bottom: found.bottom, left: found.left, right: found.right }; };
  const content = visible(document.querySelector('#memory-content'));
  const kpi = [...document.querySelectorAll('.wb-sched-kpi .wb-sched-kpi-item')].map(item => visible(item)).filter(Boolean).map(item => Math.round(item.top));
  return {
    // Compared with the screen width the case set: a phone browser widens its layout viewport to fit content.
    small, documentWidth: document.documentElement.scrollWidth, scrollY,
    memoryShare: content ? (Math.min(innerHeight, content.bottom) - Math.max(0, content.top)) / innerHeight : null,
    kpiRows: [...new Set(kpi)].map(top => kpi.filter(value => value === top).length),
    title: box('.wb-d-top .wb-d-title'), state: box('.wb-d-top .wb-d-sub > :first-child'), actions: box('.wb-d-top .wb-d-acts'),
  };
}

// Real product entry, modules and stylesheets in a local browser; only the API answers are fixed.
export async function runWorkbenchBrowser(t, sandbox) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE, executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath), 'ZYLOS_CHAT_BROWSER_MODULE names the Playwright module');
  assert.ok(executablePath && fs.existsSync(executablePath), 'ZYLOS_CHAT_BROWSER_BIN names the browser');
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  console.log('Workbench browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const { base, actions, unserved } = await startPage(sandbox);
  const { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());

  async function open(width, height, route) {
    const phone = width < 761;
    const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', timezoneId: 'UTC',
      ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    sandbox.addCleanup(() => context.close());
    await context.route('**/*', request => request.request().url().startsWith(base + '/') ? request.continue() : request.abort());
    await context.addInitScript(() => {
      try { localStorage.setItem('zylos-dashboard-locale', 'zh'); localStorage.setItem('zylos-dashboard-detail-level', 'plain'); } catch {}
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
    await page.goto(base + route);
    return { page, context, errors, shot: async name => { if (evidence) await page.screenshot({ path: path.join(evidence, `${width}-${name}.png`) }); } };
  }

  // Asking before acting: each action that changes the running agent opens the in-page question; cancelling
  // sends nothing and confirming sends exactly one request.
  async function confirmFlow(page, button, action, body) {
    const sent = () => actions.filter(item => item.action === action);
    const before = sent().length;
    await button().click();
    const dialog = page.locator('.wb-modal[role="alertdialog"]');
    await dialog.waitFor();
    await dialog.locator('.wb-modal-acts button').first().click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForTimeout(300);
    assert.equal(sent().length, before, `${action}: cancelling sends nothing`);
    await button().click();
    await dialog.waitFor();
    await dialog.locator('.wb-modal-acts button').last().click();
    for (let i = 0; i < 50 && sent().length === before; i++) await page.waitForTimeout(100);
    await page.waitForTimeout(300);
    assert.equal(sent().length, before + 1, `${action}: confirming sends one request`);
    if (body) assert.deepEqual(sent().at(-1).body, body);
  }

  async function settings(width, height) {
    const { page, context, errors, shot } = await open(width, height, '/settings');
    const upgrade = () => page.locator('#tab-settings [data-action="upgrade-cc"]');
    await upgrade().waitFor({ state: 'attached' });
    // The upgrade button sits with the versions, in whichever section holds them.
    const section = await upgrade().evaluate(node => node.closest('section.wb-set-sec')?.id.replace('settings-section-', ''));
    await page.locator(`[data-settings-section="${section}"]`).click();
    await upgrade().waitFor({ state: 'visible' });
    await confirmFlow(page, upgrade, 'upgrade-cc', {});
    await page.locator('[data-settings-section="defaults"]').click();
    const single = () => page.locator('#action-mode-seg button[data-mode="single"]');
    await single().waitFor({ state: 'visible' });
    await confirmFlow(page, single, 'switch-mode', { mode: 'single' });
    if (width < 761) {
      const layout = await page.evaluate(measure);
      assert.deepEqual(layout.small, [], `settings at ${width}: no control under 40px`);
      assert.equal(layout.documentWidth, width, `settings at ${width}: no sideways scrolling`);
    }
    await shot('settings');
    assert.deepEqual(errors, []);
    await context.close();
  }

  await t.test('asking before upgrading the CLI or switching the session mode, on a phone and a desktop screen', async () => {
    await settings(390, 844);
    await settings(1280, 800);
  });

  await t.test('phone pages: 40px controls, no sideways scrolling, two-row detail header, memory list and file screens, schedule numbers 3+3', async () => {
    const { page, context, errors, shot } = await open(390, 844, '/memory');
    const check = async name => {
      const layout = await page.evaluate(measure);
      assert.deepEqual(layout.small, [], `${name}: no control under 40px`);
      assert.equal(layout.documentWidth, 390, `${name}: no sideways scrolling`);
      await shot(name);
      return layout;
    };
    // Memory: the list fills the screen; a file opened from further down starts at the top of its own screen.
    await page.locator('#memory-tree .memory-file').first().waitFor();
    await check('memory-list');
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    assert.ok(await page.evaluate(() => scrollY) > 100, 'the file list is taller than the screen');
    await page.locator(`#memory-tree .memory-file[data-path="${LONG_FILE}"], #memory-tree .memory-file:has-text("${LONG_FILE}")`).first().evaluate(node => node.click());
    await page.locator('#tab-memory.memory-file-open').waitFor();
    await page.waitForFunction(() => document.querySelector('#memory-content')?.textContent.includes('Week 10'));
    const file = await check('memory-file');
    assert.equal(file.scrollY, 0, 'the open file starts at the top');
    assert.ok(file.memoryShare >= 0.73, `the file text fills at least 73% of the first screen (was ${file.memoryShare.toFixed(3)})`);
    assert.ok(await page.locator('#memory-tree').evaluate(node => node.getBoundingClientRect().height === 0 || getComputedStyle(node).display === 'none'), 'the list is not on the file screen');

    // Overview and group detail: the title has the first row; state and actions start under the title text.
    await page.locator('.tab[data-tab="overview"]').click();
    await page.locator('#wb-board .wb-row').first().waitFor();
    await check('overview');
    await page.locator('#wb-board .wb-row', { hasText: 'Telegram direct chat' }).click();
    await page.locator('.wb-d-top .wb-d-sub').waitFor();
    const detail = await check('detail');
    assert.ok(detail.state.top >= detail.title.bottom - 1, 'the state is on the second row');
    assert.ok(Math.abs(detail.state.left - detail.title.left) <= 1, `the second row starts at the title text (${detail.state.left} vs ${detail.title.left})`);

    // From the group detail into this group's memory: the list of the group's files, not the file left open.
    await page.locator('.wb-detail-memory .wb-link-btn').click();
    await page.locator('#tab-memory').waitFor({ state: 'visible' });
    await page.locator(`#memory-tree .memory-file`).first().waitFor({ state: 'visible' });
    assert.equal(await page.locator('#tab-memory.memory-file-open').count(), 0, 'the group memory opens on its file list');
    const files = await page.locator('#memory-tree .memory-file').allTextContents();
    assert.ok(files.some(name => name.includes('handoff.md')) && !files.some(name => name.includes('note-01')), `only the group's files are listed (${files.length})`);
    assert.ok(GROUP_FILE.startsWith(`session-groups/${GROUP}/`));
    await shot('group-memory');

    // Schedule: six numbers in two rows of three; the next-day timeline stays inside the screen.
    await page.locator('.tab[data-tab="schedule"]').click();
    await page.locator('.wb-sched-row').first().waitFor();
    await page.locator('.wb-sched-kpi .wb-sched-kpi-item').first().waitFor();
    const sched = await check('schedule');
    assert.deepEqual(sched.kpiRows, [3, 3]);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await t.test('a desktop screen keeps the detail header on one row', async () => {
    const { page, context, errors } = await open(1280, 800, '/');
    await page.locator('#wb-board .wb-row', { hasText: 'Telegram direct chat' }).click();
    await page.locator('.wb-d-top .wb-d-sub').waitFor({ state: 'attached' });
    const detail = await page.evaluate(measure);
    assert.ok(detail.state.top < detail.title.bottom && detail.state.bottom > detail.title.top, 'the state sits beside the title');
    assert.equal(detail.documentWidth, 1280);
    assert.deepEqual(errors, []);
    await context.close();
  });

  // Unanswered reads are listed so a page change that needs a new answer is visible, not silently empty.
  if (unserved.size) console.log('Workbench browser case left unanswered:', [...unserved].sort().join(', '));
}
