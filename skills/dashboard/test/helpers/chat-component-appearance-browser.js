import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const schema = fileURLToPath(new URL('../../../comm-bridge/scripts/c4-content-schema.js', import.meta.url));
const fixture = fileURLToPath(new URL('./chat-component-appearance-fixture.js', import.meta.url));
// Resolve the already provisioned dependency; never install or access a live service.
const chart = fileURLToPath(new URL('./chart.umd.js', import.meta.resolve('chart.js')));
export async function runComponentAppearanceBrowser(sandbox, { width, theme }) {
  assert.ok([1280, 390].includes(width)); assert.ok(['light', 'dark'].includes(theme));
  const isolation = sandbox.assertIsolation();
  console.info('component browser isolation', JSON.stringify({ ...isolation,
    databasesUsed: false, tmuxUsed: false, backendUsed: false, address: '127.0.0.1:ephemeral' }));
  const html = `<!doctype html><html lang="zh" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  ${['css/style.css','themes/light.css','themes/dark.css','css/wb.css','css/wb-icons.css','css/conversation.css'].map(file => `<link rel="stylesheet" href="/${file}">`).join('')}
  <script src="/vendor/chart.umd.js"></script><script src="/js/chartjs-adapter-date-fns.bundle.min.js"></script>
  <style>body{margin:0}main.conversation-page{display:block;overflow:visible;height:auto;padding:16px}.conversation-message{margin-bottom:24px!important}</style>
  </head><body><button class="wb-btn wb-btn-primary" id="primary">发送</button><main class="conversation-page"></main><script type="module" src="/fixture.js"></script></body></html>`;
  const errors = [], outside = [], missing = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html); }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/api/chat/conversations/fixture/attachments/image') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#0f766e"/></svg>');
    }
    const file = url.pathname === '/chat-schema.js' ? schema : url.pathname === '/fixture.js' ? fixture
      : url.pathname === '/vendor/chart.umd.js' ? chart : path.resolve(publicDir, '.' + decodeURIComponent(url.pathname));
    if ((!file.startsWith(publicDir + path.sep) && ![schema, fixture, chart].includes(file)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      if (missing.length < 5) missing.push(url.pathname); res.writeHead(404); return res.end();
    }
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
  });
  let browser;
  try {
    const origin = await sandbox.startHttp(server);
    const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
    const profile = path.join(sandbox.paths.tmp, 'chrome-profile'); fs.mkdirSync(profile);
    const chrome = sandbox.startChild(process.env.ZYLOS_CHAT_BROWSER_BIN, [
      '--headless', '--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run',
      '--disable-dev-shm-usage', '--disable-crash-reporter', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
    ], { timeoutMs: 35_000, maxOutputBytes: 65_536 });
    const endpoint = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => { chrome.stderr.off('data', read); reject(new Error('Chrome debugging endpoint timed out')); }, 10_000);
      function read(chunk) {
        text = (text + chunk.toString()).slice(-8192);
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text);
        if (match) { clearTimeout(timer); chrome.stderr.off('data', read); resolve(match[1]); }
      }
      chrome.stderr.on('data', read);
      chrome.completion.then(result => { clearTimeout(timer); chrome.stderr.off('data', read); reject(new Error('Chrome exited: ' + result.code)); });
    });
    browser = await chromium.connectOverCDP(endpoint);
    sandbox.addCleanup(() => browser.close());
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN', timezoneId: 'UTC' });
    await context.route('**/*', route => {
      if (route.request().url().startsWith(origin + '/')) return route.continue();
      if (outside.length < 5) outside.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
    await page.goto(origin);
    try { await page.waitForFunction(() => window.componentFixtureReady === true); }
    catch (error) { throw new Error(error.message + '; errors=' + errors.join('; ') + '; missing=' + missing.join('; ')); }
    await page.locator('#image .chat-attachment-image-content').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('#image .chat-attachment-image-content').naturalWidth === 160 && document.querySelector('#tray .chat-attachment-image-content').naturalWidth === 160);
    await page.waitForFunction(() => document.querySelectorAll('.conversation-chart-enhanced').length === 10);
    await page.evaluate(() => document.fonts.ready);
    const failedImage = page.locator('#tray-failed-image');
    await failedImage.scrollIntoViewIfNeeded();
    const failedImageShot = await failedImage.screenshot({ animations: 'disabled', scale: 'css' });
    const failedImagePixel = await page.evaluate(async bytes => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], { type: 'image/png' }));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
      return [...context.getImageData(Math.floor(canvas.width / 2), 0, 1, 1).data];
    }, failedImageShot.toString('base64'));
    const output = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
    if (output) {
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, `tray-failed-image-${width}-${theme}.png`), failedImageShot);
      await page.locator('#columns').screenshot({ path: path.join(output, `columns-file-${width}-${theme}.png`), animations: 'disabled', scale: 'css' });
      for (const id of ['stack-view', 'markdown-first', 'card-ending', 'section-view', 'nested-section']) {
        await page.locator('#' + id).screenshot({ path: path.join(output, `${id}-${width}-${theme}.png`), animations: 'disabled', scale: 'css' });
      }
    }
    const actual = await page.evaluate(() => {
      const answer = document.querySelector('#answered .chat-question-answer'), list = document.querySelector('#answered .chat-choice-options');
      const dot = getComputedStyle(document.querySelector('#waiting .chat-question-status'), '::before');
      const chart = id => Chart.getChart(document.querySelector('#' + id + ' canvas'));
      const rgba = value => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d'); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
      const blend = (top, bottom) => { const a = top[3] / 255; return top.slice(0, 3).map((v, i) => v * a + bottom[i] * (1 - a)).concat(255); };
      const surface = node => !node ? [255, 255, 255, 255] : blend(rgba(getComputedStyle(node).backgroundColor), surface(node.parentElement));
      const luminance = color => color.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0);
      const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
      const textContrast = selector => { const n = document.querySelector(selector); return contrast(blend(rgba(getComputedStyle(n).color), surface(n)), surface(n)); };
      const checkbox = document.querySelector('#boolean input[type="checkbox"]');
      const selected = document.querySelector('#waiting input:checked').closest('.chat-question-option');
      const probe = document.createElement('span'); probe.style.backgroundColor = 'var(--accent)'; document.body.append(probe); const accent = getComputedStyle(probe).backgroundColor; probe.remove();
      const image = document.querySelector('#image .chat-attachment'), body = document.querySelector('#image .conversation-message-body');
      const trayFrame = document.querySelector('#tray .chat-attachment-image-frame'), trayImage = trayFrame.querySelector('img');
      const categoryGeometry = ['category-single', 'category-pair', 'category-reference'].map(id => {
        const c = chart(id), bars = c.getDatasetMeta(0).data, labels = c.scales.y.getLabelItems();
        return { id, count: bars.length, area: c.chartArea.bottom - c.chartArea.top,
          bars: bars.map(bar => ({ height: bar.height, y: bar.y })),
          labels: labels.map(item => ({ text: item.label, y: item.options.translation[1], height: item.font.lineHeight })),
        };
      });
      const spacing = Object.fromEntries(['stack-view', 'markdown-first', 'card-ending'].map(id => {
        const content = document.querySelector('#' + id + ' .chat-message-content');
        const stack = content.querySelector('.conversation-view-stack');
        const nodes = [...(stack || content).children].filter(node => node.classList.contains('chat-block'));
        const contentBox = content.getBoundingClientRect();
        const bounds = nodes.map(node => { const b = node.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; });
        return [id, { firstTopOffset: bounds[0].top - contentBox.top, lastBottomOffset: contentBox.bottom - bounds.at(-1).bottom,
          rowGap: stack ? parseFloat(getComputedStyle(stack).rowGap) : null,
          gaps: bounds.slice(1).map((b, i) => b.top - bounds[i].bottom), count: nodes.length }];
      }));
      const section = document.querySelector('#section-view .conversation-view-section');
      const sectionSlots = [...section.children];
      const sectionBodyBlocks = [...section.querySelector('.conversation-view-body').children];
      const blockBounds = sectionBodyBlocks.map(node => node.getBoundingClientRect());
      const slotBounds = sectionSlots.map(node => node.getBoundingClientRect());
      const sectionSpacing = { rowGap: parseFloat(getComputedStyle(section).rowGap), bodyCount: sectionBodyBlocks.length,
        bodyGaps: blockBounds.slice(1).map((box, i) => box.top - blockBounds[i].bottom),
        slotGaps: slotBounds.slice(1).map((box, i) => box.top - slotBounds[i].bottom),
        lastMargins: sectionSlots.map(slot => getComputedStyle(slot.lastElementChild).marginBottom),
      };
      const nestedSection = document.querySelector('#nested-section .conversation-view-section');
      const nestedBody = nestedSection.querySelector('.conversation-view-body');
      const nestedStack = nestedBody.lastElementChild;
      const nestedBlocks = [...nestedStack.children];
      const nestedBodyIntroBox = nestedBody.firstElementChild.getBoundingClientRect();
      const nestedStackBox = nestedStack.getBoundingClientRect();
      const nestedBounds = nestedBlocks.map(node => node.getBoundingClientRect());
      const nestedSpacing = { sectionGap: parseFloat(getComputedStyle(nestedSection).rowGap),
        bodyCount: nestedBody.children.length, stackIsLast: nestedStack.classList.contains('conversation-view-stack'),
        bodyGap: nestedStackBox.top - nestedBodyIntroBox.bottom,
        stackGap: parseFloat(getComputedStyle(nestedStack).rowGap), blockCount: nestedBlocks.length,
        blockGaps: nestedBounds.slice(1).map((box, i) => box.top - nestedBounds[i].bottom) };
      const columns = [...document.querySelector('#columns .conversation-view-columns').children].map(node => { const b = node.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, bottom: b.bottom }; });
      const errorStyles = Object.fromEntries(['ready', 'failed', 'expired'].map(state => {
        const item = document.querySelector('#tray-errors [data-upload-state="' + state + '"]'), status = item.querySelector('.chat-attachment-status'), style = getComputedStyle(item);
        return [state, { outline: style.outlineStyle, outlineWidth: style.outlineWidth, outlineOffset: style.outlineOffset,
          outlineColor: style.outlineColor, status: status.textContent, statusColor: getComputedStyle(status).color }];
      }));
      const dangerProbe = document.createElement('span'); dangerProbe.style.color = 'var(--c-danger-ink)'; document.querySelector('main').append(dangerProbe);
      const dangerInk = getComputedStyle(dangerProbe).color, dangerRgb = rgba(dangerInk); dangerProbe.remove();
      return { categoryGeometry, columns, spacing, sectionSpacing, nestedSpacing, errorStyles, dangerInk, dangerRgb, segmentHeights: [...document.querySelectorAll('#segmented .chat-form-segment')].map(node => node.getBoundingClientRect().height), answerText: answer.textContent, answerTop: answer.getBoundingClientRect().top, choicesTop: list.getBoundingClientRect().top,
        dotAnimation: dot.animationName, dotWidth: dot.width, categoryAxis: chart('category').options.scales.x.display,
        breakdownAxis: chart('breakdown').options.scales.x.display, categoryColor: chart('category').data.datasets[0].backgroundColor[0],
        imageRatio: document.querySelector('.chat-attachment-image-frame').style.aspectRatio,
        primary: getComputedStyle(document.querySelector('#primary')).backgroundColor, accent,
        checkboxChecked: checkbox.checked,
        checkboxCardContrast: contrast(surface(checkbox), surface(checkbox.closest('.chat-block'))),
        checkboxSelectedRowContrast: contrast(surface(checkbox), surface(selected)),
        primaryTextContrast: textContrast('#primary'), dangerTextContrast: textContrast('#danger .wb-btn-danger'),
        imageWidth: image.getBoundingClientRect().width, imageBodyWidth: body.getBoundingClientRect().width,
        availableColumnWidth: document.querySelector('#waiting .conversation-message-body').getBoundingClientRect().width,
        trayFrameHeight: trayFrame.getBoundingClientRect().height, trayImageHeight: trayImage.getBoundingClientRect().height,
        localFont: [...document.fonts].some(font => font.family === 'Inter' && font.status === 'loaded'),
        plainTextWidth: document.querySelector('#long-text .chat-message-text').getBoundingClientRect().width,
        attachedTextWidth: document.querySelector('#long-text-file .chat-message-text').getBoundingClientRect().width,
        attachedFileWidth: document.querySelector('#long-text-file .chat-attachment').getBoundingClientRect().width,
        markdownPlainTextWidth: document.querySelector('#markdown-only .chat-message-text').getBoundingClientRect().width,
        markdownFileTextWidth: document.querySelector('#markdown-file .chat-message-text').getBoundingClientRect().width,
        markdownFileBodyWidth: document.querySelector('#markdown-file .conversation-message-body').getBoundingClientRect().width,
        chartFileBodyWidth: document.querySelector('#markdown-chart-file .conversation-message-body').getBoundingClientRect().width,
        widths: [...document.querySelectorAll('.chat-block-choice,.chat-block-confirmation,.chat-block-form_intent,.chat-block-breakdown,.chat-block-category_series')].map(node => node.getBoundingClientRect().width),
        viewport: innerWidth, scroll: document.documentElement.scrollWidth };
    });
    console.info('rich spacing geometry', JSON.stringify({ width, theme, ...actual.spacing }));
    if (output) fs.writeFileSync(path.join(output, `spacing-${width}-${theme}.json`), JSON.stringify(actual.spacing, null, 2));
    console.info('section spacing geometry', JSON.stringify({ width, theme, ...actual.sectionSpacing }));
    if (output) fs.writeFileSync(path.join(output, `section-spacing-${width}-${theme}.json`), JSON.stringify(actual.sectionSpacing, null, 2));
    console.info('nested section spacing geometry', JSON.stringify({ width, theme, ...actual.nestedSpacing }));
    if (output) fs.writeFileSync(path.join(output, `nested-spacing-${width}-${theme}.json`), JSON.stringify(actual.nestedSpacing, null, 2));
    assert.equal(actual.nestedSpacing.bodyCount, 2, 'section body contains markdown followed by the final stack');
    assert.equal(actual.nestedSpacing.stackIsLast, true, 'nested stack is the final section body item');
    assert.equal(actual.nestedSpacing.blockCount, 2, 'nested stack contains markdown and a card');
    assert.ok(Math.abs(actual.nestedSpacing.bodyGap - actual.nestedSpacing.sectionGap) <= 1,
      'section markdown-to-stack spacing matches its section row gap: ' + JSON.stringify(actual.nestedSpacing));
    for (const gap of actual.nestedSpacing.blockGaps) {
      assert.ok(Math.abs(gap - actual.nestedSpacing.stackGap) <= 1,
        'nested stack spacing matches its own row gap: ' + JSON.stringify(actual.nestedSpacing));
    }
    assert.equal(actual.sectionSpacing.bodyCount, 3, 'section body keeps markdown, card and file');
    for (const gap of actual.sectionSpacing.bodyGaps) {
      assert.ok(Math.abs(gap - actual.sectionSpacing.rowGap) <= 1, 'section body spacing matches its row gap: ' + JSON.stringify(actual.sectionSpacing));
    }
    for (const gap of actual.sectionSpacing.slotGaps) {
      assert.ok(Math.abs(gap - actual.sectionSpacing.rowGap) <= 1, 'section slots keep their shared row gap');
    }
    assert.ok(actual.sectionSpacing.lastMargins.every(margin => margin === '0px'), 'last block in each section slot has no bottom margin');
    assert.equal(actual.spacing['stack-view'].count, 4, 'stack keeps markdown, card, markdown and file');
    for (const gap of actual.spacing['stack-view'].gaps) {
      assert.ok(Math.abs(gap - actual.spacing['stack-view'].rowGap) <= 1, 'stack spacing comes only from its row gap: ' + JSON.stringify(actual.spacing['stack-view']));
    }
    for (const id of ['stack-view', 'markdown-first']) {
      assert.ok(Math.abs(actual.spacing[id].firstTopOffset) <= 1, id + ' first block aligns with message content top');
    }
    assert.equal(actual.spacing['markdown-first'].gaps.length, 1, 'ordinary markdown and file remain adjacent');
    assert.ok(Math.abs(actual.spacing['markdown-first'].gaps[0] - 12) <= 1, 'ordinary markdown-to-file flow keeps its 12px gap');
    assert.ok(Math.abs(actual.spacing['card-ending'].lastBottomOffset) <= 1, 'last card aligns with message content bottom');
    actual.failedImagePixel = failedImagePixel;
    actual.pressed = await pressedContrast(page, context);
    assert.match(actual.answerText, /你的回答/); assert.match(actual.answerText, /LRU/);
    assert.ok(actual.answerTop < actual.choicesTop, 'accepted answer is visually before readonly options');
    assert.equal(actual.dotAnimation, 'none', 'waiting indicator remains static'); assert.equal(actual.dotWidth, '6px', 'waiting dot remains visible');
    assert.equal(actual.categoryAxis, false, 'category has no numeric axis'); assert.equal(actual.breakdownAxis, false, 'breakdown has no numeric axis');
    assert.equal(actual.categoryColor, '#e06b83', 'critical assessment uses rose');
    assert.equal(actual.imageRatio, '160 / 90', 'loaded image uses intrinsic aspect ratio');
    assert.equal(actual.localFont, true, 'shipped local Inter is loaded');
    assert.equal(actual.primary, theme === 'light' ? 'rgb(15, 118, 110)' : actual.accent, 'page primary follows its theme');
    assert.equal(actual.checkboxChecked, true, 'selected boolean marker is rendered');
    if (theme === 'dark') {
      assert.ok(actual.checkboxCardContrast >= 3, 'selected boolean fill contrasts with the card at least 3:1');
      assert.ok(actual.checkboxSelectedRowContrast >= 3, 'selected fill contrasts with selected rows at least 3:1');
    }
    assert.ok(actual.pressed.primary.ratio >= 4.5, 'primary pressed text meets AA');
    assert.ok(actual.pressed.question.ratio >= 4.5, 'question primary pressed text meets AA');
    assert.ok(actual.pressed.danger.ratio >= 4.5, 'danger pressed text meets AA');
    assert.ok(actual.primaryTextContrast >= 4.5, 'primary text meets AA');
    assert.ok(actual.dangerTextContrast >= 4.5, 'danger text meets AA');
    const expectedImageWidth = width === 1280 ? 480 : actual.availableColumnWidth;
    assert.ok(Math.abs(actual.imageWidth - expectedImageWidth) <= 1, 'short image filename does not shrink its card');
    assert.ok(Math.abs(actual.imageBodyWidth - expectedImageWidth) <= 1, 'attachment message owns a deterministic column');
    assert.ok(actual.trayFrameHeight > 0 && actual.trayFrameHeight <= 72, 'tray frame stays compact');
    assert.ok(actual.trayImageHeight > 0 && actual.trayImageHeight <= 72, 'tray image stays compact');
    assert.ok(Math.abs(actual.attachedTextWidth - actual.plainTextWidth) <= 1, 'adding a file preserves the full plain text width');
    assert.ok(Math.abs(actual.markdownFileTextWidth - actual.markdownPlainTextWidth) <= 1, 'markdown and file preserves the equivalent text width');
    if (width === 1280) {
      assert.equal(actual.plainTextWidth, 900, 'long plain text retains its maximum width');
      assert.equal(actual.attachedFileWidth, 480, 'mixed plain text keeps its file card width');
      assert.equal(actual.chartFileBodyWidth, 720, 'markdown chart and file share the rich content width');
    }
    for (const category of actual.categoryGeometry) {
      assert.ok(Math.abs(category.area - category.count * 34) <= .5, category.id + ' plot reserves a 34px row per category');
      assert.equal(category.labels.length, category.count, category.id + ' keeps every label');
      for (const bar of category.bars) assert.ok(Math.abs(bar.height - 20) <= .5, category.id + ' bars are 20px high');
      for (let i = 1; i < category.bars.length; i++) {
        assert.ok(Math.abs(Math.abs(category.bars[i].y - category.bars[i - 1].y) - 34) <= .5, category.id + ' centers use 34px pitch');
        assert.ok(Math.abs(category.labels[i].y - category.labels[i - 1].y) >= (category.labels[i].height + category.labels[i - 1].height) / 2, category.id + ' labels do not overlap');
      }
    }
    assert.equal(actual.columns.length, 3, 'all comparison columns rendered');
    if (width === 1280) {
      assert.ok(actual.columns.every(column => Math.abs(column.top - actual.columns[0].top) <= 1), 'wide comparison stays side by side');
      assert.ok(actual.columns[1].left > actual.columns[0].left && actual.columns[2].left > actual.columns[1].left, 'wide columns retain source order');
    } else {
      assert.ok(actual.segmentHeights.every(height => height >= 40), 'phone segments keep 40px touch targets');
      for (let i = 1; i < actual.columns.length; i++) assert.ok(Math.abs(actual.columns[i].top - actual.columns[i - 1].bottom - 12) <= 1, 'phone comparison keeps the shared 12px column gap');
    }
    for (const state of ['failed', 'expired']) {
      assert.notEqual(actual.errorStyles[state].outline, actual.errorStyles.ready.outline, state + ' tray error remains distinct from a ready item');
      assert.equal(actual.errorStyles[state].outline, 'solid', state + ' tray error has a solid outline above child backgrounds');
      assert.equal(actual.errorStyles[state].outlineWidth, '1px', state + ' error outline is one pixel');
      assert.equal(actual.errorStyles[state].outlineOffset, '-1px', state + ' error outline stays inside the card');
      assert.equal(actual.errorStyles[state].outlineColor, actual.dangerInk, state + ' error outline uses danger ink');
      assert.equal(actual.errorStyles[state].statusColor, actual.dangerInk, state + ' status text uses danger ink');
      assert.ok(actual.errorStyles[state].status, state + ' tray item retains the status text');
    }
    assert.ok(failedImagePixel.slice(0, 3).every((value, i) => Math.abs(value - actual.dangerRgb[i]) <= 12), 'failed image top-edge midpoint remains visible danger ink above its placeholder: ' + JSON.stringify({ pixel: failedImagePixel, expected: actual.dangerRgb }));
    assert.ok(actual.widths.every(value => value <= 720), 'rich cards stay within the shared width');
    assert.ok(actual.scroll <= width, 'no horizontal overflow');
    assert.equal(errors.length, 0, errors.join('; ')); assert.equal(outside.length, 0, outside.join('; ')); assert.equal(missing.length, 0, missing.join('; '));
    console.info('component appearance passed', JSON.stringify({ width, theme, ...actual }));
    await context.close();
  } finally {
    await browser?.close(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}

async function pressedContrast(page, context) {
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const selectors = { primary: '#primary', question: '#waiting [data-action="answer"]', danger: '#danger .wb-btn-danger' };
    for (const selector of Object.values(selectors)) {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['active'] });
    }
    await page.waitForTimeout(200);
    return await page.evaluate(selectors => {
      const rgba = value => { const c = document.createElement('canvas'); c.width = c.height = 1; const ctx = c.getContext('2d'); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
      const blend = (a, b) => { const opacity = a[3] / 255; return a.slice(0, 3).map((v, i) => v * opacity + b[i] * (1 - opacity)).concat(255); };
      const surface = node => !node ? [255, 255, 255, 255] : blend(rgba(getComputedStyle(node).backgroundColor), surface(node.parentElement));
      const luminance = rgb => rgb.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
      return Object.fromEntries(Object.entries(selectors).map(([key, selector]) => {
        const node = document.querySelector(selector), style = getComputedStyle(node), background = surface(node), foreground = blend(rgba(style.color), background);
        const a = luminance(foreground), b = luminance(background);
        return [key, { background, foreground, cssBackground: style.backgroundColor, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }];
      }));
    }, selectors);
  } finally { await cdp.detach(); }
}
