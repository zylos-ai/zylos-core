import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAttachmentApiFixture, fixturePng } from './chat-attachments-api.js';
import { makeQuestionSummary } from '../../../comm-bridge/scripts/c4-content-schema.js';

const png = fixturePng();
const textFile = name => ({ name, mimeType: 'text/plain', buffer: Buffer.from('隔离浏览器附件\n') });
const imageFile = name => ({ name, mimeType: 'image/png', buffer: png });
const markdown = (id, text) => ({ id, type: 'markdown', schemaVersion: 1, data: { text } });
const mediaBlock = (id, record, kind) => ({ id, type: `x-zylos.${kind}`, schemaVersion: 1,
  fallbackText: `${kind === 'image' ? '[图片]' : '[文件]'} ${record.name}`,
  data: { attachmentId: record.attachmentId, nameSnapshot: record.name } });

export async function runAttachmentVisual(t, sandbox) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE, executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath)); assert.ok(executablePath && fs.existsSync(executablePath));
  const output = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (output) fs.mkdirSync(output, { recursive: true });
  const prototypeFile = process.env.ZYLOS_CHAT_PROTOTYPE_FILE;
  const prototypeSource = prototypeFile ? fs.readFileSync(prototypeFile, 'utf8') : null;
  if (prototypeSource) {
    const prototypeBytes = Buffer.from(prototypeSource);
    assert.equal(crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${prototypeBytes.length}\0`), prototypeBytes])).digest('hex'),
      '77d676e8735904aa4c223e8d1d98551a9e7d3f37', 'prototype is the exact approved source');
  }
  const isolation = sandbox.assertIsolation();
  const fixture = await createAttachmentApiFixture(t, sandbox, { prototypeSource });
  const scenes = {};
  for (const [name, title] of [['mixed', '附件与图文一起聊'], ['uploads', '待发附件与输入'], ['other', '另一个对话'], ['states', '附件不可用与恢复'], ['scroll', '图片与阅读位置'], ['older', '更早图片与阅读位置']]) {
    const conversation = await fixture.createConversation('请保留正文与附件的关联。');
    assert.equal((await fixture.request(conversation.route, { method: 'PATCH', body: { displayName: title } })).status, 200);
    scenes[name] = conversation;
  }
  const userImage = await fixture.upload(scenes.mixed, 'portrait.png', fixturePng(120, 180), 'image/png');
  const userFile = await fixture.upload(scenes.mixed, '需求说明.pdf', Buffer.from('private user document'));
  const userSend = await fixture.request(scenes.mixed.route + '/send', { method: 'POST', body: { content: '', attachments: [userImage.id, userFile.id] } });
  assert.equal(userSend.status, 200); assert.equal(userSend.body.stored, true);
  scenes.mixed.userRow = userSend.body.messageId;
  const preview = await fixture.register(scenes.mixed.draft.localId, '工作台预览.png', 'image', png);
  const report = await fixture.register(scenes.mixed.draft.localId, '布局评估.pdf');
  const mixedEnvelope = { version: 1, kind: 'message', messageId: 'mixed-media-message', fallbackText: '已准备预览与评估报告', blocks: [
    markdown('intro', '**建议保留清晰的主操作区。** 草图和评估报告放在一起，先看整体，再决定下一步。'),
    mediaBlock('preview', preview, 'image'), mediaBlock('report', report, 'file'),
    { id: 'coverage', type: 'category_series', schemaVersion: 1, fallbackText: '评估覆盖：可读性 9，可操作性 8。', data: { title: '评估覆盖', points: [
      { key: 'reading', label: '可读性', value: 9 }, { key: 'actions', label: '可操作性', value: 8 } ] } },
    { id: 'next', type: 'choice', schemaVersion: 1, fallbackText: '要继续细化这版布局吗？', data: { prompt: '要继续细化这版布局吗？',
      options: [{ id: 'review', label: '按这个方向继续' }, { id: 'later', label: '稍后继续' }], action: { type: 'choice.select', target: 'layout.next' } } },
  ], interruptId: 'mixed-media-interrupt', interrupt: { blockId: 'next', reason: 'input_required' } };
  mixedEnvelope.questionSummary = makeQuestionSummary(mixedEnvelope);
  fixture.setFallbackEnvelope(mixedEnvelope);
  scenes.mixed.row = fixture.addAgent(scenes.mixed.draft.localId, mixedEnvelope);
  const missing = await fixture.register(scenes.states.draft.localId, '方案说明.pdf');
  const broken = await fixture.register(scenes.states.draft.localId, '评审截图.png', 'image', png);
  const stateEnvelope = { version: 1, kind: 'message', messageId: 'media-states-message', fallbackText: '部分附件暂不可用', blocks: [
    markdown('intro', '部分资料暂时无法打开，文件名仍保留在消息中。可重试的项恢复后会在原位更新。'),
    mediaBlock('missing', missing, 'file'), mediaBlock('broken', broken, 'image'),
  ] };
  scenes.states.row = fixture.addAgent(scenes.states.draft.localId, stateEnvelope);
  const missingRecord = fixture.store.db.prepare('SELECT * FROM chat_attachments WHERE id=?').get(missing.attachmentId);
  const missingPath = path.join(fixture.attachments.mediaDir, missingRecord.storage_name);
  const missingBytes = fs.readFileSync(missingPath); fs.unlinkSync(missingPath);
  const scrollImage = await fixture.register(scenes.scroll.draft.localId, '延迟预览.png', 'image', fixturePng(120, 480));
  scenes.scroll.image = scrollImage;
  scenes.scroll.imageRow = fixture.addAgent(scenes.scroll.draft.localId, { version: 1, kind: 'message', messageId: 'delayed-media-message',
    fallbackText: '延迟图片', blocks: [mediaBlock('delayed', scrollImage, 'image')] });
  for (let index = 0; index < 30; index++) fixture.addOutbound(scenes.scroll.draft.localId, `历史讨论 ${index + 1}：继续核对方案边界，保留前面的决定和待办，方便检查图片加载后的阅读位置。`);
  const olderImage = await fixture.register(scenes.older.draft.localId, '更早预览.png', 'image', fixturePng(120, 480));
  scenes.older.image = olderImage;
  scenes.older.imageRow = fixture.addAgent(scenes.older.draft.localId, { version: 1, kind: 'message', messageId: 'older-media-message',
    fallbackText: '更早图片', blocks: [mediaBlock('older', olderImage, 'image')] });
  for (let index = 0; index < 70; index++) scenes.older.visibleRow = fixture.addOutbound(scenes.older.draft.localId, `更早的历史讨论 ${index + 1}：保留历史阅读位置。`).id;
  const external = fixture.c4.insertConversation('in', 'telegram', 'media-external',
    '原渠道资料\n[attachment:image /private/original/photo.png name="原渠道截图.png" 120 KB]\n[MEDIA:/private/original/legacy.png]', { groupName: 'media-external' });
  const externalId = 'g:' + Buffer.from(external.session_group).toString('hex').toUpperCase();
  const { chromium } = await import(pathToFileURL(modulePath));
  sandbox.assertIsolation();
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const context = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', acceptDownloads: true });
  await context.route('**/*', route => route.request().url().startsWith(fixture.base + '/') ? route.continue() : route.abort());
  await context.addCookies([{ name: '__Secure-zylos_dashboard_session', value: fixture.cookie, domain: '127.0.0.1', path: '/', secure: true }]);
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  const errors = [], shots = [], prototypeShots = [], checks = [], measurements = [];
  const check = message => { checks.push(message); console.log('Attachment browser checkpoint: ' + message); };
  const until = async (check, message) => {
    const deadline = Date.now() + 4000;
    while (!check()) { if (Date.now() >= deadline) throw Error(message); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  const bounded = async (promise, message) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), 4000); })]); }
    finally { clearTimeout(timer); }
  };
  let expectedHttpError = null, uploads = 0, sends = 0, reads = 0;
  const attachmentRequests = [];
  page.on('pageerror', error => { if (!errors.length) errors.push(error.message); });
  page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:') && !errors.length) errors.push(message.text()); });
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname.endsWith('/uploads')) uploads++;
    if (request.method() === 'POST' && url.pathname.endsWith('/send')) sends++;
    if (url.pathname.endsWith('/messages')) reads++;
    if (url.pathname.includes('/attachments/') && attachmentRequests.length < 200) attachmentRequests.push(url.pathname);
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (response.status() >= 400 && url.pathname !== '/favicon.ico' && !expectedHttpError?.(url, response.status()) && !errors.length) errors.push(`${response.status()} ${url.pathname}`);
  });
  const choose = async (name, { writable = true } = {}) => {
    const id = scenes[name].receipt.conversationId;
    const item = page.locator(`#wb-chat [data-conversation-id="${id}"]`);
    if (!await item.isVisible()) await page.locator('#wb-chat .conversation-back').click();
    await item.click(); await page.locator(`#wb-chat [data-message-id="${scenes[name].visibleRow || scenes[name].receipt.messageId}"]`).waitFor();
    if (writable) await page.waitForFunction(() => { const control = document.querySelector('#wb-chat [data-action="attach"]'); return control && !control.hidden && !control.disabled; });
  };
  const composer = () => page.locator('#wb-chat .chat-composer');
  const input = () => page.locator('#wb-chat .chat-composer textarea');
  const trayItems = () => page.locator('#wb-chat .conversation-upload-tray [data-upload-id]');
  const itemNamed = name => trayItems().filter({ has: page.locator('.chat-attachment-name').filter({ hasText: name }) });
  const waitReady = async (name, count = 1) => {
    const locator = name ? itemNamed(name) : trayItems();
    await locator.first().waitFor();
    await page.waitForFunction(({ name, count }) => {
      const items = [...document.querySelectorAll('#wb-chat .conversation-upload-tray [data-upload-id]')]
        .filter(node => !name || node.querySelector('.chat-attachment-name')?.textContent === name);
      return items.length === count && items.every(node => node.dataset.uploadState === 'ready');
    }, { name, count });
  };
  const chooseFiles = async files => {
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#wb-chat [data-action="attach"]').click();
    await (await chooser).setFiles(files);
  };
  const clearTray = async () => {
    for (let count = await trayItems().count(); count > 0; count--) await trayItems().first().locator('[data-action="removeAttachment"]').click();
    assert.equal(await trayItems().count(), 0);
  };
  const capture = async name => {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ' fits document width');
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), name + ' fits document height');
    if (output) { const filename = path.join(output, name + '.png'); await page.screenshot({ path: filename }); shots.push(filename); }
  };
  const brokenPattern = `**/attachments/${broken.attachmentId}`;
  await context.route(brokenPattern, route => route.abort());
  await page.clock.install();
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript(value => { if (window === window.top && ['http:', 'https:'].includes(location.protocol)) localStorage.setItem('zylos-dashboard-theme', value); }, theme);
    await page.goto(fixture.base + '/chat'); await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
    await choose('mixed');
    const agent = page.locator(`[data-message-id="${scenes.mixed.row.id}"]`), user = page.locator(`[data-message-id="${scenes.mixed.userRow}"]`);
    assert.equal(await agent.locator('.chat-attachment').count(), 2); assert.equal(await user.locator('.chat-attachment').count(), 2);
    assert.equal(await agent.locator('canvas').count(), 1); assert.equal(await agent.locator('[data-interrupt-id="mixed-media-interrupt"]').count(), 1);
    assert.ok((await agent.innerText()).includes('建议保留清晰的主操作区'));
    await agent.locator('.chat-attachment-image-frame[data-state="loaded"]').waitFor();
    const historyLayout = await agent.locator('.chat-attachment').evaluateAll(cards => cards.map(card => {
      const button = card.querySelector('[data-action="downloadAttachment"]'), parent = card.parentElement;
      return { icon: !!card.querySelector('.wb-ico-image,.wb-ico-file'), width: card.getBoundingClientRect().width,
        actionWidth: button?.getBoundingClientRect().width || 0, wbButton: button?.classList.contains('wb-btn'),
        outerBorder: getComputedStyle(parent).borderTopWidth };
    }));
    assert.ok(historyLayout.every(card => card.icon && card.wbButton && card.actionWidth <= 120 && card.actionWidth < card.width / 2 && card.outerBorder === '0px'));
    measurements.push({ width, theme, historyLayout });
    assert.ok((await page.locator('#wb-chat').innerText()).includes('portrait.png'));
    assert.equal((await page.locator('#wb-chat').innerText()).includes(fixture.attachments.mediaDir), false, 'no local media path leaks into visible history');
    await user.scrollIntoViewIfNeeded(); await capture(`user-attachments-${width}-${theme}`);
    await agent.scrollIntoViewIfNeeded(); await capture(`attachments-${width}-${theme}`);
    await choose('states');
    const states = page.locator(`[data-message-id="${scenes.states.row.id}"]`);
    await states.locator('.chat-attachment-image-frame[data-state="failed"]').waitFor();
    const failedPlaceholder = await states.locator('.chat-attachment-image-frame[data-state="failed"]').evaluate(frame => ({
      height: frame.getBoundingClientRect().height, icon: !!frame.querySelector('.chat-attachment-placeholder .wb-ico-image') }));
    assert.ok(failedPlaceholder.height <= 80 && failedPlaceholder.height >= 40 && failedPlaceholder.icon, 'image failure uses a short visible icon placeholder');
    measurements.push({ width, theme, failedPlaceholder });
    assert.equal(await states.locator('.chat-attachment').filter({ hasText: '方案说明.pdf' }).locator('[data-action="downloadAttachment"]').count(), 0);
    assert.equal(await states.locator('[data-action="retryAttachment"]:visible').count(), 1);
    await states.scrollIntoViewIfNeeded(); await capture(`attachment-states-${width}-${theme}`);
    await choose('uploads');
    await chooseFiles([textFile('旧待发资料.pdf')]); await waitReady('旧待发资料.pdf');
    await page.clock.fastForward(25 * 60 * 1000 + 1000); await page.clock.resume();
    await itemNamed('旧待发资料.pdf').locator('[data-action="retryUpload"]').waitFor();
    assert.equal(await itemNamed('旧待发资料.pdf').getAttribute('data-upload-state'), 'expired');
    await chooseFiles([textFile('补充说明.pdf')]); await waitReady('补充说明.pdf');
    const uploadPattern = '**/api/chat/conversations/*/uploads';
    expectedHttpError = (url, status) => url.pathname.endsWith('/uploads') && status === 503;
    await context.route(uploadPattern, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'chat_attachment_write_failed' }) }));
    await chooseFiles([imageFile('补充截图.png')]);
    await itemNamed('补充截图.png').locator('[data-action="retryUpload"]').waitFor();
    const failedTrayPreview = await itemNamed('补充截图.png').locator('.chat-attachment-image-frame[data-state="failed"]').evaluate(frame => ({ height: frame.getBoundingClientRect().height, icon: !!frame.querySelector('.chat-attachment-placeholder .wb-ico-image') }));
    assert.ok(failedTrayPreview.height <= 36 && failedTrayPreview.icon, 'failed tray image uses the approved short placeholder');
    await context.unroute(uploadPattern); expectedHttpError = null;
    let heldUpload, resolveHeld;
    const heldStarted = new Promise(resolve => { resolveHeld = resolve; });
    await context.route(uploadPattern, route => { heldUpload = route; resolveHeld(); });
    await chooseFiles([textFile('交互录屏.mp4')]); await heldStarted;
    assert.equal(await page.locator('#wb-chat [data-action="send"]').isDisabled(), true, 'an in-progress upload blocks ordinary sending');
    assert.equal(await itemNamed('交互录屏.mp4').locator('progress').count(), 1);
    assert.ok((await page.locator('#wb-chat .conversation-upload-label').innerText()).includes('4'));
    assert.ok((await itemNamed('补充说明.pdf').innerText()).includes('已准备'));
    assert.match(await itemNamed('交互录屏.mp4').innerText(), /上传中.*\d+%/);
    assert.ok((await composer().innerText()).includes('支持粘贴、拖入'));
    const trayLayout = await trayItems().evaluateAll(cards => cards.map(card => {
      const info = card.querySelector('.chat-attachment-info'), buttons = [...card.querySelectorAll('button')];
      const probe = document.createElement('span'); probe.style.color = 'var(--c-danger-ink)';
      card.append(probe); const dangerInk = getComputedStyle(probe).color; probe.remove();
      const style = getComputedStyle(card), statusColor = getComputedStyle(card.querySelector('.chat-attachment-status')).color;
      return { name: card.querySelector('.chat-attachment-name').textContent, infoHeight: info.getBoundingClientRect().height,
        icon: !!info.querySelector('.wb-ico-image,.wb-ico-file'), state: card.dataset.uploadState, dangerInk, statusColor,
        outline: style.outlineStyle, outlineColor: style.outlineColor, outlineWidth: style.outlineWidth, outlineOffset: style.outlineOffset,
        buttons: buttons.map(button => ({ wb: button.classList.contains('wb-btn'), width: button.getBoundingClientRect().width,
          height: button.getBoundingClientRect().height, marginStart: getComputedStyle(button).marginInlineStart })) };
    }));
    assert.ok(trayLayout.every(card => card.icon && card.infoHeight <= 76 && card.buttons.every(button => button.wb && button.marginStart !== 'auto')));
    const errorItems = trayLayout.filter(card => ['failed', 'expired'].includes(card.state));
    assert.equal(errorItems.length, 2, 'both failed and expired tray states are present');
    assert.ok(errorItems.every(card => {
      return card.outline === 'solid' && card.outlineWidth === '1px' && card.outlineOffset === '-1px'
        && card.outlineColor === card.dangerInk && card.statusColor === card.dangerInk
        && card.outline !== trayLayout.find(other => other.state === 'ready').outline;
    }), 'failed/expired tray items retain an inside danger outline and danger status text');
    measurements.push({ width, theme, trayLayout });
    const sizes = await composer().locator('button:visible').evaluateAll(nodes => nodes.map(node => ({ action: node.dataset.action, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
    if (width === 390) assert.ok(sizes.every(box => box.width >= 40 && box.height >= 40), 'phone attachment controls have 40px targets');
    measurements.push({ width, theme, controls: sizes });
    await capture(`tray-${width}-${theme}`);
    await heldUpload.continue(); await context.unroute(uploadPattern); await waitReady('交互录屏.mp4');
    await itemNamed('补充截图.png').locator('[data-action="retryUpload"]').click(); await waitReady('补充截图.png');
    await clearTray();
  }
  await context.unroute(brokenPattern);
  // Chrome's transport throttling exercises actual XMLHttpRequest.upload
  // progress events, without substituting the page's XHR implementation.
  await page.setViewportSize({ width: 1280, height: 900 }); await choose('uploads');
  await chooseFiles([imageFile('焦点预览.png')]); await waitReady('焦点预览.png');
  const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 128 * 1024 });
  try {
    await chooseFiles([{ name: '真实上传进度.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(600 * 1024, 97) }]);
    await page.waitForFunction(() => [...document.querySelectorAll('#wb-chat .conversation-upload-tray progress')].some(node => node.value > 0 && node.value < 100));
    const progress = await itemNamed('真实上传进度.bin').locator('progress').evaluate(node => node.value);
    assert.ok(progress > 0 && progress < 100); assert.equal(await page.locator('#wb-chat [data-action="send"]').isDisabled(), true);
    await itemNamed('焦点预览.png').evaluate(node => {
      const button = node.querySelector('[data-action="removeAttachment"]'), image = node.querySelector('img');
      button.focus();
      const saved = window.__trayFocus = { node, button, image, srcWrites: 0 };
      saved.observer = new MutationObserver(records => { saved.srcWrites += records.filter(record => record.attributeName === 'src').length; });
      if (image) saved.observer.observe(image, { attributes: true, attributeFilter: ['src'] });
    });
    await page.waitForFunction(value => [...document.querySelectorAll('#wb-chat .conversation-upload-tray progress')].some(node => node.value > value), progress);
    // Poll completion uses the actual refresh action without moving keyboard focus.
    const focusRead = page.waitForResponse(response => new URL(response.url()).pathname === scenes.uploads.route + '/messages');
    await page.locator('#wb-chat [data-action="refreshMessages"]').evaluate(node => node.click());
    await focusRead;
    await bounded(page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))), 'tray refresh layout did not settle');
    const trayFocus = await itemNamed('焦点预览.png').evaluate(node => {
      const saved = window.__trayFocus; saved.observer.disconnect();
      return { sameRow: node === saved.node, sameButton: node.querySelector('[data-action="removeAttachment"]') === saved.button,
        sameImage: node.querySelector('img') === saved.image, focused: document.activeElement === saved.button, srcWrites: saved.srcWrites };
    });
    assert.equal(trayFocus.sameRow, true); assert.equal(trayFocus.sameButton, true); assert.equal(trayFocus.sameImage, true);
    assert.equal(trayFocus.focused, true); assert.equal(trayFocus.srcWrites, 0); measurements.push({ trayFocus });
    measurements.push({ actualXHRProgress: progress });
    await waitReady('真实上传进度.bin'); await clearTray();
    const previousRecords = fixture.store.db.prepare('SELECT COUNT(*) n FROM chat_attachments').get().n;
    await chooseFiles([{ name: '实际中断上传.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(600 * 1024, 98) }]);
    await page.waitForFunction(() => [...document.querySelectorAll('#wb-chat .conversation-upload-tray progress')].some(node => node.value > 0 && node.value < 100));
    await until(() => fs.readdirSync(fixture.attachments.mediaDir).some(name => name.endsWith('.part')), 'actual streamed upload did not create a private partial file');
    await itemNamed('实际中断上传.bin').locator('[data-action="removeAttachment"]').click();
    await until(() => !fs.readdirSync(fixture.attachments.mediaDir).some(name => name.endsWith('.part')), 'aborted upload left its private partial file');
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) n FROM chat_attachments').get().n, previousRecords, 'interrupted upload never publishes a usable attachment ID');
    assert.equal(await itemNamed('实际中断上传.bin').count(), 0);
  } finally {
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await cdp.detach();
  }
  check('real XHR progress advances during an actual upload; removing a second streamed upload aborts XHR and reclaims its partial file without publishing an ID');
  // Real clipboard/drop events deliver browser File objects to the actual page.
  await page.setViewportSize({ width: 1280, height: 900 }); await choose('uploads');
  await input().evaluate((node, bytes) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], '粘贴截图.png', { type: 'image/png' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, [...png]);
  await waitReady('粘贴截图.png');
  const uploadsBeforeHistoryDrop = uploads;
  const historyDrop = await page.locator('#wb-chat .chat-messages').evaluate(node => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['drop body'], '拖入说明.txt', { type: 'text/plain' }));
    const over = new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true });
    const drop = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
    node.dispatchEvent(over); node.dispatchEvent(drop); return { over: over.defaultPrevented, drop: drop.defaultPrevented };
  });
  assert.equal(historyDrop.over, true); assert.equal(historyDrop.drop, true);
  await waitReady('拖入说明.txt');
  assert.equal(uploads, uploadsBeforeHistoryDrop + 1, 'dropping on history dispatches exactly one attachment upload');
  check('actual browser File choose, paste and drop each complete one authorized upload');
  const countA = await trayItems().count(); await choose('other'); assert.equal(await trayItems().count(), 0);
  await choose('uploads'); assert.equal(await trayItems().count(), countA, 'switching back restores only the owning conversation tray');
  const sendRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/send'));
  const sendResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/send'));
  await input().fill('正文与附件一起发送。'); await page.locator('#wb-chat [data-action="send"]').click();
  const sentBody = (await sendRequest).postDataJSON(); assert.equal(sentBody.attachments.length, 2); assert.equal(sentBody.content, '正文与附件一起发送。');
  assert.equal((await sendResponse).status(), 200);
  await page.waitForFunction(() => document.querySelectorAll('#wb-chat .conversation-upload-tray [data-upload-id]').length === 0);
  await page.reload(); await page.locator('#wb-chat [data-conversation-id]').first().waitFor(); await choose('uploads');
  await page.locator('#wb-chat .chat-message .chat-attachment-name').filter({ hasText: '粘贴截图.png' }).waitFor();
  const imageSources = await page.locator('#wb-chat .chat-message .chat-attachment-image-content').evaluateAll(nodes => nodes.map(node => node.src));
  assert.ok(imageSources.length && imageSources.every(source => source.startsWith(fixture.base + '/api/chat/') && !source.startsWith('blob:')), 'sent images reload through authorized history routes');
  check('text plus ready IDs, per-conversation tray isolation, successful-send removal and authorized image reload');
  await chooseFiles([textFile('刷新前未发送.txt')]); await waitReady('刷新前未发送.txt');
  await page.reload(); await page.locator('#wb-chat [data-conversation-id]').first().waitFor(); await choose('other');
  assert.equal(await trayItems().count(), 0, 'refresh never attaches another conversation pending files');
  await choose('uploads'); assert.equal(await trayItems().count(), 0, 'refresh does not claim browser File/Blob persistence');
  const twenty = Array.from({ length: 20 }, (_, index) => textFile(`批量资料-${index + 1}.txt`));
  await chooseFiles(twenty); await waitReady(null, 20);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await bounded(page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))), 'twenty-item viewport layout did not settle');
    const bounds = await page.locator('#wb-chat .conversation-upload-tray').evaluate(tray => ({ height: tray.getBoundingClientRect().height,
      scrollHeight: tray.scrollHeight, clientHeight: tray.clientHeight, historyHeight: document.querySelector('#wb-chat .chat-messages').getBoundingClientRect().height,
      pageHeight: document.documentElement.scrollHeight, viewport: innerHeight }));
    if (output) fs.writeFileSync(path.join(output, `twenty-item-bounds-${width}.json`), JSON.stringify(bounds, null, 2));
    assert.ok(bounds.height <= 190, 'twenty-item tray remains bounded by the approved188px limit: ' + JSON.stringify(bounds));
    assert.ok(bounds.scrollHeight <= (width === 390 ? 1600 : 800), 'twenty file rows keep the approved compact information layout: ' + JSON.stringify(bounds));
    assert.ok(bounds.historyHeight > 0 && bounds.pageHeight <= bounds.viewport + 1, 'history remains visible while the full tray is scrollable: ' + JSON.stringify(bounds));
    await trayItems().last().locator('[data-action="removeAttachment"]').scrollIntoViewIfNeeded();
    const lastButton = await trayItems().last().locator('[data-action="removeAttachment"]').boundingBox();
    if (width === 390) assert.ok(lastButton.width >= 40 && lastButton.height >= 40, 'the final tray item remains reachable with a40px remove target');
    measurements.push({ width, twentyItemTray: bounds });
  }
  await page.setViewportSize({ width: 1280, height: 900 }); const beforeRejected = uploads;
  await chooseFiles([textFile('第21件.txt')]);
  await page.locator('#wb-chat .conversation-upload-notice:visible').waitFor();
  assert.equal(await trayItems().count(), 20); assert.equal(uploads, beforeRejected, 'twenty-first item is rejected before uploading');
  const batchRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/send'));
  const batchResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/send'));
  await page.locator('#wb-chat [data-action="send"]').click();
  assert.equal((await batchRequest).postDataJSON().attachments.length, 20, 'all twenty ready IDs can be submitted together');
  assert.equal((await batchResponse).status(), 200);
  await page.waitForFunction(() => document.querySelectorAll('#wb-chat .conversation-upload-tray [data-upload-id]').length === 0);
  check('twenty ready files sent together; twenty-first item rejected without an upload request');
  // Abort is an explicitly injected network failure, not a real backend error.
  const uploadPattern = '**/api/chat/conversations/*/uploads';
  await context.route(uploadPattern, route => route.abort());
  await chooseFiles([textFile('中断上传.txt')]); await itemNamed('中断上传.txt').locator('[data-action="retryUpload"]').waitFor();
  await context.unroute(uploadPattern); await itemNamed('中断上传.txt').locator('[data-action="retryUpload"]').click(); await waitReady('中断上传.txt');
  await clearTray(); check('interrupted XHR reports failure; explicit retry creates a new successful upload');
  // A controlled browser clock exercises the real expiry timer without waiting
  // 25 minutes. Backend files remain private and use their original timestamps.
  await chooseFiles([textFile('旧待发资料.pdf')]); await waitReady('旧待发资料.pdf');
  await page.clock.fastForward(25 * 60 * 1000 + 1000); await page.clock.resume();
  await itemNamed('旧待发资料.pdf').locator('[data-action="retryUpload"]').waitFor();
  assert.equal(await itemNamed('旧待发资料.pdf').getAttribute('data-upload-state'), 'expired');
  assert.equal(await page.locator('#wb-chat [data-action="send"]').isDisabled(), true);
  await itemNamed('旧待发资料.pdf').locator('[data-action="retryUpload"]').click(); await waitReady('旧待发资料.pdf');
  await clearTray(); check('real tray expiry timer under controlled browser time; explicit reupload restores readiness');
  // Pure attachment first send uses a persisted blank draft, then its canonical group.
  const draft = await fixture.request('/api/chat/drafts', { method: 'POST', body: { displayName: '仅附件首发' } }); assert.equal(draft.status, 201);
  await page.locator('#wb-chat [data-action="refresh"]').click();
  await page.locator(`#wb-chat [data-conversation-id="${draft.body.conversation.id}"]`).click();
  await chooseFiles([textFile('仅附件首发.txt')]); await waitReady('仅附件首发.txt'); assert.equal(await input().inputValue(), '');
  const pureRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/send'));
  const pureResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/send'));
  await page.locator('#wb-chat [data-action="send"]').click(); const pureBody = (await pureRequest).postDataJSON();
  assert.equal(pureBody.content, ''); assert.equal(pureBody.attachments.length, 1);
  const pure = await (await pureResponse).json(); assert.equal(pure.stored, true);
  await page.locator(`[data-message-id="${pure.messageId}"] .chat-attachment-name`).filter({ hasText: '仅附件首发.txt' }).waitFor();
  assert.equal(await trayItems().count(), 0); check('attachment-only first send migrates to canonical conversation and removes only sent files');
  // Metadata-only recovery must not replace neighboring chart/question DOM.
  await choose('other');
  const reportRecord = fixture.store.db.prepare('SELECT * FROM chat_attachments WHERE id=?').get(report.attachmentId);
  const reportPath = path.join(fixture.attachments.mediaDir, reportRecord.storage_name), reportBytes = fs.readFileSync(reportPath);
  fs.unlinkSync(reportPath); await choose('mixed');
  const mixedRoot = page.locator(`[data-message-id="${scenes.mixed.row.id}"]`);
  const reportCard = mixedRoot.locator('.chat-attachment').filter({ hasText: '布局评估.pdf' });
  assert.equal(await reportCard.locator('[data-action="downloadAttachment"]').count(), 0);
  await mixedRoot.locator('.conversation-question-other > summary').click();
  const editing = mixedRoot.locator('.chat-question-other textarea');
  await editing.fill('继续保留这里的编辑内容');
  const historyPattern = '**' + scenes.mixed.route + '/messages?*';
  const heldHistory = []; let resolveHistory; const historyStarted = new Promise(resolve => { resolveHistory = resolve; });
  await context.route(historyPattern, route => { heldHistory.push(route); resolveHistory(); });
  fs.writeFileSync(reportPath, reportBytes);
  await page.locator('#wb-chat [data-action="refreshMessages"]').click(); await bounded(historyStarted, 'mixed media recheck request did not start');
  await editing.focus(); await editing.evaluate(node => node.setSelectionRange(3, 3));
  await mixedRoot.evaluate(node => {
    const stream = document.querySelector('#wb-chat .chat-messages'), bounds = stream.getBoundingClientRect();
    const anchor = [...stream.querySelectorAll('[data-message-id]')].find(row => row.getBoundingClientRect().bottom > bounds.top && row.getBoundingClientRect().top < bounds.bottom);
    window.__attachmentRecovery = { row: node, input: node.querySelector('.chat-question-other textarea'), chart: window.Chart.getChart(node.querySelector('canvas')),
      anchor, top: anchor?.getBoundingClientRect().top, gap: stream.scrollHeight - stream.scrollTop - stream.clientHeight };
  });
  for (const route of heldHistory) await route.continue(); await context.unroute(historyPattern);
  await reportCard.locator('[data-action="downloadAttachment"]').waitFor();
  const recovery = await mixedRoot.evaluate(node => {
    const saved = window.__attachmentRecovery, stream = document.querySelector('#wb-chat .chat-messages'), input = node.querySelector('.chat-question-other textarea');
    return { sameRow: node === saved.row, sameInput: input === saved.input, sameChart: window.Chart.getChart(node.querySelector('canvas')) === saved.chart,
      focused: document.activeElement === input, value: input.value, caret: input.selectionStart, oldGap: saved.gap,
      gap: stream.scrollHeight - stream.scrollTop - stream.clientHeight, anchorOffset: saved.anchor?.getBoundingClientRect().top - saved.top };
  });
  assert.equal(recovery.sameRow, true); assert.equal(recovery.sameInput, true); assert.equal(recovery.sameChart, true);
  assert.equal(recovery.focused, true); assert.equal(recovery.value, '继续保留这里的编辑内容'); assert.equal(recovery.caret, 3);
  if (recovery.oldGap <= 2) assert.ok(recovery.gap <= 2); else assert.ok(Math.abs(recovery.anchorOffset) <= 2);
  measurements.push({ metadataRecovery: recovery }); check('attachment metadata recovery retains the same message, chart and focused question input with caret and viewport anchor');
  // Missing physical files recover through the existing bounded history recheck.
  await choose('states'); const priorMax = fixture.db.prepare('SELECT MAX(id) id FROM conversations').get().id;
  fs.writeFileSync(missingPath, missingBytes);
  await page.locator('#wb-chat [data-action="refreshMessages"]').click();
  await page.locator(`[data-message-id="${scenes.states.row.id}"] .chat-attachment`).filter({ hasText: '方案说明.pdf' }).locator('[data-action="downloadAttachment"]').waitFor();
  assert.equal(fixture.db.prepare('SELECT MAX(id) id FROM conversations').get().id, priorMax, 'recovery needs no new message');
  const downloadEvent = page.waitForEvent('download');
  await page.locator(`[data-message-id="${scenes.states.row.id}"] .chat-attachment`).filter({ hasText: '方案说明.pdf' }).locator('[data-action="downloadAttachment"]').click();
  const download = await downloadEvent; assert.equal(download.suggestedFilename(), '方案说明.pdf'); assert.equal(await download.failure(), null);
  await download.delete(); check('unavailable history media recovers without new C4 rows; real authorized download succeeds');
  // Real delayed and broken image events preserve the public page's reading
  // anchor or bottom pinning; the transport is held, not the product source.
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const position = () => page.locator('#wb-chat .chat-messages').evaluate(stream => {
    const bounds = stream.getBoundingClientRect();
    const anchor = [...stream.querySelectorAll('[data-message-id]')].find(node => node.getBoundingClientRect().bottom > bounds.top && node.getBoundingClientRect().top < bounds.bottom);
    return { id: anchor?.dataset.messageId, top: anchor?.getBoundingClientRect().top, gap: stream.scrollHeight - stream.scrollTop - stream.clientHeight };
  });
  for (const mode of ['reading-load', 'reading-error', 'bottom-load', 'older-load']) {
    const scene = mode === 'older-load' ? scenes.older : scenes.scroll;
    const pattern = `**/attachments/${scene.image.attachmentId}`;
    let heldImage, resolveImage; const started = new Promise(resolve => { resolveImage = resolve; });
    await context.route(pattern, route => { heldImage = route; resolveImage(); });
    await choose('other'); await choose(mode === 'older-load' ? 'older' : 'scroll');
    let beforeOlder = null;
    if (mode === 'older-load') {
      await page.locator('#wb-chat .chat-messages').evaluate(stream => { stream.scrollTop = 100; });
      const olderPattern = '**' + scene.route + '/messages?*';
      let olderRoute, resolveOlder; const olderStarted = new Promise(resolve => { resolveOlder = resolve; });
      await context.route(olderPattern, route => {
        const url = new URL(route.request().url());
        if (url.searchParams.get('direction') === 'before' && url.searchParams.has('cursor')) { olderRoute = route; resolveOlder(); }
        else return route.continue();
      });
      await page.locator('#wb-chat [data-action="loadOlder"]').click();
      await bounded(olderStarted, 'loading older history did not start its actual request');
      // Clicking an offscreen button legitimately scrolls it into view first.
      // Measure the product's restore baseline after that user interaction.
      beforeOlder = await position();
      await olderRoute.continue(); await context.unroute(olderPattern);
      await page.locator(`[data-message-id="${scene.imageRow.id}"]`).waitFor();
      const olderOffset = await page.locator(`[data-message-id="${beforeOlder.id}"]`).evaluate(node => node.getBoundingClientRect().top);
      assert.ok(Math.abs(olderOffset - beforeOlder.top) <= 2, 'loading older messages retains the first visible message pixel offset');
    }
    // The real component uses native loading=lazy. Enter its viewport to start
    // the image request, then move back to the chosen reading position before
    // releasing that request; no image source or loading property is rewritten.
    await page.locator(`[data-message-id="${scene.imageRow.id}"] .chat-attachment-image-content`).scrollIntoViewIfNeeded();
    const layoutDOM = await page.locator(`[data-message-id="${scene.imageRow.id}"]`).evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.messageId,
      media: [...node.querySelectorAll('.chat-attachment')].map(card => ({ state: card.dataset.attachmentState, text: card.textContent,
        image: card.querySelector('img') ? { src: card.querySelector('img').src, complete: card.querySelector('img').complete, naturalWidth: card.querySelector('img').naturalWidth, state: card.querySelector('.chat-attachment-image-frame')?.dataset.state } : null })) })));
    const layoutHistory = await fixture.request(scene.route + '/messages?tab=mine&limit=50&direction=before');
    const diagnostic = { mode, target: scene.imageRow.id, attachmentId: scene.image.attachmentId, dom: layoutDOM,
      requests: attachmentRequests, history: layoutHistory.body.items?.find(row => row.id === scene.imageRow.id)?.attachments || null };
    if (output) fs.writeFileSync(path.join(output, 'latest-layout-diagnostic.json'), JSON.stringify(diagnostic, null, 2));
    assert.equal(layoutDOM.length, 1, 'the delayed image message belongs to the actual mounted history page');
    assert.equal(layoutDOM[0].media.length, 1); assert.ok(layoutDOM[0].media[0].image?.src.endsWith('/attachments/' + scene.image.attachmentId), 'the mounted card requests the authorized attachment route: ' + JSON.stringify(diagnostic));
    await bounded(started, mode + ': the expected delayed image request did not reach the transport');
    console.log('Attachment browser image boundary: ' + mode);
    if (mode.startsWith('reading')) await page.locator('#wb-chat .chat-messages').evaluate(stream => {
      const anchor = stream.querySelectorAll('[data-message-id]')[8]; stream.scrollTop += anchor.getBoundingClientRect().top - stream.getBoundingClientRect().top + 10;
    });
    if (mode === 'bottom-load') await page.locator('#wb-chat .chat-messages').evaluate(stream => { stream.scrollTop = stream.scrollHeight; });
    if (beforeOlder) await page.locator('#wb-chat .chat-messages').evaluate((stream, anchor) => { stream.scrollTop += stream.querySelector(`[data-message-id="${anchor.id}"]`).getBoundingClientRect().top - anchor.top; }, beforeOlder);
    const before = await position(); assert.ok(before.id, 'the history viewport has a real visible message anchor');
    if (mode === 'reading-error') await heldImage.abort(); else await heldImage.continue();
    const expectedState = mode === 'reading-error' ? 'failed' : 'loaded';
    await page.locator(`[data-message-id="${scene.imageRow.id}"] .chat-attachment-image-frame[data-state="${expectedState}"]`).waitFor();
    await bounded(settle(), mode + ': animation frame did not settle');
    const after = await page.locator('#wb-chat .chat-messages').evaluate((stream, id) => ({
      top: stream.querySelector(`[data-message-id="${id}"]`)?.getBoundingClientRect().top,
      gap: stream.scrollHeight - stream.scrollTop - stream.clientHeight
    }), before.id);
    if (mode === 'bottom-load') assert.ok(after.gap <= 2, 'a delayed image retains bottom pinning');
    else assert.ok(Math.abs(after.top - before.top) <= 2, mode + ' retains the original message pixel offset');
    measurements.push({ imageLayout: mode, before, after }); await context.unroute(pattern);
  }
  check('delayed image load, image error, bottom pinning and loading older media preserve viewport position');
  const fallbackPage = await context.newPage();
  fallbackPage.on('pageerror', error => { if (!errors.length) errors.push(error.message); });
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    await fallbackPage.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await fallbackPage.goto(fixture.base + '/attachment-fallback?theme=' + theme);
    await fallbackPage.locator('#fallback[data-ready="true"]').waitFor();
    assert.equal(await fallbackPage.locator('img,button,a,canvas,input,select,textarea').count(), 0, 'a host without attachment renderer exposes no attachment authority');
    const fallbackText = await fallbackPage.locator('#fallback').innerText();
    assert.ok(fallbackText.includes('[图片] 工作台预览.png')); assert.ok(fallbackText.includes('[文件] 布局评估.pdf'));
    assert.ok(fallbackText.includes('建议保留清晰的主操作区')); assert.equal(fallbackText.includes(preview.attachmentId), false);
    if (output) { const filename = path.join(output, `no-renderer-${width}-${theme}.png`); await fallbackPage.screenshot({ path: filename }); shots.push(filename); }
  }
  await fallbackPage.close(); check('old renderer keeps readable neighboring content and media fallback without IDs or executable controls');
  // Read-only surfaces expose no attachment upload controls and APIs reject writes.
  await page.locator('#wb-chat [data-action="external"]').click();
  await page.locator(`#wb-chat [data-conversation-id="${externalId}"]`).click();
  assert.equal(await page.locator('#wb-chat [data-action="attach"]').count(), 0);
  assert.ok((await page.locator('#wb-chat').innerText()).includes('原渠道截图.png'));
  assert.equal((await page.locator('#wb-chat').innerText()).includes('/private/original'), false);
  assert.equal(await page.locator('#wb-chat .chat-attachment [data-action="downloadAttachment"]').count(), 0);
  const uploadsBeforeReadonlyDrop = uploads;
  const readonlyDrop = await page.locator('#wb-chat .chat-messages').evaluate(node => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['ignored'], '只读不上传.txt', { type: 'text/plain' }));
    const over = new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true });
    const drop = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
    node.dispatchEvent(over); node.dispatchEvent(drop); return { over: over.defaultPrevented, drop: drop.defaultPrevented };
  });
  assert.equal(readonlyDrop.over, true); assert.equal(readonlyDrop.drop, true); assert.equal(uploads, uploadsBeforeReadonlyDrop);
  fixture.setProxy(fixture); expectedHttpError = (url, status) => url.pathname.startsWith('/fleet/Remote/api/chat/') && status === 403;
  await page.goto(fixture.base + '/fleet/Remote/chat'); await page.locator('#wb-chat .conversation-blocked-notice').waitFor();
  assert.equal(await page.locator('#wb-chat [data-action="attach"]').count(), 0);
  expectedHttpError = null;
  const config = JSON.parse(fs.readFileSync(fixture.modePath, 'utf8')); fs.writeFileSync(fixture.modePath, JSON.stringify({ ...config, session_mode: 'single' }));
  await page.goto(fixture.base + '/chat'); await page.locator('#wb-chat [data-conversation-id]').first().waitFor(); await choose('mixed', { writable: false });
  assert.equal(await page.locator('#wb-chat [data-action="attach"]:visible').count(), 0);
  assert.equal((await fixture.request(scenes.mixed.route + '/uploads/config')).status, 403);
  check('external history, closed remote page and single mode provide no upload entry; single backend config rejects writes');
  // Fresh approved-prototype captures use the required 1280/390 matrix.
  if (prototypeSource && output) {
  const prototypePage = await context.newPage();
  prototypePage.on('pageerror', error => { if (!errors.length) errors.push('prototype: ' + error.message); });
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) for (const scene of ['attachments', 'attachment-states']) {
    await prototypePage.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await prototypePage.goto(fixture.base + `/approved-prototype.html?view=chat&cs=${scene}&theme=${theme}`);
    // The approved prototype recognizes its explicit scene parameter.
    await prototypePage.locator('.c-compose').waitFor();
    assert.ok(await prototypePage.locator('.chat-attachment').count(), 'the requested approved attachment scene is mounted');
    if (output) { const filename = path.join(output, `prototype-${scene}-${width}-${theme}.png`); await prototypePage.screenshot({ path: filename }); prototypeShots.push(filename); }
  }
  await prototypePage.close();
  }
  assert.deepEqual(errors, []);
  if (output) fs.writeFileSync(path.join(output, 'chat-attachments-browser.json'), JSON.stringify({ sourceHead: process.env.ZYLOS_CHAT_SOURCE_HEAD || null,
    sourceProductDigest: process.env.ZYLOS_CHAT_SOURCE_PRODUCT_DIGEST || null, isolation, shots, prototypeShots, checks, measurements, uploads, sends, reads, errors,
    prototype: 'd17ffdbfb94eb094a4f80d89edc1b48bf85ca166', prototypeSourceBlob: prototypeSource ? '77d676e8735904aa4c223e8d1d98551a9e7d3f37' : null,
    simulatedErrors: ['HTTP503 upload response injected for tray error screenshot', 'Network abort injected for upload interruption', 'Image request aborted to exercise shared image failure'],
    controlledTime: 'Browser clock advanced25minutes to exercise real tray expiry timer', base: fixture.base }, null, 2));
  t.diagnostic(`Attachment browser: ${shots.length} implementation screenshots, ${prototypeShots.length} approved-prototype screenshots, ${uploads} uploads, ${reads} history reads, no page errors`);
}
