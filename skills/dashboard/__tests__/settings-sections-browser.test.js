import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { startPage } from './helpers/workbench-browser.js';
import { openDashboardTab } from './helpers/browser-navigation.js';
import { GROUP, workbenchAnswer } from './fixtures/workbench-browser-api.js';

// Boundary: the real settings page in a local browser with fixed API answers (the workbench fixture plus this case's
// update check, keys, machines, prices and session hosting); writes are recorded and answered, nothing runs.
// Run when the settings sections, their order, the zylos version card, the engine upgrade button, the long-list
// search and pages, the hosting allowlist tags, channel picker or detach question, or the phone section bar change; skip for
// backend-only and other pages' changes. Opt-in with the same gate as the chat browser cases before any directory,
// server or browser is allocated; the harness proves the private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket paths and
// closes the browser and HTTP server when the case ends.

const iso = seconds => new Date(Date.UTC(2026, 10, 1) + seconds * 1000).toISOString();
const ELEVEN = Array.from({ length: 11 }, (_, index) => index + 1);
const rate = { input: 1, output: 2, cacheRead: 0.1, cacheCreation: 1 };
const fixtures = {
  keys: ELEVEN.map(n => ({ name: `key-${n}`, scope: n % 2 ? 'read' : 'admin', status: 'active', created_at: iso(n * 3600), last_used_at: null })),
  machines: ELEVEN.map(n => ({ name: `machine-${n}`, base_url: `https://machine-${n}.example`, access: 'read' })),
  prices: Object.fromEntries(ELEVEN.map(n => [`model-${n}`, rate])),
  hosts: ELEVEN.map(n => ({ source_group: `issue-${n}`, target_group: 'origin', attached_by: 'owner', attached_at: 1_790_000_000 + n })),
};

test('the settings page keeps its sections in order, offers the right upgrades and pages its long lists', {
  skip: !chatEnabled(), timeout: 150_000,
}, async t => {
  const sandbox = createChatSandbox(t);
  await sandbox.runCase(async () => {
    const { base } = await startPage(sandbox);
    const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
    const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true,
      env: sandbox.env, args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
    sandbox.addCleanup(() => browser.close());
    const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
    if (evidence) fs.mkdirSync(evidence, { recursive: true });

    async function open(width, { coreUpdate, detail = 'plain', allowlist = ['multica', 'lark'], channels = [], channelsFail = false, touch = false } = {}) {
      const context = await browser.newContext({ viewport: { width, height: width < 761 ? 844 : 900 }, hasTouch: touch, timezoneId: 'Asia/Singapore', reducedMotion: 'reduce' });
      sandbox.addCleanup(() => context.close());
      const writes = [];
      let hosting = { allowlist, relationships: fixtures.hosts };
      await context.addInitScript(detail => {
        try {
          localStorage.setItem('zylos-dashboard-locale', 'zh'); localStorage.setItem('zylos-dashboard-theme', 'light');
          localStorage.setItem('zylos-dashboard-detail-level', detail);
        } catch { /* Sandboxed embedded documents have no local storage. */ }
        // What the page copies, kept for the case to read; the real clipboard is not touched.
        window.__copied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copied.push(text); } } });
      }, detail);
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), method = request.method();
        if (url.origin !== base) return route.abort();
        if (url.pathname === '/_assets/vendor/chart.umd.js') return route.fulfill({ path: process.env.ZYLOS_CHAT_CHART_ASSET, contentType: 'text/javascript' });
        if (method !== 'GET' && url.pathname.startsWith('/api/')) writes.push({ path: url.pathname, body: request.postDataJSON?.() ?? null });
        if (url.pathname === '/api/instance/core-update') return route.fulfill({ json: coreUpdate });
        if (url.pathname === '/api/instance' && method === 'GET') {
          const value = workbenchAnswer(url, Date.now());
          value.versions = { ...value.versions, claude: { installed: '2.1.0' }, codex: { installed: '0.50.0', update: '0.51.0' } };
          return route.fulfill({ json: value });
        }
        if (url.pathname === '/api/instance/actions/upgrade-runtime') return route.fulfill({ json: { ok: true } });
        if (url.pathname === '/api/keys' && method === 'GET') return route.fulfill({ json: { keys: fixtures.keys } });
        if (url.pathname === '/api/fleet/agents' && method === 'GET') return route.fulfill({ json: { self: { name: 'browser-case' }, agents: fixtures.machines } });
        if (url.pathname === '/api/settings/pricing' && method === 'PUT') return route.fulfill({ json: { ok: true } });
        if (url.pathname === '/api/settings/pricing' && method === 'GET') return route.fulfill({ json: { active: 'claude', runtimes: {
          claude: { builtInModels: Object.keys(fixtures.prices), modelPrices: fixtures.prices, fastMode: { configuredMultiplier: 6 } },
          codex: { builtInModels: ['gpt'], modelPrices: { gpt: rate }, priorityModelPrices: {}, builtInPriorityModels: [] } } } });
        if (url.pathname === '/api/session-hosts') {
          if (method === 'POST') {
            const body = request.postDataJSON();
            if (body.action === 'allow') hosting = { ...hosting, allowlist: [...hosting.allowlist, body.channel].sort() };
            if (body.action === 'disallow') hosting = { ...hosting, allowlist: hosting.allowlist.filter(channel => channel !== body.channel) };
            if (body.action === 'detach') hosting = { ...hosting, relationships: hosting.relationships.filter(row => row.source_group !== body.group) };
            return route.fulfill({ json: { ...hosting, changed: true } });
          }
          return route.fulfill({ json: hosting });
        }
        if (url.pathname === '/api/session-hosts/channels') return route.fulfill(channelsFail ? { status: 502, json: { error: 'session_host_unavailable' } } : { json: { channels } });
        return route.continue();
      });
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(8000);
      page.on('pageerror', error => { if (errors.length < 4) errors.push(error.message); });
      await page.goto(base + '/');
      await openDashboardTab(page, 'settings');
      await page.locator('[data-settings-section]').first().waitFor({ state: 'attached' });
      const pick = async name => {
        if (width < 761) { await page.locator('.wb-set-drawer-btn').click(); await page.locator('.wb-set-drawer-open').waitFor(); }
        await page.locator(`[data-settings-section="${name}"]`).click();
        if (width < 761) await page.waitForFunction(() => !document.querySelector('.wb-set').classList.contains('wb-set-drawer-open'));
      };
      const shot = async name => { if (evidence) await page.screenshot({ path: path.join(evidence, `${name}-${width}.png`) }); };
      return { context, page, errors, writes, pick, shot };
    }

    const dialog = page => page.locator('.wb-modal[role="alertdialog"]');
    const visibleRows = (page, list, selector) => page.locator(list).locator(selector).evaluateAll(rows => rows.filter(row => !row.hidden).map(row => row.dataset.search ?? row.textContent.trim().split(/\s+/)[0]));

    await t.test('the six sections in order, opening on the account; the machine section in order with the observer shown without technical detail', async () => {
      const { context, page, errors, pick, shot } = await open(1280, { coreUpdate: { current: '1.2.0', latest: '1.2.0', hasUpdate: false, checkedAt: iso(0) } });
      const nav = await page.locator('[data-settings-section]').evaluateAll(buttons => buttons.map(button => [button.dataset.settingsSection, button.textContent.trim(), button.getAttribute('aria-current')]));
      assert.deepEqual(nav, [['account', '账户', 'true'], ['general', '常规', 'false'], ['machine', '本机运行', 'false'], ['fleet', '连接其他机器', 'false'], ['defaults', 'AI 设置', 'false'], ['pricing', '模型定价', 'false']]);
      assert.equal(await page.locator('#settings-section-account .wb-set-card').first().locator('#logout-btn').count(), 1, 'signing out is at the top of the account section');
      await pick('machine');
      await page.locator('#settings-session-hosts').waitFor();
      const order = await page.locator('#settings-section-machine').evaluate(section => [...section.querySelectorAll('.wb-set-card')].filter(card => !card.closest('[hidden]')).map(card => card.querySelector('h4')?.textContent.trim()));
      assert.deepEqual(order, ['zylos 版本', '实例时区', '终端观察', '会话模式', '托管免通知白名单', '会话托管']);
      assert.equal(await page.locator('#observer-settings-group').isVisible(), true, 'the terminal observer shows with technical detail off');
      await shot('machine-order');
      assert.deepEqual(errors, []);
      await context.close();
    });

    await t.test('the zylos version card shows when it was checked and copies the upgrade instruction only for a newer release', async () => {
      for (const hasUpdate of [true, false]) {
        const { context, page, errors, writes, pick, shot } = await open(1280, { coreUpdate: { current: '1.2.0', latest: hasUpdate ? '1.3.0' : '1.2.0', hasUpdate, checkedAt: iso(0) } });
        await pick('machine');
        const card = page.locator('#settings-version');
        await card.getByText(/^检查于 /).waitFor();
        assert.match(await card.textContent(), /zylos · v1\.2\.0/);
        if (!hasUpdate) { assert.equal(await page.locator('#settings-zylos-update').count(), 0, 'no newer release, no button'); await context.close(); continue; }
        const button = page.locator('#settings-zylos-update');
        assert.equal(await button.textContent(), '可更新到 v1.3.0 · 复制升级指令');
        await button.click();
        await dialog(page).waitFor();
        assert.equal(await dialog(page).locator('h3').textContent(), '复制升级指令');
        const prompt = await dialog(page).locator('p').textContent();
        assert.match(prompt, /从 v1\.2\.0 升级到 v1\.3\.0/);
        await shot('core-update-question');
        await dialog(page).locator('.wb-modal-acts button').last().click();
        await card.getByText('已复制，发给 AI 就能让它升级。').waitFor();
        const copied = await page.evaluate(() => window.__copied);
        assert.equal(copied.length, 1); assert.match(copied[0], /从 v1\.2\.0 升级到 v1\.3\.0/);
        assert.deepEqual(writes, [], 'copying the instruction sends nothing');
        assert.deepEqual(errors, []);
        await context.close();
      }
    });

    await t.test('the default engine card upgrades the engine chosen in it', async () => {
      const { context, page, errors, writes, pick } = await open(1280, { coreUpdate: null });
      await pick('defaults');
      const upgrade = page.locator('#settings-engine-version [data-action="upgrade-cc"]');
      await upgrade.waitFor();
      assert.match(await page.locator('#settings-engine-version').textContent(), /Claude Code · v2\.1\.0/);
      await page.locator('#settings-use-codex').click();
      await page.locator('#settings-engine-version').getByText(/Codex · v0\.50\.0 ↑0\.51\.0/).waitFor();
      assert.match(await upgrade.textContent(), /Codex/);
      await upgrade.click();
      await dialog(page).locator('.wb-modal-acts button').last().click();
      await dialog(page).waitFor({ state: 'detached' });
      for (let i = 0; i < 50 && !writes.length; i++) await page.waitForTimeout(100);
      assert.deepEqual(writes, [{ path: '/api/instance/actions/upgrade-runtime', body: { runtime: 'codex' } }]);
      assert.deepEqual(errors, []);
      await context.close();
    });

    await t.test('hosting, keys, machines and prices: a total, eight a page, search across pages and an empty result', async () => {
      const { context, page, errors, writes, pick, shot } = await open(1280, { coreUpdate: null });
      const lists = [
        ['machine', '#settings-host-relationships', '.wb-host-rows', '.wb-host-row', '共 11 个', 'issue-'],
        ['account', '#api-key-list', '#api-key-list', 'tbody tr', '11 个有效 · 0 个已吊销', 'key-'],
        ['fleet', '#fleet-agent-list', '#fleet-agent-list', '.wb-agent-row', '共 11 台', 'machine-'],
        ['pricing', '#settings-model-pricing-group', '.settings-table-scroll:has(#settings-price-table)', '#settings-price-rows tr', '共 11 个型号', 'model-'],
      ];
      for (const [section, cardSelector, listSelector, rowSelector, total, prefix] of lists) {
        await pick(section);
        const card = page.locator(cardSelector).locator('xpath=ancestor-or-self::*[contains(concat(" ", @class, " "), " wb-set-card ")][1]');
        const list = page.locator(listSelector);
        await list.locator(rowSelector).first().waitFor({ state: 'attached' });
        assert.match(await card.locator('.wb-set-card-sub').allTextContents().then(texts => texts.join(' ')), new RegExp(total), `${section}: the total beside the title`);
        const rows = () => list.locator(rowSelector).evaluateAll(nodes => nodes.filter(node => !node.hidden).length);
        const pager = card.locator('.wb-plist-pager'), search = card.locator('.wb-plist-search input');
        assert.equal(await rows(), 8, `${section}: eight on the first page`);
        assert.equal(await pager.locator('.wb-plist-at').textContent(), '第 1 / 2 页');
        const height = await list.evaluate(node => node.getBoundingClientRect().height);
        await pager.locator('.wb-plist-next').click();
        assert.equal(await rows(), 3, `${section}: three on the second page`);
        assert.equal(await pager.locator('.wb-plist-at').textContent(), '第 2 / 2 页');
        assert.ok(Math.abs(await list.evaluate(node => node.getBoundingClientRect().height) - height) <= 1, `${section}: a shorter last page keeps the list height`);
        await search.fill(prefix + '1');
        assert.equal(await rows(), 3, `${section}: the search finds ${prefix}1, ${prefix}10 and ${prefix}11 across both pages`);
        assert.equal(await pager.isVisible(), false);
        await search.fill('不存在');
        await card.getByText('没有匹配的结果').waitFor();
        assert.equal(await rows(), 0);
        await shot(`${section}-no-match`);
        await search.fill('');
      }
      // A price edited on another page is saved with every other row, after going back to the first page.
      const pricing = page.locator('#settings-model-pricing-group');
      await pricing.locator('.wb-plist-next').click();
      const ninth = page.locator('#settings-price-rows tr[data-prefix="model-9"] input.settings-num').first();
      await ninth.fill('7');
      await pricing.locator('.wb-plist-prev').click();
      assert.equal(await ninth.isVisible(), false, 'the edited row is on the other page');
      await page.locator('#settings-save').click();
      for (let i = 0; i < 50 && !writes.some(write => write.path === '/api/settings/pricing'); i++) await page.waitForTimeout(100);
      const saved = writes.filter(write => write.path === '/api/settings/pricing');
      assert.equal(saved.length, 1);
      const rows = saved[0].body.runtimes.claude.modelPrices;
      assert.deepEqual(Object.keys(rows).sort(), Object.keys(fixtures.prices).sort(), 'all 11 price rows are saved');
      assert.equal(rows['model-9'].input, 7, 'with the edited value');
      assert.equal(rows['model-1'].input, rate.input);
      assert.deepEqual(errors, []);
      await context.close();
    });

    await t.test('with the channel list unavailable only adding is; a tag is removed at once; detaching asks first and cancelling keeps it', async () => {
      const { context, page, errors, writes, pick, shot } = await open(1280, { coreUpdate: null, channelsFail: true });
      await pick('machine');
      const tags = page.locator('#settings-host-allowlist .wb-host-chip');
      await tags.first().waitFor();
      assert.deepEqual(await tags.allTextContents(), ['multica', 'lark']);
      assert.equal(await page.locator('.wb-host-row').count(), 11, 'the hosted groups still show');
      await page.getByText('无法加载已登记的通道，暂时不能添加。重新打开设置可重试。').waitFor();
      assert.equal(await page.getByRole('combobox', { name: '通道名称' }).isVisible(), false);
      await page.locator('#settings-host-allowlist').scrollIntoViewIfNeeded();
      await shot('channels-unavailable');
      await page.getByRole('button', { name: '移除 multica', exact: true }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('#settings-host-allowlist .wb-host-chip')].map(tag => tag.textContent).join() === 'lark');
      assert.equal(await dialog(page).count(), 0, 'no question for removing a tag');
      assert.deepEqual(writes.splice(0), [{ path: '/api/session-hosts', body: { action: 'disallow', channel: 'multica' } }]);
      const row = page.locator('.wb-host-row').filter({ hasText: 'issue-1 → origin' }).first();
      await row.getByRole('button', { name: '解除', exact: true }).click();
      await dialog(page).waitFor();
      assert.equal(await dialog(page).locator('h3').textContent(), '解除会话托管');
      await shot('detach-question');
      await dialog(page).locator('.wb-modal-acts button').first().click();
      await dialog(page).waitFor({ state: 'detached' });
      await page.waitForTimeout(300);
      assert.deepEqual(writes, [], 'cancelling sends nothing');
      assert.equal(await page.locator('.wb-host-row').count(), 11);
      assert.deepEqual(errors, []);
      await context.close();
    });

    await t.test('a channel is added only by picking a registered one not on the list yet, on desktop and phone', async () => {
      for (const width of [1280, 390]) {
        const { context, page, errors, writes, pick, shot } = await open(width, { coreUpdate: null, allowlist: ['telegram'], channels: ['feishu', 'telegram'], touch: width < 761 });
        const press = locator => width < 761 ? locator.tap() : locator.click();
        await pick('machine');
        const card = page.locator('#settings-host-allowlist');
        const field = card.getByRole('combobox', { name: '通道名称' });
        const options = card.getByRole('option');
        const add = card.getByRole('button', { name: '加入白名单', exact: true });
        const tags = () => card.locator('.wb-host-chip').allTextContents();
        await card.locator('.wb-host-chip').first().waitFor();
        await press(field);
        await card.getByRole('listbox').waitFor();
        assert.deepEqual(await options.allTextContents(), ['feishu'], 'a channel already on the list is not offered');
        await shot('channel-picker-open');
        // Text that names no offered channel finds nothing and adds nothing, by button or Enter.
        await field.fill('zzz');
        assert.equal(await options.count(), 0);
        await card.getByText('没有可加入的通道').waitFor();
        await shot('channel-picker-no-match');
        assert.equal(await add.isDisabled(), true);
        await field.press('Enter');
        await field.fill('telegram');
        assert.equal(await options.count(), 0, 'nor does the name of a channel already on the list');
        await field.press('Enter');
        await page.waitForTimeout(300);
        assert.deepEqual(writes, []);
        await field.press('Escape');
        assert.equal(await card.getByRole('listbox').isVisible(), false);
        // Part of a name finds the channel; picking it and adding saves it beside the existing tag.
        await field.fill('fei');
        assert.deepEqual(await options.allTextContents(), ['feishu']);
        await press(options.first());
        assert.equal(await field.inputValue(), 'feishu');
        assert.equal(await card.getByRole('listbox').isVisible(), false);
        await press(add);
        await page.waitForFunction(() => document.querySelectorAll('#settings-host-allowlist .wb-host-chip').length === 2);
        assert.deepEqual(await tags(), ['feishu', 'telegram']);
        assert.deepEqual(writes, [{ path: '/api/session-hosts', body: { action: 'allow', channel: 'feishu' } }]);
        assert.equal(await field.inputValue(), '');
        await press(field);
        await card.getByText('没有可加入的通道').waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        await shot('channel-picker-added');
        assert.deepEqual(errors, []);
        await context.close();
      }
    });

    await t.test('on a phone the section bar stays at the top while the settings page scrolls', async () => {
      const { context, page, errors, pick, shot } = await open(390, { coreUpdate: null });
      await pick('machine');
      await page.locator('#settings-session-hosts').waitFor();
      const bar = () => page.locator('.wb-set-drawer-btn').evaluate(node => { const box = node.getBoundingClientRect(), header = document.querySelector('.app-header')?.getBoundingClientRect(); return { top: Math.round(box.top), headerBottom: Math.round(header?.bottom ?? 0), visible: box.bottom > 0 && box.top < innerHeight }; });
      const before = await bar();
      await page.mouse.wheel(0, 1600); await page.waitForTimeout(200);
      assert.ok(await page.evaluate(() => scrollY > 400 || document.querySelector('.wb-set-body').scrollTop > 400 || document.scrollingElement.scrollTop > 400), 'the page scrolled');
      const after = await bar();
      assert.equal(after.visible, true, 'the section bar is still on screen');
      assert.ok(after.top <= Math.max(before.top, after.headerBottom) + 1, `the bar stays at the top (${JSON.stringify({ before, after })})`);
      await shot('sticky-section-bar');
      assert.deepEqual(errors, []);
      await context.close();
    });
  }, { timeoutMs: 140_000 });
});

// Runs the real settings card and action sender against the browser fixture.
// Run for default engine or model confirmation, save, or feedback changes. The fixture owns all HTTP
// responses; no CLI, runtime, PM2 or tmux is used.
test('setting the default engine and model updates the open cards and reports restart refusals', {
  skip: !chatEnabled(), timeout: 90_000,
}, async t => {
  const sandbox = createChatSandbox(t);
  await sandbox.runCase(async () => {
    console.log('Default engine browser isolation:', JSON.stringify(sandbox.assertIsolation()));
    const { base } = await startPage(sandbox);
    const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
    const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true,
      env: { ...sandbox.env, TZ: 'Asia/Singapore' },
      args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
    sandbox.addCleanup(() => browser.close());
    const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
    const switchPath = '/api/instance/actions/switch-runtime';
    const variants = [
      { locale: 'zh', theme: 'light', badge: '默认', rejection: '测试凭据已被拒绝', saved: '已将默认 AI 引擎设为 Codex。' },
      { locale: 'zh', theme: 'dark', badge: '默认', rejection: '测试凭据已被拒绝', saved: '已将默认 AI 引擎设为 Codex。' },
      { locale: 'en', theme: 'light', badge: 'Default', rejection: 'Fixture credentials were rejected', saved: 'Default AI engine saved as Codex.' },
      { locale: 'en', theme: 'dark', badge: 'Default', rejection: 'Fixture credentials were rejected', saved: 'Default AI engine saved as Codex.' },
    ];
    for (const width of [1280, 390]) for (const { locale, theme, badge, rejection, saved } of variants) {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 },
        timezoneId: 'Asia/Singapore', reducedMotion: 'reduce' });
      try {
        await context.addInitScript(({ locale, theme }) => {
          localStorage.setItem('zylos-dashboard-locale', locale);
          localStorage.setItem('zylos-dashboard-theme', theme);
        }, { locale, theme });
        const writes = [], modelWrites = [];
        await context.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== base) return route.abort();
          if (url.pathname === '/_assets/vendor/chart.umd.js') return route.fulfill({ path: process.env.ZYLOS_CHAT_CHART_ASSET, contentType: 'text/javascript' });
          if (decodeURIComponent(url.pathname) === '/api/groups/' + GROUP) {
            const response = await route.fetch();
            return route.fulfill({ response, json: { ...await response.json(), modelOverridden: true } });
          }
          if (url.pathname === '/api/instance/defaults' && request.method() === 'PUT') {
            modelWrites.push(request.postDataJSON());
            return route.fulfill({ json: { ok: true, data: { groupsComplete: true, groups: [
              { sessionGroup: 'origin', restart: { status: 'not_restarted', reason: 'fence_conflict' } },
            ] } } });
          }
          if (url.pathname === switchPath && request.method() === 'POST') {
            writes.push(request.postDataJSON());
            return writes.length === 1
              ? route.fulfill({ status: 403, json: { ok: false, error: { code: 'AUTH_FAILED', message: rejection } } })
              : route.fulfill({ json: { ok: true, data: { result: 'saved', baseline: 'codex', groups: [
                { sessionGroup: 'origin', restart: { status: 'not_restarted', reason: 'fence_conflict' } },
                { sessionGroup: GROUP, restart: { status: 'accepted' } },
              ] }, messageKey: 'result.runtime_saved', messageParams: { value: 'Codex' } } });
          }
          return route.continue();
        });
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        await page.goto(base + '/');
        await openDashboardTab(page, 'settings');
        if (width === 390) await page.locator('.wb-set-drawer-btn').click();
        await page.locator('[data-settings-section="defaults"]').click();
        let navigations = 0;
        page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
        const card = page.locator('#settings-current-runtime');
        const save = card.locator('#settings-save-runtime');
        const select = engine => card.locator('#settings-use-' + engine);
        const dialog = page.locator('.wb-modal[role="alertdialog"]');
        const submit = async () => {
          await save.click();
          await dialog.waitFor();
          assert.match(await dialog.textContent(), locale === 'zh' ? /2 个组/ : /2 running groups/);
          if (evidence && !writes.length) {
            await page.evaluate(() => document.activeElement?.blur());
            await page.screenshot({ path: path.join(evidence, `default-confirm-${locale}-${width}-${theme}.png`) });
          }
          await dialog.locator('.wb-modal-acts button').last().click();
        };
        await select('claude').waitFor();
        assert.equal(await select('claude').getAttribute('aria-pressed'), 'true');
        assert.equal(await select('claude').locator('.wb-tag').textContent(), badge);
        await select('codex').click();
        await save.click();
        await dialog.locator('.wb-modal-acts button').first().click();
        await dialog.waitFor({ state: 'hidden' });
        assert.deepEqual(writes, []);
        await submit();
        await card.getByText(rejection).waitFor();
        assert.equal(await save.isVisible(), true);
        assert.equal(await select('claude').locator('.wb-tag').textContent(), badge);
        const shot = async suffix => {
          if (!evidence) return;
          await page.evaluate(() => document.activeElement?.blur());
          await page.mouse.move(0, 0);
          await card.screenshot({ path: path.join(evidence, `default-engine-${locale === 'en' ? 'en-' : ''}${width}-${theme}-${suffix}.png`) });
        };
        await shot('rejected');
        await submit();
        await card.getByText(saved).waitFor();
        await card.getByText(/Origin.*fence_conflict/).waitFor();
        await save.waitFor({ state: 'hidden' });
        assert.equal(await select('codex').getAttribute('aria-pressed'), 'true');
        assert.equal(await select('codex').locator('.wb-tag').textContent(), badge);
        assert.equal(await select('claude').locator('.wb-tag').count(), 0);
        assert.equal(navigations, 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        assert.deepEqual(writes, Array.from({ length: 2 }, () => ({ runtime: 'codex', confirmed: true })));
        await shot('saved');
        await page.locator('#settings-model-claude').selectOption('sonnet');
        const modelSave = page.locator('#settings-save-models');
        const confirmModel = async () => {
          await modelSave.click();
          await dialog.waitFor();
          const text = await dialog.textContent();
          assert.match(text, locale === 'zh' ? /会立即重启正在运行、使用这个默认模型的 1 个组/
            : /1 running group that uses this default model will restart immediately/);
          assert.match(text, /Origin/);
          assert.doesNotMatch(text, /Telegram direct chat|Product weekly/);
        };
        await confirmModel();
        await dialog.locator('.wb-modal-acts button').first().click();
        await dialog.waitFor({ state: 'hidden' });
        assert.deepEqual(modelWrites, []);
        await confirmModel();
        if (evidence) {
          await page.evaluate(() => document.activeElement?.blur());
          await page.screenshot({ path: path.join(evidence, `default-model-confirm-${locale}-${width}-${theme}.png`) });
        }
        await dialog.locator('.wb-modal-acts button').last().click();
        const modelResult = page.locator('#settings-model-result');
        await modelResult.getByText(/Origin.*fence_conflict/).waitFor();
        const [saveMessage, restartMessage] = (await modelResult.textContent()).split('\n');
        assert.equal(saveMessage, locale === 'zh' ? '已保存。' : 'Saved.');
        assert.match(restartMessage, /Origin.*fence_conflict/);
        assert.deepEqual(modelWrites, [{ kind: 'model', runtime: 'claude', model: 'sonnet', confirmed: true }]);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        await modelResult.evaluate(node => node.scrollIntoView({ block: 'center' }));
        if (evidence) {
          await page.evaluate(() => document.activeElement?.blur());
          await page.mouse.move(0, 0);
          await page.screenshot({ path: path.join(evidence, `default-model-result-${locale}-${width}-${theme}.png`) });
        }
      } finally {
        await context.close();
      }
    }
  }, { timeoutMs: 80_000 });
});
