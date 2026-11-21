import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { CONTENT_PREFIX } from '../../comm-bridge/scripts/c4-content-schema.js';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { startPage } from './helpers/mobile-conversation-browser.js';

const wideTable = [
  '| Stage | Primary instances | Owner | Observation time | Rollback command |',
  '| --- | --- | --- | --- | --- |',
  '| Smoke test | node-01, node-02 | Release engineering | One hour | deploy rollback --batch=1 --keep-traffic |',
].join('\n');
const timestamp = '2026-11-12T05:30:00.000Z';
const form = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/view-and-form.json', import.meta.url))).formQuestion;
const sent = { id: 8, channel: 'dashboard', direction: 'in', timestamp, status: 'delivered',
  content: '[quote c4_id=7]\nCan you verify the **rollout**?\nPlease keep the owners in the table.',
  quote: { id: '7', direction: 'out', excerpt: 'Earlier rollout notes' } };
const reply = { id: 9, channel: 'dashboard', direction: 'out', timestamp, status: 'sent',
  content: 'Here is the updated rollout plan.\n\n' + wideTable, attachments: [] };
const internal = { id: 10, channel: 'internal', direction: 'out', timestamp, status: 'sent', content: 'Confirm the maintenance window.',
  internal: { peerDisplayName: 'Operations', peerExists: false, peerChannel: 'telegram', content: 'Confirm the maintenance window.' } };
const rich = { ...reply, id: 11, content: CONTENT_PREFIX + JSON.stringify(form) };
const rows = [...Array.from({ length: 7 }, (_, i) => ({ ...reply, id: i + 1,
  content: 'Earlier rollout notes.\n\n' + 'A detailed observation from the smoke test. '.repeat(8) })),
  sent, reply, internal, rich];
const group = 'g:' + Buffer.from('dashboard:mobile-browser').toString('hex').toUpperCase();
const rowSelector = id => `#wb-chat [data-message-id="${id}"]`;
const copySelector = '.conversation-message-meta .conversation-copy-button';
const output = process.env.ZYLOS_REPLY_COPY_EVIDENCE;
const options = { skip: !chatEnabled(), timeout: 120_000 };

async function run(t, check, messageRows = rows) {
  const sandbox = createChatSandbox(t);
  await sandbox.runCase(async () => {
    const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
    const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, env: sandbox.env,
      args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
    sandbox.addCleanup(() => browser.close());
    const fixture = await startPage(sandbox, undefined, messageRows);
    const baseline = process.env.ZYLOS_REPLY_COPY_BASELINE_PUBLIC
      ? await startPage(sandbox, process.env.ZYLOS_REPLY_COPY_BASELINE_PUBLIC, messageRows) : null;

    async function open({ width = 390, locale = 'en', theme = 'light', base = fixture.base } = {}) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width <= 760,
        isMobile: width <= 760, locale: locale === 'en' ? 'en-SG' : 'zh-CN', timezoneId: 'Asia/Singapore' });
      sandbox.addCleanup(() => context.close());
      await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
      await context.addInitScript(({ locale, theme }) => {
        if (window !== window.top) return;
        localStorage.setItem('zylos-dashboard-locale', locale);
        localStorage.setItem('zylos-dashboard-theme', theme);
      }, { locale, theme });
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + '/chat');
      await page.locator(`[data-conversation-id="${group}"]`).click();
      await page.locator(rowSelector(reply.id)).waitFor();
      return { page, context, errors };
    }
    await check(open, baseline?.base);
  }, { timeoutMs: 110_000 });
}

async function screenshot(page, name) {
  if (!output) return;
  fs.mkdirSync(output, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
}

async function geometry(page) {
  return page.evaluate(({ sent, reply, internal, rich }) => {
    const row = id => document.querySelector(`#wb-chat [data-message-id="${id}"]`);
    function measure(element) {
      if (!element) return null;
      const { x, y, width, height, bottom, right } = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { x, y, width, height, bottom, right, background: style.backgroundColor,
        shadow: style.boxShadow, opacity: Number(style.opacity) };
    }
    function message(id) {
      const article = row(id);
      const find = selector => article.querySelector(selector);
      return {
        avatar: measure(find('.conversation-avatar')), author: measure(find('.chat-message-author')),
        content: measure(find('.chat-message-content')), text: measure(find('.chat-message-text')),
        time: measure(find('.conversation-message-meta time')), timeCount: article.querySelectorAll('time').length,
        copy: measure(find('.conversation-copy-button')), quote: measure(find('.conversation-quote-button')),
        copyIcon: measure(find('.conversation-copy-button .wb-ico')),
      };
    }
    const scroll = row(reply).querySelector('.conversation-table-scroll');
    return { viewport: innerWidth, pageWidth: document.documentElement.scrollWidth,
      sent: message(sent), reply: message(reply), internal: message(internal), rich: message(rich),
      richCard: measure(row(rich).querySelector('.chat-block-form_intent')),
      richTitle: measure(row(rich).querySelector('.chat-block-title')),
      table: { ...measure(scroll), scrollWidth: scroll.scrollWidth } };
  }, { sent: sent.id, reply: reply.id, internal: internal.id, rich: rich.id });
}

const positionHistory = page => page.locator('.conversation-stream').evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 285; });

test('mobile AI replies fill the stream and keep table overflow inside the reply', options, async t => {
  await run(t, async (open, baseline) => {
    for (const width of [390, 1280]) for (const locale of output ? ['en', 'zh'] : ['en'])
      for (const theme of output ? ['light', 'dark'] : ['light']) {
        const { page, context, errors } = await open({ width, locale, theme });
        await positionHistory(page);
        const name = `conversation-${width}-${locale}-${theme}`;
        const layout = await geometry(page);
        assert.equal(layout.pageWidth, width);
        assert.equal(layout.reply.timeCount, 1);
        assert.equal(layout.internal.copy, null);
        const older = baseline && await open({ width, locale, theme, base: baseline });
        if (older) {
          await positionHistory(older.page);
          const original = await geometry(older.page);
          if (width === 390) {
            assert.ok(original.reply.text.width < 360, 'the old layout fails the full-width check');
          } else {
            for (const key of ['content', 'time', 'avatar']) {
              const { width: oldWidth, height: oldHeight, x: oldX } = original.reply[key];
              assert.deepEqual([layout.reply[key].width, layout.reply[key].height, layout.reply[key].x], [oldWidth, oldHeight, oldX], key);
            }
          }
          for (const key of ['content', 'time', 'avatar']) {
            assert.equal(layout.internal[key].width, original.internal[key].width, `internal ${key} width`);
            assert.equal(layout.sent[key].width, original.sent[key].width, `sent ${key} width`);
          }
          await screenshot(older.page, name + '-baseline');
          if (output) fs.writeFileSync(path.join(output, name + '-baseline.json'), JSON.stringify(original, null, 2));
          await older.context.close();
        }
        if (width === 390) {
          assert.ok(layout.reply.text.width >= 360, JSON.stringify(layout.reply));
          assert.equal(layout.reply.avatar.width, 0);
          assert.equal(layout.reply.author.width, 0);
          assert.equal(layout.reply.text.background, 'rgba(0, 0, 0, 0)');
          assert.equal(layout.reply.text.shadow, 'none');
          assert.ok(layout.reply.time.y >= layout.reply.content.bottom);
          assert.ok(layout.reply.copy.x < layout.reply.time.x);
          assert.deepEqual([layout.reply.copy.width, layout.reply.copy.height], [36, 36]);
          assert.deepEqual([layout.reply.copyIcon.width, layout.reply.copyIcon.height], [13, 13]);
          assert.ok(layout.table.scrollWidth > layout.table.width);
          assert.ok(layout.table.right <= width);
          assert.ok(layout.richCard.width >= 360);
          assert.notEqual(layout.richCard.shadow, 'none');
          assert.equal(layout.richTitle.height, 24, 'the long status can wrap below the form title');
          assert.ok(layout.sent.content.x > layout.reply.content.x);
          assert.equal(layout.sent.copy.width, 0);
          assert.ok(layout.internal.avatar.width > 0 && layout.internal.text.shadow !== 'none');
        } else {
          assert.ok(layout.reply.avatar.width > 0);
          assert.equal(layout.reply.copy.opacity, 0);
          assert.ok(layout.reply.time.y < layout.reply.content.y);
          assert.ok(Math.abs(layout.reply.copy.y - layout.reply.quote.y) <= 1);
          assert.equal(layout.reply.copy.height, layout.reply.quote.height);
        }
        await screenshot(page, name);
        if (width === 1280) {
          await page.locator(rowSelector(reply.id)).hover();
          await screenshot(page, name + '-hover');
        }
        if (output) fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(layout, null, 2));
        assert.deepEqual(errors, []);
        await context.close();
      }
  });
});

async function expectedText(page, row) {
  return page.evaluate(async item => (await import('/_assets/js/wb/chat-compose-text.js')).readableText(item), row);
}

test('copy writes the readable text and reports success or a Clipboard API failure', options, async t => {
  const withAttachment = { ...reply, attachments: [{ name: 'rollout.txt', kind: 'file', id: 'file-test' }] };
  await run(t, async open => {
    for (const width of [390, 1280]) {
      const { page, context } = await open({ width });
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      if (width === 1280) {
        const firstReply = page.locator(rowSelector(reply.id));
        await firstReply.locator('.conversation-quote-button').focus();
        await page.keyboard.press('Tab');
        assert.ok(await firstReply.locator(copySelector).evaluate(el =>
          el === document.activeElement && el.matches(':focus-visible') && getComputedStyle(el).outlineStyle === 'solid'));
      }
      for (const item of width === 390 ? [withAttachment, rich] : [withAttachment, sent]) {
        const article = page.locator(rowSelector(item.id));
        const copy = article.locator(copySelector);
        if (width === 1280) await article.hover();
        await copy.click();
        const expected = await expectedText(page, item);
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected);
        assert.equal(await copy.getAttribute('data-copied'), 'true');
        assert.equal(await copy.getAttribute('aria-label'), 'Copied');
        await copy.locator('.wb-ico-check').waitFor();
        await copy.locator('.wb-ico-copy').waitFor();
      }
      const article = page.locator(rowSelector(reply.id));
      if (width === 1280) await article.hover();
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          async writeText() { throw new Error('clipboard_unavailable'); },
        } });
      });
      await article.locator(copySelector).click();
      const feedback = article.getByText("Couldn't copy. Select the text instead.", { exact: true });
      await feedback.waitFor();
      await feedback.waitFor({ state: 'hidden' });
      await context.close();
    }
  }, rows.map(item => item === reply ? withAttachment : item));
});

test('holding a sent message copies or opens native text selection and Back restores the same history position', options, async t => {
  await run(t, async open => {
    for (const locale of output ? ['en', 'zh'] : ['en']) for (const theme of output ? ['light', 'dark'] : ['light']) {
      const { page, context, errors } = await open({ locale, theme });
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      const touch = await context.newCDPSession(page);
      async function hold(target) {
        await target.scrollIntoViewIfNeeded();
        const box = await target.boundingBox();
        const x = box.x + box.width * 0.65, y = box.y + box.height - 14;
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await delay(650);
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      const sentText = page.locator(rowSelector(sent.id) + ' .chat-message-text');
      const menu = page.locator('.conversation-copy-menu');
      const copy = menu.getByRole('button', { name: locale === 'en' ? 'Copy' : '复制', exact: true });
      const select = menu.getByRole('button', { name: locale === 'en' ? 'Select text' : '选择文本', exact: true });
      const dialog = page.locator('.conversation-select-text');
      const stream = page.locator('.conversation-stream');
      await hold(sentText);
      await menu.waitFor();
      assert.equal(await menu.getByRole('button').count(), 2);
      assert.equal((await copy.boundingBox()).height, 36);
      await screenshot(page, `copy-menu-390-${locale}-${theme}`);
      await page.touchscreen.tap(4, 100);
      await menu.waitFor({ state: 'hidden' });
      await hold(sentText);
      await copy.tap();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await expectedText(page, sent));
      const feedback = page.locator(rowSelector(sent.id) + ' .conversation-copy-bubble-feedback');
      assert.equal(await feedback.innerText(), locale === 'en' ? 'Copied' : '已复制');
      assert.ok(await feedback.evaluate(el => el.getBoundingClientRect().top >= el.previousElementSibling.getBoundingClientRect().bottom));
      await hold(sentText);
      const previous = await stream.evaluate(el => el.scrollTop);
      assert.ok(previous > 0);
      const url = page.url();
      const historyLength = await page.evaluate(() => history.length);
      await select.tap();
      await dialog.waitFor();
      assert.deepEqual(await dialog.boundingBox(), { x: 0, y: 0, width: 390, height: 844 });
      const text = dialog.locator('.conversation-select-text-body');
      assert.equal(await text.textContent(), await expectedText(page, sent));
      assert.equal(await text.evaluate(el => getComputedStyle(el).userSelect), 'text');
      assert.equal(page.url(), url);
      assert.equal(await page.evaluate(() => history.length), historyLength + 1);
      await screenshot(page, `select-text-390-${locale}-${theme}`);
      await page.goBack();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(page.url(), url);
      assert.equal(await stream.evaluate(el => el.scrollTop), previous);
      await hold(sentText);
      await select.tap();
      await dialog.locator('.conversation-select-text-back').tap();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await stream.evaluate(el => el.scrollTop), previous);

      const ai = page.locator(rowSelector(reply.id) + ' .chat-message-text p').first();
      await hold(ai);
      assert.equal(await menu.isVisible(), false, 'AI replies retain native text selection');
      assert.notEqual(await ai.evaluate(el => getComputedStyle(el).userSelect), 'none');
      assert.deepEqual(errors, []);
      await context.close();
    }
  });
});
