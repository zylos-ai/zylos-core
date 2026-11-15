import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startPage } from './mobile-conversation-browser.js';
import { openMobileMore } from './browser-navigation.js';

// Measure the visible outer surface once: segmented tracks and search shells,
// never their inset options or borderless nested inputs. Geometry is read only.
// Card/list selection targets and timeline dots retain content-dependent geometry;
// their measured entries are not treated as field/button sizing peers.
export function measureControlRows() {
  const root = document.querySelector('.tab-content:not([hidden])') || document.body;
  const visible = el => { const b = el.getBoundingClientRect(), s = getComputedStyle(el); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden],[inert],[aria-hidden=true]') && s.clip === 'auto' && el.checkVisibility(); };
  const selector = '.wb-date,.wb-seg,.wb-seg2,.wb-seg-sm,.conversation-tabs,.wb-search,button,input:not([type=hidden]),select,textarea,summary,a[href]';
  const controls = [...document.querySelectorAll(selector)].filter(el => visible(el) && !el.parentElement.closest('.wb-seg,.wb-seg2,.wb-seg-sm,.conversation-tabs,.wb-search,.wb-date') && !el.matches('input[type=checkbox],input[type=radio]'));
  const identify = el => el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.classList.length ? '.' + [...el.classList].join('.') : '') + ':' + (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 48);
  // Literal contract values deliberately do not read CSS variables: an entire row
  // can agree with itself while drifting to the wrong size tier.
  const contract = el => {
    const mobile = innerWidth <= 760;
    if (el.matches('.wb-seg-engine') || (!mobile && el.matches('#settings-save-runtime,#settings-undo-runtime'))) return { heightException: 'natural two-line engine row' };
    if (el.matches('.conversation-running')) return { expectedHeight: mobile ? 22 : 30, heightException: mobile ? 'activity visible 22px / transparent hit target 44px' : undefined };
    if (el.closest('.conversation-compose-box')) return { heightException: 'composer retains its dedicated input/attachment/send dimensions' };
    if (el.closest('.q-card,.question-card,.chat-question')) return { heightException: 'question family has dedicated fields, chips and multiline options; question browser gate covers it' };
    if (el.matches('textarea')) return { heightException: 'multiline field grows with content' };
    if (mobile && el.matches('.wb-mobile-icon-button,.header-icon-btn,.wb-set-nav-btn,.wb-set-drawer-btn,.conversation-back,.conversation-menu-toggle,.wb-group-side-back')) return { expectedHeight: 44 };
    if (el.matches('.wb-sched-field .wb-input')) return { expectedHeight: 36 };
    if (el.matches('.wb-name-editor :is(input,select,button),.wb-cfg-controls :is(input,select,button),.wb-cfg-more :is(input,select,button)')) return { expectedHeight: mobile ? 36 : 26 };
    if (el.matches('.wb-group-head .wb-d-acts > *')) return { expectedHeight: mobile ? 36 : 30 };
    if (el.matches('.conversation-rename :is(input,button),.wb-timezone-controls :is(select,button),.wb-timezone-pending button')) return { expectedHeight: mobile ? 36 : 30 };
    if (el.matches('.wb-d-title-wrap > .wb-icon-btn-sm,.wb-set-body :is(.wb-btn,.wb-input,.wb-select),.wb-memory-search')) return { expectedHeight: mobile ? 36 : 30 };
    if (el.matches('.wb-btn-sm,.wb-icon-btn-sm,.wb-chip,.wb-seg-sm,#wb-auto-name') || el.matches('.wb-search:not(.wb-sched-filters .wb-search)')) return { expectedHeight: mobile ? 36 : 26 };
    if (el.matches('.wb-btn,.wb-icon-btn,.wb-input,.wb-select,.wb-date,.wb-seg,.wb-seg2,.conversation-tabs,.conversation-reload,.header-icon-btn,.wb-tech-btn,.wb-sched-filters .wb-search,.memory-refresh')) return { expectedHeight: mobile ? 36 : 30 };
    if (el.matches('.wb-sched-dot,.wb-sched-select,.wb-sched-target,.conversation-list-item,.conversation-delete,.memory-file,.wb-memory-group-h,.wb-memory-section-h,.wb-attention-item')) return { heightException: 'named content selection target retains its content or graphic geometry' };
    if (el.matches('.wb-switch-btn,input[type=range]')) return { heightException: 'switch or range retains its dedicated graphic and touch frame' };
    if (el.matches('.wb-mobile-tab,.wb-mobile-sheet-item,.wb-mobile-scrim,.wb-set-scrim,.conversation-menu-item,.conversation-menu-scrim,.wb-rt-tab,.wb-set-nav-btn,.wb-detail-tabs button,.app-header .tab')) return { heightException: 'dedicated navigation row or backdrop retains its own dimensions' };
    if (el.matches('summary,.wb-link-btn,a[href]')) return mobile && el.matches('summary,.wb-link-btn') ? { expectedHeight: 36 } : { heightException: 'inline disclosure or text link follows its content' };
    return {};

  };
  const all = controls.map((el, index) => { const b = el.getBoundingClientRect(); let owner = el.parentElement; while (owner.parentElement && owner !== root && !/flex|grid/.test(getComputedStyle(owner).display)) owner = owner.parentElement;
    owner = el.closest('#wb-board-head,.wb-usage-controls,.wb-sched-filters,.conversation-list-toolbar,.wb-timezone-controls,.wb-config-fields,.wb-pref-controls,.wb-d-top,.conversation-header,.wb-cfg-controls,.wb-cfg-more,.wb-name-editor,.wb-sched-pair') || owner;
    const contentTarget = el.matches('.wb-sched-dot,.wb-sched-select,.wb-sched-target,.conversation-list-item,.conversation-delete');
    return { ...contract(el), control: identify(el), owner: identify(owner) + (contentTarget ? ` / content target ${index}` : ''), height: b.height, center: b.y + b.height / 2,
      ...(() => {
        if (innerWidth > 760 || !el.matches('.conversation-running:is([data-state=busy], [data-state=idle])')) return {};
        const pseudo = getComputedStyle(el, '::after');
        const hitHeight = parseFloat(pseudo.height);
        const hitTop = b.top + parseFloat(getComputedStyle(el).borderTopWidth) + parseFloat(pseudo.top) + new DOMMatrix(pseudo.transform).m42;
        const hitCenter = hitTop + hitHeight / 2;
        const x = b.x + b.width / 2;
        const hits = [hitTop + 1, hitTop + hitHeight - 1].map(y => el.contains(document.elementFromPoint(x, y)));
        return { hitHeight, hitCenter, hitTop, hitBottom: hitTop + hitHeight, hitEdgesReachButton: hits.every(Boolean) };
      })(), top: b.y, left: b.x, right: b.right, bottom: b.bottom }; });
  const rows = [];
  for (const item of all) {
    let row = rows.find(row => row.owner === item.owner && Math.abs(row.anchor - item.center) <= Math.max(9, item.height / 3));
    if (!row) { row = { owner: item.owner, anchor: item.center, controls: [] }; rows.push(row); }
    row.controls.push(item);
  }
  return rows.map((row, i) => ({ row: `${row.owner} [${i + 1}]`, controls: row.controls,
    visibleHeightSpread: Math.max(...row.controls.map(c => c.height)) - Math.min(...row.controls.map(c => c.height)),
    heightSpread: Math.max(...row.controls.map(c => c.hitHeight ?? c.height)) - Math.min(...row.controls.map(c => c.hitHeight ?? c.height)),
    centerSpread: Math.max(...row.controls.map(c => c.hitCenter ?? c.center)) - Math.min(...row.controls.map(c => c.hitCenter ?? c.center)) }));
}

async function checkRow(page, name, selector, { separateRows = false, expectedGroups, expectedHeight } = {}) {
  const controls = await page.locator(selector).evaluateAll(nodes => nodes.filter(node => { const b = node.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(node).visibility !== 'hidden'; }).map(node => { const b = node.getBoundingClientRect(); return { name: node.id || node.className, height: b.height, center: b.y + b.height / 2, top: b.top, bottom: b.bottom }; }));
  assert.ok(controls.length >= 2, `${name}: at least two real controls rendered`);
  if (expectedHeight !== undefined) for (const control of controls) assert.equal(control.height, expectedHeight, `${name}: approved outer-frame height`);
  const groups = [];
  for (const control of controls) { let group = separateRows && groups.find(row => Math.min(row[0].bottom, control.bottom) > Math.max(row[0].top, control.top)); if (!group) { if (separateRows || !groups.length) groups.push(group = []); else group = groups[0]; } group.push(control); }
  if (expectedGroups) assert.deepEqual(groups.map(row => row.length), expectedGroups, `${name}: physical row membership cannot collapse into singleton checks`);
  for (const row of groups) {
    assert.ok(Math.max(...row.map(c => c.height)) - Math.min(...row.map(c => c.height)) <= 1, `${name}: equal outer heights ${JSON.stringify(row)}`);
    assert.ok(Math.max(...row.map(c => c.center)) - Math.min(...row.map(c => c.center)) <= 1, `${name}: centers within 1px ${JSON.stringify(row)}`);
  }
  return controls;
}

export async function runControlRows(t, sandbox) {
  console.info('Control row browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const fixture = await startPage(sandbox, process.env.ZYLOS_CONTROL_PUBLIC);
  const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
  const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env, args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR, survey = process.env.ZYLOS_CONTROL_SURVEY === '1';
  const captures = [];
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN', colorScheme: theme });
    sandbox.addCleanup(() => context.close());
    try {
      await context.route('**/*', route => route.request().url().startsWith(fixture.base + '/') ? route.continue() : route.abort());
      await context.addInitScript(theme => { localStorage.setItem('zylos-dashboard-theme', theme); localStorage.setItem('zylos-dashboard-locale', 'zh'); }, theme);
      const page = await context.newPage(); page.setDefaultTimeout(12000);
      async function settle() { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(160); await page.mouse.move(-20, -20); await page.evaluate(() => document.activeElement?.blur()); }
      async function capture(name) {
        await settle();
        const interaction = await page.evaluate(() => ({ focusedControl: document.activeElement?.matches('button,input,select,textarea,a[href]') ?? false, hoveredControls: [...document.querySelectorAll('button:hover,input:hover,select:hover,textarea:hover,a[href]:hover')].length }));
        assert.equal(interaction.focusedControl, false, 'static capture has no focused control');
        assert.equal(interaction.hoveredControls, 0, 'static capture has no hovered control');
        if (width === 390) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: no horizontal overflow`);
        const rows = await page.evaluate(measureControlRows);
        for (const row of rows) {
          if (survey) for (const control of row.controls) {
            if (control.expectedHeight !== undefined) assert.equal(control.height, control.expectedHeight, `${name}: approved size tier for ${control.control}`);
            else assert.ok(control.heightException, `${name}: control has an explicit height exception`);
          }
          for (const control of row.controls.filter(c => c.hitHeight !== undefined)) {
            assert.equal(control.height, 22, `${name}: activity visible frame remains 22px`);
            assert.equal(control.hitHeight, 44, `${name}: activity transparent target is 44px`);
            // The open menu intentionally overlays the header; hit testing belongs to the unobscured states.
            if (name !== 'conversation-menu') assert.equal(control.hitEdgesReachButton, true, `${name}: both transparent edges hit the activity button`);
          }
          if (survey && row.controls.length > 1) {
            assert.ok(row.heightSpread <= 1, `${name}: peer interaction heights ${JSON.stringify(row)}`);
            assert.ok(row.centerSpread <= 1, `${name}: peer interaction centers ${JSON.stringify(row)}`);
          }
        }
        const item = { page: name, width, theme, rows }; captures.push(item);
        if (evidence) {
          fs.writeFileSync(path.join(evidence, 'rows.json'), JSON.stringify(captures, null, 2));
          if (process.env.ZYLOS_CONTROL_MARK === '1') await page.evaluate(rows => {
            for (const row of rows.filter(row => row.controls.length > 1 && (row.heightSpread > 1 || row.centerSpread > 1))) for (const c of row.controls) {
              const mark = document.createElement('div'); mark.dataset.controlMark = ''; mark.style.cssText = `position:absolute;pointer-events:none;z-index:99999;border:2px solid #e11d48;left:${c.left + scrollX}px;top:${c.top + scrollY}px;width:${c.right - c.left}px;height:${c.height}px;box-sizing:border-box`; mark.title = `${c.height}px / center ${c.center}`; document.body.append(mark);
            }
          }, rows);
          await page.screenshot({ path: path.join(evidence, `${width}-${theme}-${name}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
          await page.locator('[data-control-mark]').evaluateAll(nodes => nodes.forEach(node => node.remove()));
        }
      }
      for (const [route, ready] of [['/', '#wb-board .wb-row'], ['/usage', '#wb-usage-range'], ['/schedule', '.wb-sched-filters'], ['/chat', '.conversation-list-toolbar']]) {
        await page.goto(fixture.base + route); await page.locator(ready).first().waitFor(); await settle();
        const name = route === '/' ? 'overview' : route.slice(1);
        if (width === 390 && route === '/usage') await page.locator('.wb-usage-custom-btn').click();
        await settle();
        if (!survey) {
          if (route === '/') await checkRow(page, name, '#wb-range, .wb-bh-now .wb-search', { expectedHeight: width === 390 ? 36 : 26 });
          if (route === '/usage') await checkRow(page, name, '#wb-usage-range, .wb-usage-custom > .wb-date, #wb-usage-apply', { separateRows: width === 390, expectedGroups: width === 390 ? [1, 3] : [4], expectedHeight: width === 390 ? 36 : 30 });
          if (route === '/schedule') await checkRow(page, name, '.wb-sched-filters > .wb-seg, .wb-sched-filters .wb-select, .wb-sched-filters > .wb-search, .wb-sched-new', { separateRows: width === 390, expectedGroups: width === 390 ? [1, 2, 1] : [4], expectedHeight: width === 390 ? 36 : 30 });
          if (route === '/chat') {
            assert.equal(await page.locator('.conversation-tabs').evaluate(node => node.getBoundingClientRect().height), width === 390 ? 36 : 30, 'chat: approved outer track');
            await checkRow(page, name, width === 390 ? '.conversation-tabs > button' : '.conversation-tabs, .conversation-reload', { expectedHeight: width === 390 ? 32 : 30 });
          }
        }
        await capture(name);
        if (survey && route === '/') {
          await page.locator('#wb-board .wb-row[data-group="dashboard:mobile-browser"]').click(); await page.locator('.wb-detail-tabs').waitFor();
          const tabs = await page.locator('.wb-detail-tabs button').allTextContents();
          for (let i = 0; i < tabs.length; i++) { await page.locator('.wb-detail-tabs button').nth(i).click(); await capture(`group-${i}`); }
          await page.locator('.wb-detail-tabs button').first().click();
          await page.locator('.wb-detail-config button').last().click(); await page.locator('.wb-cfg-controls').waitFor(); await capture('group-config');
          await page.locator('.wb-d-title-wrap button').click(); await page.locator('.wb-name-editor input').waitFor(); await capture('group-rename');
        }
        if (survey && route === '/schedule') {
          await page.locator('.wb-sched-select').first().click(); await page.locator('.wb-sched-detail').waitFor(); await capture('schedule-detail');
          await page.locator('.wb-sched-detail .wb-d-top > button').click();
          await page.locator('.wb-sched-new').click(); await page.locator('.wb-sched-field').first().waitFor(); await capture('schedule-form');
        }
        if (survey && route === '/chat') {
          await page.locator('[data-conversation-id]').last().click(); await page.locator('.conversation-header').waitFor(); await capture('conversation');
          if (width === 390) {
            await page.locator('.conversation-menu-toggle').click();
            await page.locator('.conversation-menu-rename').click();
          } else await page.locator('.conversation-title-line > .wb-icon-btn').click();
          await page.locator('.conversation-rename input').waitFor();
          await capture('conversation-rename');
          await page.locator('.conversation-rename button').last().click();
          if (width === 390) { await page.locator('.conversation-menu-toggle').click(); await capture('conversation-menu'); await page.keyboard.press('Escape'); }
          fixture.setScene('running'); await page.reload();
          await page.locator('[data-conversation-id]').last().click();
          await page.locator('.conversation-header').waitFor(); await capture('conversation-running'); fixture.setScene('idle');
        }
      }
      if (!survey) {
        await page.goto(fixture.base + '/settings');
        await page.locator('#settings-use-codex').click(); await settle();
        await checkRow(page, 'default engine', width === 390 ? '#settings-save-runtime, #settings-undo-runtime' : '.wb-seg-engine, #settings-save-runtime, #settings-undo-runtime', width === 390 ? { expectedHeight: 36 } : {});
        assert.ok(await page.locator('.wb-seg-engine').evaluate(el => el.getBoundingClientRect().height) > 36, 'engine retains its natural two-line height');
        await capture('settings-runtime-draft');
        for (const scene of ['idle', 'running']) {
          fixture.setScene(scene); await page.goto(fixture.base + '/chat');
          await page.locator('[data-conversation-id]').last().click(); await page.locator('.conversation-header').waitFor();
          await capture('conversation-' + scene);
          if (width === 390) {
            const pill = (await page.evaluate(measureControlRows)).flatMap(row => row.controls).find(c => c.hitHeight !== undefined);
            await page.mouse.click((pill.left + pill.right) / 2, pill.hitTop + 1);
            await page.locator('.wb-group-side').waitFor({ state: 'visible' });
          }
        }
        fixture.setScene('idle');
      }
      if (survey) {
        for (const route of ['/memory', '/settings']) {
          await page.goto(fixture.base + route);
          await page.locator(route === '/memory' ? '#memory-tree .memory-file' : '[data-settings-section]').first().waitFor({ state: 'attached' });
          if (route === '/memory') { await capture('memory'); await page.locator('#memory-tree .memory-file').first().click(); await capture('memory-file'); continue; }
          const sections = await page.locator('[data-settings-section]').evaluateAll(nodes => nodes.filter(n => !n.hidden).map(n => n.dataset.settingsSection));
          for (const section of sections) {
            if (width === 390) { await page.locator('.wb-set-drawer-btn').click(); await page.locator('.wb-set-nav').waitFor({ state: 'visible' }); if (section === sections[0]) await capture('settings-drawer'); }
            await page.locator(`[data-settings-section="${section}"]`).click(); await capture(`settings-${section}`);
            if (section === 'defaults') { await page.locator('#settings-use-codex').click(); await page.locator('#settings-save-runtime').waitFor(); await capture('settings-runtime-draft'); }
          }
        }
        if (width === 390) { await openMobileMore(page); await capture('mobile-more'); }
      }
    } finally { await context.close(); }
  }
  if (evidence) {
    const table = ['| Page | Width/theme | Row | Controls: visible height px; center px; hit height px | Interaction height spread | Center spread |', '|---|---|---|---|---:|---:|'];
    for (const shot of captures) for (const row of shot.rows) table.push(`| ${shot.page} | ${shot.width}/${shot.theme} | ${row.row.replaceAll('|', '/')} | ${row.controls.map(c => `${c.control.replaceAll('|', '/')}: ${c.height.toFixed(2)}; ${c.center.toFixed(2)}; ${(c.hitHeight ?? c.height).toFixed(2)}`).join('<br>')} | ${row.heightSpread.toFixed(2)} | ${row.controls.length > 1 ? row.centerSpread.toFixed(2) : 'n/a'} |`);
    fs.writeFileSync(path.join(evidence, 'rows.md'), table.join('\n') + '\n');
  }
  console.info(`Control row captures: ${captures.length}`);
}
