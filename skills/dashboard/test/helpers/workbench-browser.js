import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendHtml, sendJson, serveStatic } from '../../src/lib/http.js';
import { GROUP, GROUP_FILE, LONG_FILE, workbenchAnswer } from '../fixtures/workbench-browser-api.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const PAGES = ['/', '/index.html', '/memory', '/schedule', '/usage', '/settings'];
// Share of the memory page (the screen under the app header and page tabs) that an open file's text fills on a
// 390x844 phone. Measured 0.84, also with a wider font that wraps the app header onto two rows; putting the back
// button on a row of its own above the file name brings it to 0.77-0.78.
const MEMORY_SHARE = 0.81;

// The real page, stylesheets and modules, served the way the dashboard serves them, with fixed API answers
// (fixtures/workbench-browser-api.js). Dashboard actions are recorded and answered as done; nothing runs.
export async function startPage(sandbox) {
  const actions = [], unserved = new Set(), reads = new Map();
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
        if (req.method === 'GET') reads.set(url.pathname, (reads.get(url.pathname) ?? 0) + 1);
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
  return { base, actions, unserved, reads };
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
  // The memory page starts under the app header and page tabs. Their height follows the fonts the machine has
  // (a wider fallback font wraps the header), so the file screen is measured from the top of the memory page.
  const memoryPage = visible(document.querySelector('#tab-memory'));
  const kpi = [...document.querySelectorAll('.wb-sched-kpi .wb-sched-kpi-item')].map(item => visible(item)).filter(Boolean).map(item => Math.round(item.top));
  return {
    // Compared with the screen width the case set: a phone browser widens its layout viewport to fit content.
    small, documentWidth: document.documentElement.scrollWidth, scrollY,
    memoryShare: content && memoryPage ? (Math.min(innerHeight, content.bottom) - Math.max(memoryPage.top, content.top)) / (innerHeight - memoryPage.top) : null,
    memoryPageTop: memoryPage && Math.round(memoryPage.top),
    kpiRows: [...new Set(kpi)].map(top => kpi.filter(value => value === top).length),
    title: box('.wb-d-top .wb-d-title'), state: box('.wb-d-top .wb-d-sub > :first-child'), actions: box('.wb-d-top .wb-d-acts'), icon: box('.wb-d-top > .wb-ch'),
    // Button labels a person sees but that are cut short (ellipsis): none may be.
    clippedLabels: [...document.querySelectorAll('.wb-d-top .wb-d-acts > button span')].filter(span => visible(span) && span.scrollWidth > span.clientWidth + 1).map(span => span.textContent).slice(0, 5),
    // Segmented-control options whose words do not fit inside the option or its control (cut or spilling).
    clippedSegments: [...document.querySelectorAll('.wb-seg > button, .wb-seg2 > button, .wb-seg-sm > button')].filter(option => {
      const box = visible(option);
      if (!box) return false;
      const range = document.createRange(); range.selectNodeContents(option);
      const words = range.getBoundingClientRect(), control = option.parentElement.getBoundingClientRect();
      return option.scrollWidth > option.clientWidth + 1 || (words.width > 0 && (words.left < Math.max(box.left, control.left) - 0.5 || words.right > Math.min(box.right, control.right) + 0.5));
    }).map(option => option.textContent.trim()).slice(0, 5),
    titleClipped: (title => Boolean(title) && (title.scrollHeight > title.clientHeight + 1 || title.scrollWidth > title.clientWidth + 1))(document.querySelector('.wb-d-top .wb-d-title')),
    actionButtons: [...document.querySelectorAll('.wb-d-top .wb-d-acts > button')].map(button => { const b = visible(button); return b && { action: button.dataset.action ?? button.dataset.wbAction, top: b.top, bottom: b.bottom, left: b.left, right: b.right }; }).filter(Boolean),
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
  const { base, actions, unserved, reads } = await startPage(sandbox);
  const { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());

  // Pages a step opened are closed when the step ends, also when it fails: a failed step must not leave pages
  // holding the browser's shared memory, which would fail the steps after it for an unrelated reason.
  const live = new Set();
  const step = (name, fn) => t.test(name, async () => {
    try { await fn(); } finally { await Promise.all([...live].map(context => context.close().catch(() => {}))); }
  });

  // `language` is set before every load of the page, so a reload keeps it.
  async function open(width, height, route, options = {}, language = 'zh') {
    const phone = width < 761;
    const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', timezoneId: 'UTC',
      ...(phone ? { isMobile: true, hasTouch: true } : {}), ...options });
    live.add(context);
    context.on('close', () => live.delete(context));
    sandbox.addCleanup(() => context.close());
    await context.route('**/*', request => request.request().url().startsWith(base + '/') ? request.continue() : request.abort());
    await context.addInitScript(locale => {
      try { localStorage.setItem('zylos-dashboard-locale', locale); localStorage.setItem('zylos-dashboard-detail-level', 'plain'); } catch {}
    }, language);
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

  // The phone settings drawer, as the page reports it: open or not, where it sits, what has focus, which
  // history entry is current and what is inert.
  const drawerState = page => page.evaluate(() => {
    const nav = document.querySelector('.wb-set-nav'), toggle = document.querySelector('.wb-set-drawer-btn');
    const focus = document.activeElement;
    return {
      open: document.querySelector('.wb-set').classList.contains('wb-set-drawer-open'),
      expanded: toggle.getAttribute('aria-expanded'),
      left: Math.round(nav.getBoundingClientRect().left), height: Math.round(nav.getBoundingClientRect().height),
      visible: getComputedStyle(nav).visibility === 'visible' && getComputedStyle(nav).display !== 'none',
      focus: focus === toggle ? 'toggle' : focus?.dataset?.settingsSection ? 'section:' + focus.dataset.settingsSection
        : focus && nav.contains(focus) ? 'drawer' : focus === document.body || !focus ? 'body' : 'outside:' + (focus.id || focus.className),
      current: nav.querySelector('[aria-current="true"]')?.dataset.settingsSection,
      label: toggle.textContent.trim(),
      entry: Boolean(history.state?.settingsDrawer), path: location.pathname,
      inert: document.querySelectorAll('[inert]').length,
      bodyInert: Boolean(document.querySelector('.wb-set-body').closest('[inert]')), headerInert: Boolean(document.querySelector('.app-header').closest('[inert]')),
      settingsShown: !document.querySelector('#tab-settings').hidden,
    };
  });
  async function openDrawer(page) {
    await page.locator('.wb-set-drawer-btn').click();
    await page.waitForFunction(() => history.state?.settingsDrawer && document.querySelector('.wb-set-nav').getBoundingClientRect().left === 0);
  }
  // Closed and settled: no drawer entry left in history once the drawer has removed it.
  async function closed(page) {
    await page.waitForFunction(() => !document.querySelector('.wb-set').classList.contains('wb-set-drawer-open') && !history.state?.settingsDrawer);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.wb-set-nav')).visibility === 'hidden' || innerWidth > 760);
    return drawerState(page);
  }

  // Straight after a close: the drawer is shut and its entry gone, said plainly within two seconds rather than
  // left to a long wait for later state.
  async function closedNow(page, what) {
    await page.waitForFunction(() => !document.querySelector('.wb-set').classList.contains('wb-set-drawer-open') && !history.state?.settingsDrawer, null, { timeout: 2000 }).catch(() => {});
    const state = await drawerState(page);
    assert.deepEqual([state.open, state.entry], [false, false], `${what}: the drawer closes and leaves no history entry`);
  }

  async function settings(width, height) {
    const { page, context, errors, shot } = await open(width, height, '/settings');
    const upgrade = () => page.locator('#tab-settings [data-action="upgrade-cc"]');
    await upgrade().waitFor({ state: 'attached' });
    // The upgrade button sits with the versions, in whichever section holds them.
    const section = await upgrade().evaluate(node => node.closest('section.wb-set-sec')?.id.replace('settings-section-', ''));
    // Phones reach the sections through the drawer.
    const pick = async name => { if (width < 761) await openDrawer(page); await page.locator(`[data-settings-section="${name}"]`).click(); if (width < 761) await closed(page); };
    await pick(section);
    await upgrade().waitFor({ state: 'visible' });
    await confirmFlow(page, upgrade, 'upgrade-cc', {});
    await pick('defaults');
    const single = () => page.locator('#action-mode-seg button[data-mode="single"]');
    await single().waitFor({ state: 'visible' });
    await confirmFlow(page, single, 'switch-mode', { mode: 'single' });
    if (width < 761) {
      const layout = await page.evaluate(measure);
      assert.deepEqual(layout.small, [], `settings at ${width}: no control under 40px`);
      assert.equal(layout.documentWidth, width, `settings at ${width}: no sideways scrolling`);
    } else {
      // Wider screens keep the section list as a sidebar; the drawer's button, title and backdrop do not show.
      const desk = await page.evaluate(() => ({
        hidden: ['.wb-set-drawer-btn', '.wb-set-drawer-h', '.wb-set-scrim'].filter(selector => getComputedStyle(document.querySelector(selector)).display === 'none'),
        nav: (box => ({ left: Math.round(box.left), width: Math.round(box.width) }))(document.querySelector('.wb-set-nav').getBoundingClientRect()),
        visible: getComputedStyle(document.querySelector('.wb-set-nav')).visibility,
      }));
      assert.deepEqual(desk, { hidden: ['.wb-set-drawer-btn', '.wb-set-drawer-h', '.wb-set-scrim'], nav: { left: 0, width: 209 }, visible: 'visible' });
    }
    await shot('settings');
    assert.deepEqual(errors, []);
    await context.close();
  }

  await step('asking before upgrading the CLI or switching the session mode, on a phone and a desktop screen', async () => {
    await settings(390, 844);
    await settings(1280, 800);
  });

  await step('phone pages: 40px controls, no sideways scrolling, two-row detail header, memory list and file screens, schedule numbers 3+3', async () => {
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
    assert.ok(file.memoryShare >= MEMORY_SHARE, `the file text fills at least ${MEMORY_SHARE * 100}% of the screen under the app header (was ${file.memoryShare.toFixed(3)}, page top ${file.memoryPageTop})`);
    assert.ok(await page.locator('#memory-tree').evaluate(node => node.getBoundingClientRect().height === 0 || getComputedStyle(node).display === 'none'), 'the list is not on the file screen');

    // Overview and group detail: icon, name and state share the first row; the actions are the second row, starting
    // at the icon's left edge, one row of equal-height buttons with the conversation first.
    await page.locator('.tab[data-tab="overview"]').click();
    await page.locator('#wb-board .wb-row').first().waitFor();
    await check('overview');
    await page.locator('#wb-board .wb-row', { hasText: 'Telegram direct chat' }).click();
    await page.locator('.wb-d-top .wb-d-sub').waitFor();
    // The long-named group: its name has the first row (up to two lines) and is not cut; the state leads the
    // second row from the icon's edge, then the actions, none of whose labels are cut.
    const phoneHeader = (detail, language) => {
      assert.equal(detail.titleClipped, false, `${language}: the whole name is shown`);
      assert.ok(detail.state.top >= detail.title.bottom - 1, `${language}: the state is under the name`);
      assert.ok(Math.abs(detail.state.left - detail.icon.left) <= 1, `${language}: the state starts at the icon's edge (${detail.state.left} vs ${detail.icon.left})`);
      assert.ok(detail.actions.left >= detail.state.right - 1 || detail.actions.top >= detail.state.bottom - 1, `${language}: the actions follow the state, beside it or under it`);
      const buttons = detail.actionButtons;
      assert.equal(buttons[0]?.action, 'viewConversation', `${language}: opening the conversation leads the actions`);
      assert.equal(new Set(buttons.map(button => Math.round(button.top))).size, 1, `${language}: the actions stay on one row`);
      assert.equal(new Set(buttons.map(button => Math.round(button.bottom - button.top))).size, 1, `${language}: the actions share one height`);
      assert.ok(buttons.at(-1).right <= detail.documentWidth, `${language}: the action row fits the screen`);
      assert.deepEqual(detail.clippedLabels, [], `${language}: no button label is cut`);
    };
    phoneHeader(await check('detail'), 'Chinese');

    // From the group detail into this group's memory: the list of the group's files, not the file left open.
    await page.locator('.wb-detail-memory .wb-link-btn').click();
    await page.locator('#tab-memory').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#tab-memory.memory-file-open').count(), 0, 'the group memory opens on its file list');
    await page.locator(`#memory-tree .memory-file`).first().waitFor({ state: 'visible' });
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

    // The same screens in English, whose labels are longer: the page is loaded in English from the start.
    const english = await open(390, 844, '/', {}, 'en');
    const checkEnglish = async name => {
      const layout = await english.page.evaluate(measure);
      assert.equal(await english.page.evaluate(() => document.documentElement.lang), 'en', `${name}: the page is in English`);
      assert.deepEqual(layout.small, [], `${name}: no control under 40px`);
      assert.equal(layout.documentWidth, 390, `${name}: no sideways scrolling`);
      assert.deepEqual(layout.clippedSegments, [], `${name}: no segmented option is cut`);
      await english.shot(name);
      return layout;
    };
    await english.page.locator('#wb-board .wb-row', { hasText: 'Telegram direct chat' }).click();
    await english.page.locator('.wb-d-top .wb-d-sub').waitFor();
    phoneHeader(await checkEnglish('detail-english'), 'English');
    await english.page.keyboard.press('Escape');
    await english.page.locator('.tab[data-tab="trends"]').click();
    await english.page.locator('#wb-usage-range > button').first().waitFor();
    assert.equal((await english.page.locator('#wb-usage-range > button').allTextContents()).length, 5, 'four ranges and the custom dates');
    await checkEnglish('usage-english');
    await english.page.locator('.tab[data-tab="memory"]').click();
    await english.page.locator('#memory-tree .memory-file').first().waitFor();
    await checkEnglish('memory-english');
    assert.deepEqual(english.errors, []);
    await english.context.close();
  });

  // A phone on its side keeps the phone layout with a screen shorter than the memory loading view, so opening a
  // file from further down the list must bring the window back to the top: the back button and the file name
  // are on screen.
  await step('memory on a phone on its side: an opened file starts at the top', async () => {
    for (const [width, height] of [[667, 375], [568, 320]]) {
      const { page, context, errors } = await open(width, height, '/memory');
      await page.locator('#memory-tree .memory-file').first().waitFor();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      assert.ok(await page.evaluate(() => scrollY) > height, `${width}x${height}: the file list is taller than the screen`);
      await page.locator(`#memory-tree .memory-file[data-path="${LONG_FILE}"], #memory-tree .memory-file:has-text("${LONG_FILE}")`).first().evaluate(node => node.click());
      await page.locator('#tab-memory.memory-file-open').waitFor();
      await page.waitForFunction(() => document.querySelector('#memory-content')?.textContent.includes('Week 10'));
      const top = await page.evaluate(() => {
        const inView = selector => { const box = document.querySelector(selector).getBoundingClientRect(); return box.height > 0 && box.top >= 0 && box.bottom <= innerHeight; };
        return { scrollY, back: inView('#memory-back'), name: inView('#memory-file-title'), phone: (tree => tree.getBoundingClientRect().height === 0 || getComputedStyle(tree).display === 'none')(document.querySelector('#memory-tree')) };
      });
      assert.deepEqual(top, { scrollY: 0, back: true, name: true, phone: true }, `${width}x${height}: the open file starts at the top`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  });

  // Every way of closing the phone drawer: a section, the same section, the backdrop, Escape, the close button
  // and Back. Each one returns focus to the button, lifts the inert background and leaves no drawer entry in
  // history; Back closes the drawer without reloading settings and one more Back leaves settings.
  await step('phone settings drawer: opening, every way of closing, focus and history', async () => {
    const { page, context, errors, shot } = await open(390, 844, '/');
    await page.locator('#wb-board .wb-row').first().waitFor();
    // Arrive from the overview so one Back too many would show up as leaving settings.
    await page.locator('#wb-settings-btn').click();
    await page.locator('.wb-set-drawer-btn').waitFor({ state: 'visible' });
    const label = name => page.locator(`[data-settings-section="${name}"] > span`).first().textContent();
    let state = await drawerState(page);
    assert.deepEqual([state.open, state.expanded, state.visible, state.inert], [false, 'false', false, 0]);
    assert.ok(state.left < -100, `closed: the drawer is off screen (${state.left})`);
    assert.equal(state.label, await label('defaults'), 'the button names the current section');
    assert.match(await page.locator('.wb-set-nav').evaluate(node => getComputedStyle(node).transitionDuration), /0\.2s/, 'the drawer slides');
    await shot('settings-drawer-closed');
    const settingsReads = () => reads.get('/api/settings') ?? 0;
    const readsBefore = settingsReads();

    await openDrawer(page);
    state = await drawerState(page);
    assert.deepEqual([state.open, state.expanded, state.left, state.visible, state.focus, state.current], [true, 'true', 0, true, 'section:defaults', 'defaults']);
    assert.equal(state.height, 844, 'the drawer runs the full height of the screen');
    // The prototype's sizes: 300px drawer, 44px section rows and opening button, 40×40 close button.
    const sizes = await page.evaluate(() => Object.fromEntries([['drawer', '.wb-set-nav'], ['section', '[data-settings-section="defaults"]'], ['button', '.wb-set-drawer-btn'], ['close', '.wb-set-drawer-x']]
      .map(([name, selector]) => { const box = document.querySelector(selector).getBoundingClientRect(); return [name, [Math.round(box.width), Math.round(box.height)]]; })));
    assert.deepEqual([sizes.drawer[0], sizes.section[1], sizes.button[1], sizes.close], [300, 44, 44, [40, 40]], JSON.stringify(sizes));
    assert.ok(state.entry && state.bodyInert && state.headerInert, 'one history entry; the page behind the drawer is inert');
    const layout = await page.evaluate(measure);
    assert.deepEqual(layout.small, [], 'drawer: no control under 40px');
    assert.equal(layout.documentWidth, 390, 'drawer: no sideways scrolling');
    await shot('settings-drawer-open');
    // Keyboard focus cannot reach the page behind the backdrop, either way round.
    for (const key of ['Tab', 'Shift+Tab']) {
      for (let i = 1; i <= 10; i++) {
        await page.keyboard.press(key);
        const focus = (await drawerState(page)).focus;
        assert.ok(!focus.startsWith('outside:'), `${key} ${i}: focus stays in the drawer (${focus})`);
      }
    }

    const ways = [
      ['a section', async () => page.locator('[data-settings-section="keys"]').click(), 'keys'],
      ['the same section', async () => page.locator('[data-settings-section="keys"]').click(), 'keys'],
      ['the backdrop', async () => page.locator('.wb-set-scrim').click({ position: { x: 360, y: 420 } }), 'keys'],
      ['Escape', async () => page.keyboard.press('Escape'), 'keys'],
      ['the close button', async () => page.locator('.wb-set-drawer-x').click(), 'keys'],
      ['Back', async () => page.goBack(), 'keys'],
    ];
    // The drawer is still open from the keyboard checks above; each later way opens it again first.
    for (const [index, [way, close, section]] of ways.entries()) {
      if (index) {
        await openDrawer(page);
        assert.equal((await drawerState(page)).focus, 'section:' + section, `${way}: focus starts on the current section`);
      }
      await close();
      await closedNow(page, `closing with ${way}`);
      state = await closed(page);
      assert.equal(settingsReads(), readsBefore, `closing with ${way}: settings is not read again`);
      assert.deepEqual([state.expanded, state.inert, state.focus, state.current, state.path, state.settingsShown], ['false', 0, 'toggle', section, '/settings', true], `closing with ${way}`);
      assert.equal(state.label, await label(section), `${way}: the button names the section`);
    }
    assert.equal(settingsReads(), readsBefore, 'opening and closing the drawer never reloaded settings');

    // No drawer entry left behind: one Back leaves settings for the overview.
    await page.goBack();
    await page.waitForFunction(() => location.pathname === '/' && !document.querySelector('#tab-overview').hidden);
    // Forward again, then forward onto the drawer's old entry: settings stays as it is with the drawer closed.
    await page.goForward();
    await page.waitForFunction(() => location.pathname === '/settings' && !document.querySelector('#tab-settings').hidden);
    await page.waitForTimeout(200);
    const readsForward = settingsReads();
    await page.goForward();
    await page.waitForFunction(() => history.state?.settingsDrawer);
    await page.waitForTimeout(200);
    state = await drawerState(page);
    assert.deepEqual([state.open, state.settingsShown, state.path], [false, true, '/settings'], 'forward onto the old drawer entry keeps settings with the drawer closed');
    assert.equal(settingsReads(), readsForward, 'and does not reload settings');
    assert.deepEqual(errors, []);
    await context.close();
  });

  // Closing the drawer in the page leaves its old entry on the browser's forward side (the Forward button, or the
  // right-edge swipe on an iPhone). Forward onto it and Back off it again are both the same settings page: an
  // unsaved price stays, settings is not read again, and one more Back leaves settings.
  await step('phone settings drawer: Forward onto its old entry and Back again keep unsaved edits', async () => {
    const { page, context, errors } = await open(390, 844, '/');
    await page.locator('#wb-board .wb-row').first().waitFor();
    await page.locator('#wb-settings-btn').click();
    await page.locator('.wb-set-drawer-btn').waitFor({ state: 'visible' });
    await openDrawer(page);
    await page.locator('[data-settings-section="pricing"]').click();
    await closed(page);
    // An unsaved pricing edit: the fast-mode price multiplier.
    const price = page.locator('#settings-fast-multiplier');
    await price.waitFor({ state: 'visible' });
    await price.fill('99');
    const edit = () => page.evaluate(() => {
      const input = document.querySelector('#settings-fast-multiplier'), bar = document.querySelector('.settings-footer');
      return { value: input.value, dirty: input.classList.contains('wb-dirty-in'), saveBar: Boolean(bar && !bar.hidden) };
    });
    assert.deepEqual(await edit(), { value: '99', dirty: true, saveBar: true }, 'the edit shows as unsaved');
    await openDrawer(page);
    await page.locator('.wb-set-drawer-x').click();
    await closed(page);
    const settingsReads = () => (reads.get('/api/settings') ?? 0) + (reads.get('/api/keys') ?? 0);
    const before = settingsReads();

    await page.goForward();
    await page.waitForFunction(() => history.state?.settingsDrawer, null, { timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(300);
    let state = await drawerState(page);
    assert.deepEqual([state.entry, state.open, state.settingsShown, state.path], [true, false, true, '/settings'], 'Forward onto the old entry: settings with the drawer closed');
    assert.deepEqual(await edit(), { value: '99', dirty: true, saveBar: true }, 'Forward keeps the unsaved edit');

    await page.goBack();
    await page.waitForFunction(() => !history.state?.settingsDrawer, null, { timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(400);
    state = await drawerState(page);
    assert.deepEqual([state.entry, state.open, state.settingsShown, state.path], [false, false, true, '/settings'], 'Back off the old entry: still settings');
    assert.deepEqual(await edit(), { value: '99', dirty: true, saveBar: true }, 'Back off the old entry keeps the unsaved edit');
    assert.equal(settingsReads(), before, 'Forward and Back over the old entry never read settings again');

    await page.goBack();
    await page.waitForFunction(() => location.pathname === '/' && !document.querySelector('#tab-overview').hidden, null, { timeout: 3000 }).catch(() => {});
    assert.deepEqual(await page.evaluate(() => [location.pathname, !document.querySelector('#tab-overview').hidden]), ['/', true], 'one more Back returns to the overview');
    assert.deepEqual(errors, []);
    await context.close();
  });

  await step('phone settings drawer: switching page or leaving the phone layout closes it and removes its history entry', async () => {
    const start = async () => {
      const opened = await open(390, 844, '/');
      await opened.page.locator('#wb-board .wb-row').first().waitFor();
      await opened.page.locator('#wb-settings-btn').click();
      await opened.page.locator('.wb-set-drawer-btn').waitFor({ state: 'visible' });
      return opened;
    };
    // Another page while the drawer is open (the page itself is inert, so this is the page's own navigation).
    let { page, context, errors } = await start();
    const length = await page.evaluate(() => history.length);
    await openDrawer(page);
    await page.evaluate(() => document.querySelector('.tab[data-tab="memory"]').click());
    await page.waitForFunction(() => location.pathname === '/memory' && !document.querySelector('#tab-memory').hidden);
    let state = await drawerState(page);
    assert.deepEqual([state.open, state.inert, state.entry], [false, 0, false], 'switching page closes the drawer and lifts the inert background');
    assert.equal(await page.evaluate(() => history.length), length + 1, 'the drawer entry became the new page entry');
    await page.goBack();
    await page.waitForFunction(() => location.pathname === '/settings' && !document.querySelector('#tab-settings').hidden);
    state = await drawerState(page);
    assert.deepEqual([state.open, state.entry], [false, false], 'Back returns to settings, not to an open drawer');
    await page.goBack();
    await page.waitForFunction(() => location.pathname === '/');
    assert.deepEqual(errors, []);
    await context.close();

    // Turning or widening the screen past the phone layout while the drawer is open.
    ({ page, context, errors } = await start());
    await openDrawer(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    state = await closed(page);
    assert.deepEqual([state.open, state.expanded, state.inert, state.entry, state.left, state.visible], [false, 'false', 0, false, 0, true], 'wider screen: drawer closed, sidebar shown, entry removed');
    assert.ok(await page.locator('.wb-set-drawer-btn').isHidden(), 'wider screen: no drawer button');
    await page.goBack();
    await page.waitForFunction(() => location.pathname === '/', null, { timeout: 5000 });
    assert.deepEqual(errors, []);
    await context.close();
  });

  await step('phone settings drawer: no sliding when the system asks for reduced motion', async () => {
    const { page, context, errors } = await open(390, 844, '/settings', { reducedMotion: 'reduce' });
    await page.locator('.wb-set-drawer-btn').waitFor({ state: 'visible' });
    const durations = () => page.evaluate(() => ['.wb-set-nav', '.wb-set-scrim'].map(selector => getComputedStyle(document.querySelector(selector)).transitionDuration));
    assert.deepEqual(await durations(), ['0s', '0s']);
    // Without the slide the drawer is in place as soon as it has opened (with it, it would still be on its way in).
    const opened = await page.evaluate(() => { document.querySelector('.wb-set-drawer-btn').click(); return Math.round(document.querySelector('.wb-set-nav').getBoundingClientRect().left); });
    assert.equal(opened, 0);
    assert.deepEqual(await durations(), ['0s', '0s'], 'open as well as closed');
    assert.deepEqual(errors, []);
    await context.close();
  });

  await step('a desktop screen keeps the name and state on one row, with the actions under them', async () => {
    const { page, context, errors } = await open(1280, 800, '/');
    await page.locator('#wb-board .wb-row', { hasText: 'Telegram direct chat' }).click();
    await page.locator('.wb-d-top .wb-d-sub').waitFor({ state: 'attached' });
    const detail = await page.evaluate(measure);
    assert.ok(detail.state.top < detail.title.bottom && detail.state.bottom > detail.title.top, 'the state sits beside the title');
    assert.ok(detail.actions.top >= detail.title.bottom - 1 && Math.abs(detail.actions.left - detail.icon.left) <= 1, 'the actions start under the icon');
    assert.equal(detail.actionButtons[0]?.action, 'viewConversation');
    assert.ok(detail.actionButtons.every(button => Math.round(button.top) === Math.round(detail.actionButtons[0].top)), 'one row of actions');
    assert.equal(detail.documentWidth, 1280);
    assert.deepEqual(errors, []);
    await context.close();
  });

  // The busy group's run holds 600 router `release` diagnostics between a few events a person can follow
  // (fixtures/workbench-browser-api.js). Plain view lists only those events, newest first, in recent activity
  // and on the timeline; technical detail shows the diagnostics as one row with their count.
  await step('group timeline: plain events newest first, repeated diagnostics one row in technical detail', async () => {
    const plain = ['完成一轮', '工具使用完成', '开始使用工具', '收到任务', '会话开始'];
    for (const [width, height] of [[390, 844], [1280, 800]]) {
      const { page, context, errors, shot } = await open(width, height, '/');
      const labels = selector => page.locator(selector).evaluateAll(nodes => nodes.map(node => node.firstChild?.textContent ?? node.textContent));
      await page.locator('#wb-board .wb-row', { hasText: 'Telegram direct chat' }).click();
      await page.locator('.wb-detail-recent .wb-ev').first().waitFor();
      assert.deepEqual(await labels('.wb-detail-recent .wb-ev-t'), plain, `${width}: recent activity is the plain events, newest first`);
      await page.locator('#wb-side [role="tab"]', { hasText: '时间线' }).click();
      await page.locator('.wb-timeline-event').first().waitFor();
      assert.deepEqual(await labels('.wb-timeline-event .wb-ev-t'), plain, `${width}: the timeline lists the plain events, newest first`);
      assert.doesNotMatch(await page.locator('#wb-side').textContent(), /后台记录|release/);
      let layout = await page.evaluate(measure);
      assert.equal(layout.documentWidth, width, `${width}: no sideways scrolling`);
      if (width < 761) assert.deepEqual(layout.small, [], 'no control under 40px');
      await shot('timeline-plain');

      // The phone detail covers the header, so the technical detail switch is pressed from the page.
      await page.locator('#wb-tech-btn').evaluate(node => node.click());
      await page.locator('.wb-timeline-event.wb-ev-merged').waitFor();
      // Technical rows keep the readable label and add the recorded event code after it.
      const rows = await labels('.wb-timeline-event .wb-ev-t');
      assert.deepEqual(rows, ['完成一轮', '后台记录', '工具使用完成', '开始使用工具', '收到任务', '会话开始'],
        `${width}: technical detail adds the 600 releases as one row, in time order`);
      assert.deepEqual(await page.locator('.wb-timeline-event .wb-ev-code').allTextContents(),
        ['stop', 'release', 'post_tool_use', 'pre_tool_use', 'user_prompt_submit', 'session_start'], `${width}: each technical row names its event code`);
      assert.match(await page.locator('.wb-timeline-event.wb-ev-merged .wb-ev-rep').textContent(), /^600 次 · \d\d:\d\d – \d\d:\d\d$/);
      layout = await page.evaluate(measure);
      assert.equal(layout.documentWidth, width, `${width}: no sideways scrolling in technical detail`);
      await shot('timeline-technical');
      assert.deepEqual(errors, []);
      await context.close();
    }
  });

  await step('the nav marks the current page for screen readers, and the usage page starts with its controls', async () => {
    for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
      const { page, context, errors, shot } = await open(width, width === 390 ? 844 : 900, '/');
      if (theme === 'dark') { await page.evaluate(() => localStorage.setItem('zylos-dashboard-theme', 'dark')); await page.reload(); }
      const current = () => page.evaluate(() => [...document.querySelectorAll('.app-header .tab[aria-current]')]
        .map(tab => `${tab.dataset.tab}=${tab.getAttribute('aria-current')}`));
      await page.locator('#wb-board .wb-row').first().waitFor();
      assert.deepEqual(await current(), ['overview=page'], `${width}: overview is current`);
      await page.locator('.tab[data-tab="trends"]').click();
      await page.locator('#wb-usage-range > button').first().waitFor();
      assert.deepEqual(await current(), ['trends=page'], `${width}: usage is current`);
      const top = await page.evaluate(() => {
        const usage = document.querySelector('.wb-usage-page');
        return { headings: usage.querySelectorAll('h1, h2').length, first: usage.firstElementChild.className,
          gap: Math.round(usage.querySelector('.wb-usage-controls').getBoundingClientRect().top - document.querySelector('.app-header').getBoundingClientRect().bottom) };
      });
      assert.equal(top.headings, 0, `${width}: no page heading repeats the nav`);
      assert.match(top.first, /wb-usage-controls/);
      assert.ok(top.gap >= 8 && top.gap <= 40, `${width}: the controls sit just under the header (${top.gap}px)`);
      await shot(`usage-top-${theme}`);
      await page.locator('#wb-settings-btn').click();
      await page.locator('#tab-settings.active').waitFor();
      assert.deepEqual(await current(), ['settings=page'], `${width}: settings is current`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  });

  // The header: the title in the theme's brand colour, then the instance name and the instance's own Core version
  // (fixtures/workbench-browser-api.js reports zylos 0.9.4) as grey small text. Phones hide both.
  await step('header: brand-coloured title and the Core version after the instance name, hidden on phones', async () => {
    for (const width of [1280, 390]) for (const [theme, accent] of [['light', 'rgb(13, 148, 136)'], ['dark', 'rgb(67, 199, 181)']]) {
      const { page, context, errors, shot } = await open(width, width === 390 ? 844 : 800, '/');
      if (theme === 'dark') { await page.evaluate(() => localStorage.setItem('zylos-dashboard-theme', 'dark')); await page.reload(); }
      await page.locator('#tab-bar-core-version').waitFor({ state: 'attached' });
      await page.waitForFunction(() => document.querySelector('#tab-bar-core-version').textContent !== '');
      const header = await page.evaluate(() => {
        const look = node => { const style = getComputedStyle(node), box = node.getBoundingClientRect();
          return { color: style.color, size: style.fontSize, shown: style.display !== 'none' && box.width > 0 }; };
        const version = document.querySelector('#tab-bar-core-version');
        return { brand: look(document.querySelector('.app-header .brand')), name: look(document.querySelector('#tab-bar-agent-name')),
          version: look(version), text: version.textContent, scroll: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(header.brand.color, accent, `${width} ${theme}: the title takes the brand colour`);
      assert.equal(header.text, 'v0.9.4', `${width} ${theme}: the instance's Core version`);
      assert.equal(header.version.shown, width > 760, `${width} ${theme}: shown on wide screens, hidden on phones`);
      assert.equal(header.name.shown, width > 760, `${width} ${theme}: the instance name follows the same rule`);
      if (width > 760) assert.deepEqual([header.version.color, header.version.size], [header.name.color, header.name.size], 'styled like the instance name');
      assert.equal(header.scroll, false, `${width} ${theme}: no sideways scrolling`);
      await shot(`header-${theme}`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  });

  // Unanswered reads are listed so a page change that needs a new answer is visible, not silently empty.
  if (unserved.size) console.log('Workbench browser case left unanswered:', [...unserved].sort().join(', '));
}
