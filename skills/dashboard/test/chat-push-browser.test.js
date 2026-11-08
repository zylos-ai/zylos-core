import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChatSandbox, chatEnabled } from './helpers/chat-integration-harness.js';
import { createChatPushBrowserFixture } from './helpers/chat-push-browser-fixture.js';
import { startChatBrowser, until, pause } from './helpers/chat-push-browser-driver.js';

// Real Chrome + EventSource + authenticated HTTP + private SQLite writer/reader.
// Run for chat observer/stream/controller changes; unrelated model/runtime cases
// skip. Explicit gates, runner/case HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR and private
// socket/DB paths are read back before access. DB commit drives real observer
// invalidations, never direct event injection. t.after/abort own every resource.
const enabled = chatEnabled() && !!process.env.ZYLOS_CHAT_BROWSER_BIN;
async function settledControls(page) {
  const read = () => page.evaluate(`({readEnabled:document.querySelector('[data-action="refreshMessages"]')?.disabled===false,statusEnabled:document.querySelector('[data-action="refreshStatus"]')?.disabled===false,listSettled:document.querySelector('.conversation-list-notice')?.hidden===true})`);
  await until(async () => Object.values(await read()).every(Boolean), 'both retained manual controls are enabled and the nonempty list has finished loading', 2000);
  const controls = await read();
  assert.equal(controls.readEnabled, true); assert.equal(controls.statusEnabled, true); assert.equal(controls.listSettled, true);
  return controls;
}

for (const locale of ['en', 'zh']) for (const width of [1280, 390]) {
  test(`chat pushes committed delivery and replies while preserving reading state in ${locale} at ${width}`, {
    skip: !enabled, timeout: 45000,
  }, async t => {
    const sandbox = createChatSandbox(t);
    const fixture = await createChatPushBrowserFixture(sandbox);
    t.after(() => { if (t.signal.aborted) console.info('browser fixture requests on abort', JSON.stringify(fixture.requests.slice(-20))); });
    const browser = await startChatBrowser(t, sandbox, fixture.origin);
    const page = await browser.page({ locale, width });
    const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR && path.join(process.env.ZYLOS_CHAT_EVIDENCE_DIR, `${locale}-${width}`);
    if (evidence) fs.mkdirSync(evidence, { recursive: true });
    const screenshot = async name => { await settledControls(page); if (evidence) await page.screenshot(path.join(evidence, name + '.png')); };
    await until(() => page.evaluate(`document.querySelector('.conversation-push-status')?.dataset.streamState==='live'`), 'chat_ready makes stream healthy', 5000);
    await until(() => page.evaluate(`!!document.querySelector('[data-message-id="${fixture.pendingId}"] [data-delivery-state="pending"]')`), 'pending message visible');
    await screenshot('pending');
    const update = fixture.deliverAndReply('New AI reply from a committed row. / 数据提交后的新 AI 回复。');
    await until(() => page.evaluate(`!!document.querySelector('[data-message-id="${update.pendingId}"] [data-delivery-state="delivered"]') && !!document.querySelector('[data-message-id="${update.id}"]')`), 'committed delivery and reply render within two seconds', 2000);
    const latencyMs = Date.now() - update.committedAt;
    assert.ok(latencyMs <= 2000);
    await screenshot('delivered-reply');
    await page.evaluate(`(()=>{const stream=document.querySelector('.conversation-stream');stream.scrollTop=0;const input=document.querySelector('textarea.conversation-input');input.value='Unsent draft / 未发送草稿';input.dispatchEvent(new Event('input',{bubbles:true}));window.keptInput=input;const form=document.querySelector('.chat-question-fields input[type="text"]');if(form){form.value='Unsubmitted form';form.dispatchEvent(new Event('input',{bubbles:true}));window.keptForm=form;}input.focus();window.readingTop=stream.scrollTop;})()`);
    assert.equal(await page.evaluate('!!window.keptForm'), true, 'an actual unsubmitted form is available');
    const unread = fixture.addReply('A reply while reading older history. / 阅读旧消息时收到回复。');
    await until(() => page.evaluate(`!!document.querySelector('[data-message-id="${unread.id}"]') && !document.querySelector('[data-action="latest"]').hidden`), 'new reply is shown with unread notice', 2000);
    const retained = await page.evaluate(`({input:document.querySelector('textarea.conversation-input')===window.keptInput,value:window.keptInput.value,focus:document.activeElement===window.keptInput,form:document.querySelector('.chat-question-fields input[type="text"]')===window.keptForm,formValue:window.keptForm.value,scroll:Math.abs(document.querySelector('.conversation-stream').scrollTop-window.readingTop)})`);
    assert.equal(retained.input, true); assert.equal(retained.value, 'Unsent draft / 未发送草稿');
    assert.equal(retained.focus, true); assert.equal(retained.form, true); assert.equal(retained.formValue, 'Unsubmitted form');
    assert.ok(retained.scroll <= 5, 'reading anchor remains at older history');
    await screenshot('unread');
    fixture.interrupt();
    await until(() => page.evaluate(`document.querySelector('.conversation-push-status')?.dataset.streamState==='polling'`), 'stream disconnect immediately restores polling', 2000);
    await screenshot('polling-fallback');
    const missed = fixture.addReply('Catch up after a disconnected stream. / 断线后补拉回复。');
    await pause(250); fixture.recover();
    await until(() => page.evaluate(`!!document.querySelector('[data-message-id="${missed.id}"]') && document.querySelector('.conversation-push-status')?.dataset.streamState==='live'`), 'ready after reconnect catches missed database changes', 5000);
    let twoTabs = false, hiddenCatchup = false;
    if (locale === 'en' && width === 1280) {
      const second = await browser.page({ locale, width });
      await second.front();
      await until(() => second.evaluate(`document.querySelector('.conversation-push-status')?.dataset.streamState==='live'`), 'second tab is independently subscribed', 5000);
      assert.equal(fixture.observer.subscriptions.size, 2, 'two tabs share one observer');
      assert.ok(fixture.observer.timer !== null);
      const pageId = await page.evaluate('window.pageId');
      await until(() => page.evaluate('document.visibilityState===\'hidden\''), 'background tab is natively hidden', 2000);
      const readsBefore = fixture.requests.filter(row => row.page === pageId).length;
      const hidden = fixture.addReply('Update while first tab is hidden. / 隐藏页期间的新回复。');
      await until(() => second.evaluate(`!!document.querySelector('[data-message-id="${hidden.id}"]')`), 'second tab receives the same committed change', 2000);
      await pause(550);
      assert.equal(fixture.requests.filter(row => row.page === pageId).length, readsBefore, 'hidden page records dirty without automatic GET');
      await page.front();
      await until(() => page.evaluate(`document.visibilityState==='visible' && !!document.querySelector('[data-message-id="${hidden.id}"]')`), 'foreground tab catches up immediately', 2000);
      twoTabs = hiddenCatchup = true;
      await second.evaluate('window.dispose()');
    }
    const controls = await settledControls(page);
    const layout = await page.evaluate('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})');
    assert.ok(layout.scrollWidth <= layout.width, 'no horizontal page overflow');
    for (const event of fixture.events) assert.ok(Object.keys(event.data).every(key => ['version','tab','conversationId','ids'].includes(key)), 'SSE carries only scoped invalidation metadata');
    assert.equal(browser.errors.length, 0); assert.equal(browser.external.length, 0);
    assert.equal(fixture.requests.some(row => row.method !== 'GET'), false, 'readback does not resend or mutate');
    const result = { locale, width, height: 900, latencyMs, twoTabs, hiddenCatchup, retained, layout, controls,
      databaseRows: fixture.writer.prepare('SELECT COUNT(*) AS n FROM conversations').get().n,
      events: fixture.events.map(({ name, data }) => ({ name, data })), requests: fixture.requests,
      browserErrors: browser.errors, externalRequests: browser.external,
      boundary: 'Real Chrome DOM/EventSource/fetch + AuthGate/ChatHistory/change observer/SseHub + independent private SQLite writer; fixture shell and question lifecycle, no model/PM2/tmux' };
    if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.info('chat push browser result', JSON.stringify({ locale, width, latencyMs, twoTabs, hiddenCatchup, requests: fixture.requests.length, events: fixture.events.length }));
    await page.evaluate('window.dispose()');
    await browser.close();
    await sandbox.close();
  });
}


// Actual old producer, loaded natively from an unchanged Git snapshot outside
// the repository. Run only when explicitly supplied; no source rewriting/eval.
test('an old stream producer remains connected while current chat uses polling fallback', {
  skip: !enabled || !process.env.ZYLOS_CHAT_OLD_SSE_SOURCE, timeout: 15000,
}, async t => {
  const filename = process.env.ZYLOS_CHAT_OLD_SSE_SOURCE;
  assert.ok(path.isAbsolute(filename));
  const { SseHub: LegacyHub } = await import(pathToFileURL(filename).href);
  const sandbox = createChatSandbox(t);
  const fixture = await createChatPushBrowserFixture(sandbox, { legacyHub: LegacyHub });
  const browser = await startChatBrowser(t, sandbox, fixture.origin);
  const page = await browser.page({ locale: 'en', width: 1280 });
  await until(() => page.evaluate(`document.querySelector('.conversation-push-status')?.dataset.streamState==='polling'`), 'old producer lacks ready and keeps polling after three seconds', 5000);
  const streamsBefore = fixture.requests.filter(row => row.path === '/api/stream').length;
  assert.equal(fixture.hub.clients.size, 1, 'one active stream is retained');
  await pause(1000);
  assert.equal(fixture.requests.filter(row => row.path === '/api/stream').length, streamsBefore, 'no reconnect to negotiate an old producer while scope is unchanged');
  assert.equal(fixture.observer.subscriptions.size, 0, 'old producer never opts into chat detection');
  await settledControls(page);
  const update = fixture.deliverAndReply('Current chat catches up through polling from an old producer.');
  await until(() => page.evaluate(`!!document.querySelector('[data-message-id="${update.pendingId}"] [data-delivery-state="delivered"]') && !!document.querySelector('[data-message-id="${update.id}"]')`), 'old producer fallback reads committed truth', 6000);
  const latencyMs = Date.now() - update.committedAt;
  assert.ok(latencyMs <= 6000);
  await until(() => page.evaluate(`document.querySelector('.conversation-push-status').dataset.streamState==='polling'`), 'terminal delivery retains old-producer polling fallback', 3500);
  const streamsAfter = fixture.requests.filter(row => row.path === '/api/stream').length;
  assert.equal(streamsAfter, streamsBefore, 'pending and terminal delivery do not rebuild the stream');
  assert.equal(fixture.hub.clients.size, 1);
  await pause(1000);
  assert.equal(fixture.requests.filter(row => row.path === '/api/stream').length, streamsAfter);
  assert.equal(browser.errors.length, 0); assert.equal(browser.external.length, 0);
  const controls = await settledControls(page);
  const result = { latencyMs, streamsBefore, streamsAfter, activeStreams: 1, controls, oldProducerReady: false, polling: true,
    requests: fixture.requests, browserErrors: browser.errors, externalRequests: browser.external,
    boundary: 'Unchanged legacy SseHub source loaded by native import; real current browser frontend, private SQLite writer and history HTTP routes; no model/PM2/tmux' };
  if (process.env.ZYLOS_CHAT_EVIDENCE_DIR) {
    const evidence = path.join(process.env.ZYLOS_CHAT_EVIDENCE_DIR, 'old-producer');
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    await page.screenshot(path.join(evidence, 'polling-fallback.png'));
  }
  console.info('old stream browser result', JSON.stringify({ latencyMs, streamsBefore, streamsAfter, activeStreams: 1, polling: true }));
  await page.evaluate('window.dispose()');
  await browser.close(); await sandbox.close();
});

test('four user sends and delivery transitions retain the same conversation stream', {
  skip: !enabled, timeout: 20000,
}, async t => {
  const sandbox = createChatSandbox(t);
  const fixture = await createChatPushBrowserFixture(sandbox);
  const browser = await startChatBrowser(t, sandbox, fixture.origin);
  const page = await browser.page({ locale: 'en', width: 1280 });
  await until(() => page.evaluate(`document.querySelector('.conversation-push-status')?.dataset.streamState==='live'`), 'initial ready', 5000);
  await settledControls(page);
  const before = fixture.requests.filter(row => row.path === '/api/stream').length;
  for (let i = 0; i < 4; i++) {
    const previousPendingId = fixture.currentPendingId();
    await page.evaluate(`(()=>{const input=document.querySelector('textarea.conversation-input');input.value='User send ${i}';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-action="send"]').click();})()`);
    await until(() => fixture.requests.filter(row => row.method === 'POST').length === i + 1 && fixture.currentPendingId() !== previousPendingId, 'one user POST per send');
    const id = fixture.currentPendingId();
    await until(() => page.evaluate(`!!document.querySelector('[data-message-id="${id}"]') && !document.querySelector('textarea.conversation-input').disabled`), 'sent row read back');
    const update = fixture.deliverAndReply('Reply to user send ' + i);
    await until(() => page.evaluate(`!!document.querySelector('[data-message-id="${id}"] [data-delivery-state="delivered"]') && !!document.querySelector('[data-message-id="${update.id}"]')`), 'delivery and reply from committed rows', 2000);
    assert.equal(fixture.requests.filter(row => row.path === '/api/stream').length, before, 'same-scope send and completion never reconnect');
  }
  assert.equal(fixture.requests.filter(row => row.method === 'POST').length, 4);
  assert.equal(fixture.hub.clients.size, 1);
  assert.equal(browser.errors.length, 0); assert.equal(browser.external.length, 0);
  console.info('chat stable stream browser result', JSON.stringify({ sends: 4, streamsBefore: before, streamsAfter: before, active: 1 }));
  await page.evaluate('window.dispose()'); await browser.close(); await sandbox.close();
});

for (const status of [503, 401]) test(`stream ${status} reconnect attempts preserve normal polling deadlines`, {
  skip: !enabled, timeout: 15000,
}, async t => {
  const sandbox = createChatSandbox(t);
  const fixture = await createChatPushBrowserFixture(sandbox);
  const browser = await startChatBrowser(t, sandbox, fixture.origin);
  const page = await browser.page({ locale: 'en', width: 1280 });
  await until(() => page.evaluate(`document.querySelector('.conversation-push-status')?.dataset.streamState==='live'`), 'initial ready', 5000);
  await settledControls(page);
  const disconnectedAt = Date.now(); fixture.interrupt(status);
  await until(() => page.evaluate(`document.querySelector('.conversation-push-status')?.dataset.streamState==='polling'`), 'disconnect restores polling', 2000);
  await pause(3000);
  const update = fixture.deliverAndReply('Reply while stream repeatedly fails ' + status);
  await until(() => page.evaluate(`!!document.querySelector('[data-message-id="${update.id}"]') && !!document.querySelector('[data-message-id="${update.pendingId}"] [data-delivery-state="delivered"]')`), 'polling reads despite frequent failing reconnects', 3000);
  const elapsedMs = Date.now() - disconnectedAt;
  assert.ok(elapsedMs <= 6000, 'normal fallback is not deferred beyond its five-second cadence plus browser tolerance');
  assert.ok(fixture.requests.filter(row => row.path === '/api/stream').length >= 3, 'reconnect status churn really occurred');
  assert.equal(fixture.requests.some(row => row.method !== 'GET'), false);
  assert.equal(browser.errors.length, 0); assert.equal(browser.external.length, 0);
  console.info('chat outage browser result', JSON.stringify({ status, elapsedMs, commitToDomMs: Date.now() - update.committedAt }));
  await page.evaluate('window.dispose()'); await browser.close(); await sandbox.close();
});

test('an unavailable chat database preserves ordinary stream events and polling recovery', {
  skip: !enabled, timeout: 15000,
}, async t => {
  const sandbox = createChatSandbox(t);
  const fixture = await createChatPushBrowserFixture(sandbox);
  const browser = await startChatBrowser(t, sandbox, fixture.origin);
  const page = await browser.page({ locale: 'en', width: 1280 });
  await until(() => page.evaluate(`document.querySelector('.conversation-push-status')?.dataset.streamState==='live'`), 'initial ready', 5000);
  await settledControls(page);
  const streams = fixture.requests.filter(row => row.path === '/api/stream').length;
  fixture.takeDatabaseOffline();
  await until(() => page.evaluate(`document.querySelector('.conversation-push-status')?.dataset.streamState==='polling'`), 'chat_unavailable restores polling without closing the application stream', 2000);
  assert.equal(fixture.observer.subscriptions.size, 0);
  assert.equal(fixture.hub.clients.size, 1, 'ordinary application stream remains connected');
  assert.equal(fixture.hub.chatClients.size, 0, 'demotion releases chat capacity');
  fixture.hub.broadcast('state_change', { state: 'waiting' });
  await until(() => page.evaluate('(window.ordinaryEvents||0)>0'), 'ordinary event is still received');
  await pause(1200);
  assert.equal(fixture.requests.filter(row => row.path === '/api/stream').length, streams, 'chat failure does not reconnect the EventSource');
  fixture.restoreDatabase();
  const update = fixture.addReply('Reply recovered through polling after the private database returns.');
  await until(() => page.evaluate(`!!document.querySelector('[data-message-id="${update.id}"]')`), 'fallback reads truth after database restoration', 6000);
  assert.equal(fixture.requests.filter(row => row.path === '/api/stream').length, streams);
  assert.equal(browser.errors.length, 0); assert.equal(browser.external.length, 0);
  assert.equal(fixture.requests.some(row => row.method !== 'GET'), false);
  console.info('chat unavailable browser result', JSON.stringify({ streamsBefore: streams, streamsAfter: streams, activeOrdinary: 1, chatSubscriptions: 0, ordinaryReceived: true, pollingRecovered: true }));
  await page.evaluate('window.dispose()'); await browser.close(); await sandbox.close();
});
