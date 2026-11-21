import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openGroupDetail } from './browser-navigation.js';
import { startPage } from './mobile-conversation-browser.js';

const mine = 'dashboard:mobile-browser';
const external = 'telegram:mobile-browser';
const row = group => '[data-conversation-id="g:' + Buffer.from(group).toString('hex').toUpperCase() + '"]';
const words = {
  en: 'Cancel',
  zh: '取消',
};

export async function runConversationConfigBrowser(t, sandbox) {
  const fixture = await startPage(sandbox);
  const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
  const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });

  async function open({ width, locale, theme, readOnly = false }) {
    const phone = width === 390;
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: phone, hasTouch: phone });
    sandbox.addCleanup(() => context.close());
    const updates = [];
    let runtime = 'claude', model = 'opus', effort = 'high', running = false, failModel = false;
    const pair = () => ({ runtime, model, effort, mode: 'override' });
    const prefix = readOnly ? '/fleet/phone' : '';
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (!url.href.startsWith(fixture.base + '/')) return route.abort();
      const pathname = url.pathname.slice(prefix.length);
      const original = fixture.base + pathname + url.search;
      if (readOnly && pathname === '/chat') {
        const response = await route.fetch({ url: original });
        return route.fulfill({ response, body: (await response.text())
          .replace('data-base-path=""', 'data-base-path="' + prefix + '"')
          .replace('data-remote-access="admin"', 'data-remote-access="read"')
          .replaceAll('"/_assets/', '"' + prefix + '/_assets/') });
      }
      if (readOnly && pathname === '/api/settings/chat') return route.fulfill({ json: { chat_allow_remote: true } });
      const detailPath = '/api/groups/' + encodeURIComponent(mine);
      if (pathname === detailPath + '/config' && request.method() === 'PUT') {
        const change = request.postDataJSON();
        updates.push(change.kind);
        if (change.kind === 'model' && failModel) return route.fulfill({ json: { ok: false, error: 'fixture rejected the model' } });
        if (change.kind === 'runtime') runtime = change.value;
        else { model = change.model; effort = change.effort; }
        return route.fulfill({ json: { ok: true, data: { runtime, resolved: pair(),
          desired: change.kind === 'runtime' ? { runtime } : pair(),
          running: { status: running ? 'pending' : 'not_running' } } } });
      }
      if (pathname === detailPath + '/actions/restart') {
        updates.push(request.postDataJSON().runId);
        return route.fulfill({ json: { ok: true, result: 'accepted' } });
      }
      if ([detailPath, '/api/groups/' + encodeURIComponent(external)].includes(pathname)) {
        const response = await route.fetch({ url: original });
        const value = await response.json();
        return route.fulfill({ json: { ...value, presence: running ? 'running' : 'offline',
          launchConfig: running ? pair() : null, live: running ? { runId: 'config-run', sessionId: 'config-session' } : null,
          target: pair(), desired: pair(), config: { modelOverrides: [pair()],
            runtime: { ok: true, data: { desired: { runtime }, resolved: pair() } },
            model: { ok: true, data: { runtime, desired: pair(), resolved: pair() } } } } });
      }
      if (readOnly) return route.continue({ url: original });
      return route.continue();
    });
    await context.addInitScript(({ locale, theme }) => {
      if (window !== window.top) return;
      localStorage.setItem('zylos-dashboard-locale', locale);
      localStorage.setItem('zylos-dashboard-theme', theme);
    }, { locale, theme });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.base + prefix + '/chat');
    const button = page.locator('.conversation-config-button');
    const panel = page.locator('.conversation-config-panel');
    const choose = async (editor, nextModel) => {
      await editor.locator('.wb-cfg-model select').first().selectOption(nextModel);
      await editor.locator('.wb-cfg-model select').last().selectOption('medium');
    };
    const ready = async editor => {
      await editor.locator('.wb-cfg-model select option[value="sonnet"]').waitFor({ state: 'attached' });
    };
    const capture = async name => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (evidence) await page.screenshot({ path: path.join(evidence, [width, locale, theme, name].join('-') + '.png') });
    };
    return { page, context, button, panel, choose, ready, capture, updates, errors,
      setRunning() { running = true; }, failNextModel() { failModel = true; } };
  }

  for (const width of [1280, 390]) for (const locale of ['en', 'zh']) for (const theme of ['light', 'dark']) {
    await t.test(width + ' ' + locale + ' ' + theme, async () => {
      const phone = width === 390;
      const f = await open({ width, locale, theme });
      const { page, button, panel } = f;
      try {
        await page.locator(row(mine)).click();
        const input = page.locator('.conversation-input'), send = page.locator('.conversation-send');
        const attach = page.locator('.conversation-attach');
        await input.waitFor();
        await page.waitForFunction(() => document.querySelector('.conversation-config-summary')?.textContent.includes('opus'));
        const initial = await input.boundingBox();
        assert.equal(initial.height, phone ? 44 : 40);
        if (phone) {
          assert.equal(await button.isVisible(), false);
          assert.ok(Math.abs(initial.y - (await attach.boundingBox()).y) < 1);
          await f.capture('mine');
          await input.tap();
        }
        const chip = await button.boundingBox(), text = await input.boundingBox(), sendBox = await send.boundingBox();
        assert.ok(chip.x >= (await attach.boundingBox()).x && chip.x + chip.width <= sendBox.x);
        assert.equal(text.height, initial.height);
        assert.ok(Math.abs(chip.y + chip.height / 2 - (sendBox.y + sendBox.height / 2)) <= 1);
        if (phone) {
          assert.ok(text.width >= initial.width && text.y + text.height <= chip.y);
          await f.capture('focused');
          await button.tap();
        } else {
          assert.ok(text.x + text.width <= chip.x);
          await f.capture('mine');
          await button.click();
        }
        await f.ready(panel);
        const bounds = await panel.boundingBox();
        assert.ok(phone ? bounds.y + bounds.height >= 843 : bounds.y + bounds.height <= chip.y);
        await f.capture('mine-editor');
        await page.keyboard.press('Escape');
        assert.equal(await panel.isVisible(), false);
        if (phone) await page.locator('.conversation-back').click();
        await page.locator('.conversation-tabs [data-action="external"]').click();
        await page.locator(row(external)).click();
        await button.waitFor();
        assert.equal(await page.locator('.conversation-composer').count(), 0);
        const footer = await page.locator('.conversation-config-footer').boundingBox();
        assert.ok(footer.height >= 38 && footer.height <= 42);
        assert.equal(await page.locator('.conversation-config-footer').innerText(), await button.innerText());
        await f.capture('external');
        await button.click();
        await f.ready(panel);
        await f.capture('external-editor');
        await panel.getByRole('button', { name: words[locale], exact: true }).click();
        assert.equal(await panel.isVisible(), false);
        assert.deepEqual(f.errors, []);
        console.info('Configuration layout', { width, locale, theme, input: text.width, chip: chip.height, composer: text.height, footer: footer.height });
      } finally { await f.context.close(); }
    });
  }

  await t.test('group detail and quick editor refresh each other after saving', async () => {
    const f = await open({ width: 1280, locale: 'en', theme: 'light' });
    const { page, button, panel, updates } = f;
    try {
      await page.locator(row(mine)).click();
      await page.locator('[data-action="listToggle"]').click();
      await openGroupDetail(page);
      const side = page.locator('.wb-group-side .wb-detail-config');
      await side.getByRole('button', { name: 'Edit', exact: true }).click();
      await f.ready(side);
      await button.click();
      await f.ready(panel);
      await f.choose(panel, 'sonnet');
      const save = editor => editor.getByRole('button', { name: 'Save', exact: true });
      await save(panel).click();
      await side.locator('.wb-cfg-line b').filter({ hasText: 'sonnet' }).waitFor();
      assert.match(await button.innerText(), /sonnet/);
      assert.equal(await side.locator('.wb-cfg-model select').first().inputValue(), 'sonnet');
      assert.deepEqual(updates, ['model']);
      await page.keyboard.press('Escape');
      await f.choose(side, 'opus');
      await save(side).click();
      await button.filter({ hasText: 'opus' }).waitFor();
      await button.click();
      await f.ready(panel);
      assert.equal(await panel.locator('.wb-cfg-model select').first().inputValue(), 'opus');

      f.setRunning();
      await f.choose(panel, 'sonnet');
      await save(panel).click();
      const confirmation = page.getByRole('alertdialog');
      await confirmation.waitFor();
      assert.deepEqual(updates, ['model', 'model']);
      await confirmation.getByRole('button', { name: 'Save and restart' }).click();
      await panel.locator('.wb-config-result').filter({ hasText: 'Accepted' }).waitFor();
      assert.deepEqual(updates, ['model', 'model', 'model', 'config-run']);
      assert.equal(await confirmation.count(), 0);
      f.failNextModel();
      await f.choose(panel, 'opus');
      await save(panel).click();
      await confirmation.getByRole('button', { name: 'Save and restart' }).click();
      await panel.locator('.wb-config-error').filter({ hasText: 'fixture rejected the model' }).waitFor();
      assert.deepEqual(updates, ['model', 'model', 'model', 'config-run', 'model']);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });

  await t.test('read-only users can inspect the external group configuration', async () => {
    const f = await open({ width: 390, locale: 'en', theme: 'light', readOnly: true });
    try {
      await f.page.locator('.conversation-tabs [data-action="external"]').click();
      await f.page.locator(row(external)).click();
      await f.button.tap();
      await f.ready(f.panel);
      assert.equal(await f.panel.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
      assert.equal(await f.panel.locator('.wb-cfg-model select').first().inputValue(), 'opus');
      assert.deepEqual(f.updates, []);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
}
