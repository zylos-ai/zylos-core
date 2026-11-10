import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Store } from '../src/lib/store.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { hashPassword } from '../src/lib/auth.js';
import { migrateSchema } from '../../comm-bridge/scripts/c4-migrations.js';
import { migrateToV2 } from '../../comm-bridge/scripts/c4-migrations-v2.js';
import { createChatSandbox, chatEnabled } from './helpers/chat-integration-harness.js';
import { startChatBrowser, until } from './helpers/chat-push-browser-driver.js';

const enabled = chatEnabled() && !!process.env.ZYLOS_CHAT_BROWSER_BIN;
const helper = fileURLToPath(new URL('./helpers/chat-after-reply-server.js', import.meta.url));
const group = 'dashboard-after-reply:private';
const conversation = 'g:' + Buffer.from(group).toString('hex').toUpperCase();

async function fixture(t, locale, width, { beforeSteps = true, running = false, interjection = false } = {}) {
  const sandbox = createChatSandbox(t);
  console.info('after-reply browser targets', JSON.stringify(sandbox.assertIsolation()));
  const db = sandbox.openDatabase(sandbox.paths.c4Db, filename => new Database(filename));
  migrateSchema(db, { isNew: true }); migrateToV2(db);
  db.prepare('INSERT INTO channel_namespaces VALUES (?,?)').run('dashboard-after-reply', 'dashboard');
  const start = Date.now() - (running ? 30000 : 120000);
  const at = seconds => new Date(start + seconds * 1000).toISOString();
  const insert = db.prepare(`INSERT INTO conversations (id,timestamp,direction,channel,endpoint_id,session_group,content,status)
    VALUES (?, ?, ?, 'dashboard','private', ?, ?, 'delivered')`);
  insert.run(1, at(0), 'in', group, locale === 'zh' ? '请整理这次演示的结果。' : 'Please summarize the demo results.');
  insert.run(2, at(10), 'out', group, !beforeSteps ? '演示已完成。' : locale === 'zh' ? '演示已完成。图表和结果已经准备好，可以继续查看。' : 'The demo is complete. The chart and results are ready to review.');
  if (interjection) insert.run(3, at(12), 'in', group, '谢谢，顺便把日志也存一下');
  const store = sandbox.openDatabase(sandbox.paths.dashboardDb, filename => new Store(filename));
  const conversations = new ChatConversations({ store, idGenerator: () => 'private' });
  conversations.create(); conversations.bind('private', 'dashboard-after-reply'); conversations.markCommitted('private', { id: 1 });
  const event = (type, seconds, metadata = {}) => store.insertEvent({ id: crypto.randomUUID(), ingest_id: crypto.randomUUID(),
    timestamp: at(seconds), runtime: 'codex', session_id: 'private-after-reply-session', session_group: group,
    run_id: 'private-after-reply-run', event_type: type, category: 'test', summary: null, metadata, source: 'test' });
  event('user_prompt_submit', 0); event('deliver', 0.2, { conversation_id: 1 });
  if (beforeSteps) {
    event('tool_call', 1, { call_id: 'before', tool_name: 'Read', tool_detail: 'demo-notes.md' });
    event('tool_result', 3, { call_id: 'before', tool_name: 'Read' });
  }
  if (interjection) event('deliver', 12.2, { conversation_id: 3 });
  event('tool_call', interjection ? 13 : 11, { call_id: 'after', tool_name: 'exec_command' });
  if (!running) {
    event('tool_result', interjection ? 18 : 16, { call_id: 'after', tool_name: 'exec_command', outcome: 'failed' });
    event('stop', interjection ? 18 : 16);
  }
  fs.writeFileSync(path.join(sandbox.paths.zylos, 'components/dashboard/config.json'), JSON.stringify({ auth: { enabled: true, password: hashPassword('private-after-reply-password') } }));
  fs.mkdirSync(path.join(sandbox.paths.zylos, '.zylos'));
  fs.writeFileSync(path.join(sandbox.paths.zylos, '.zylos/config.json'), JSON.stringify({ session_mode: 'multi', runtime: 'codex' }));
  fs.writeFileSync(path.join(sandbox.paths.zylos, '.env'), 'TZ=Asia/Shanghai\n');
  const bin = path.join(sandbox.root, 'bin'); fs.mkdirSync(bin);
  for (const command of ['zylos', 'claude', 'codex']) fs.writeFileSync(path.join(bin, command), '#!/bin/sh\ncase "$1" in\n--version) printf "1.0.0\\n";;\nsession-mode) printf \'{"ok":true,"data":{"sessionMode":"multi"}}\\n\';;\nstatus) printf \'{"runtime":"codex","status":"stopped"}\\n\';;\n*) exit 1;;\nesac\n', { mode: 0o700 });
  for (const command of ['tmux', 'pm2']) fs.writeFileSync(path.join(bin, command), '#!/bin/sh\nprintf "forbidden runtime access\\n" >&2\nexit 1\n', { mode: 0o700 });
  const child = sandbox.startChild(process.execPath, [helper], { timeoutMs: 45000,
    env: { PATH: bin + ':/usr/bin:/bin', ZYLOS_CHAT_CASE_ROOT: sandbox.root, TMUX: sandbox.paths.socket + ',0,0' } });
  let output = '', origin, protocolError;
  child.stdout.on('data', data => {
    output += data.toString();
    if (output.length >= 65536) { protocolError = 'child protocol bound exceeded'; child.kill('SIGKILL'); return; }
    let newline;
    while ((newline = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, newline); output = output.slice(newline + 1);
      if (line.startsWith('after-reply child isolation ')) console.info(line);
      try { if (line.startsWith('after-reply-server-ready ')) origin = JSON.parse(line.slice('after-reply-server-ready '.length)).origin; }
      catch { protocolError = 'invalid child protocol'; child.kill('SIGKILL'); return; }
    }
  });
  await until(() => protocolError || origin || child.exitCode !== null, 'real Dashboard HTTP server starts', 10000);
  assert.equal(protocolError, undefined); assert.ok(origin);
  const browser = await startChatBrowser(t, sandbox, origin, { expectedBlockedHosts: ['fonts.googleapis.com'] });
  const page = await browser.page({ width, pathname: '/login', ready: '!!document.querySelector("input[name=password]")' });
  await page.evaluate(`localStorage.setItem('zylos-dashboard-locale',${JSON.stringify(locale)});document.querySelector('input[name=password]').value='private-after-reply-password';document.querySelector('form').submit()`);
  await until(() => page.evaluate('document.querySelector("#wb-chat")?.children.length>0'), 'full app mounts the real conversation page', 10000);
  await page.evaluate('document.querySelector(".tab[data-tab=chat]").click()');
  await until(() => page.evaluate(`!!document.querySelector('[data-conversation-id="${conversation}"]')`), 'seeded conversation is listed', 5000);
  await page.evaluate(`document.querySelector('[data-conversation-id="${conversation}"]').click()`);
  return { sandbox, browser, page, finish() {
    const end = (Date.now() - start) / 1000;
    event('tool_result', end, { call_id: 'after', tool_name: 'exec_command', outcome: 'failed' });
    event('stop', end);
  } };
}

async function screenshot(page, name) {
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (!evidence) return;
  fs.mkdirSync(evidence, { recursive: true });
  await page.screenshot(path.join(evidence, name + '.png'));
}

async function checkBrowser(f) {
  assert.equal(await f.page.evaluate('!!document.querySelector(".chat-error:not([hidden])")'), false, 'the real app has no conversation error banner');
  assert.equal(f.browser.errors.length, 0, JSON.stringify(f.browser.errors));
  assert.equal(f.browser.external.length, 0, JSON.stringify(f.browser.external));
}

async function clickHead(f, selector, width = 1280) {
  const box = await f.page.evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
  if (width === 390) {
    await f.page.call('Emulation.setTouchEmulationEnabled', { enabled: true });
    await f.page.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [box] });
    await f.page.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await f.page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...box, button: 'left', clickCount: 1 });
    await f.page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...box, button: 'left', clickCount: 1 });
  }
}

const reply = '[data-message-id="2"]';
const tail = reply + ' .conversation-activity-after-reply';

// Full createServer/app.js, real authenticated history/activity routes and
// private C4 + runtime_events: no mocked activity response or browser rendering.
// Run these four cases for after-reply placement/toggle/CSS/locale changes;
// unrelated backend/runtime work may skip. Official runner and case readbacks
// prove HOME/ZYLOS_DIR/PM2_HOME, short TMPDIR, private socket/DB/profile paths.
// Runtime CLI is refused or fixture-only; outside browser requests are blocked.
// Lifecycle/abort owns service/Chrome groups, DBs and roots on every exit path.
for (const locale of ['zh', 'en']) for (const width of [1280, 390]) {
  test(`reply follow-up activity stays under the reply and opens its failed step in ${locale} at ${width}`, { skip: !enabled, timeout: 35000 }, async t => {
    const f = await fixture(t, locale, width);
    await until(() => f.page.evaluate(`!!document.querySelector('${tail}')`), 'completed tail is attached inside the loaded reply', 5000);
    await checkBrowser(f);
    const layout = await f.page.evaluate(`(()=>{const article=document.querySelector('${reply}'),area=article.querySelector('.conversation-activity-after-reply'),button=area.querySelector('button'),before=article.querySelector('.conversation-activity-slot:not(.conversation-activity-after-reply-slot) button'),content=article.querySelector('.chat-message-content'),b=button.getBoundingClientRect(),c=content.getBoundingClientRect(),a=before.getBoundingClientRect(),style=getComputedStyle(button),oldStyle=getComputedStyle(before);return {articles:document.querySelectorAll('article.chat-out').length,empty:document.querySelectorAll('article.conversation-activity-message').length,text:button.textContent,height:b.height,width:b.width,x:b.x,y:b.y,contentX:c.x,beforeX:a.x,textX:button.querySelector('span').getBoundingClientRect().x,beforeTextX:before.querySelector('span').getBoundingClientRect().x,paddingLeft:style.paddingLeft,beforePaddingLeft:oldStyle.paddingLeft,marginTop:style.marginTop,marginBottom:style.marginBottom,afterBody:!!(content.compareDocumentPosition(area)&Node.DOCUMENT_POSITION_FOLLOWING),collapsed:button.getAttribute('aria-expanded')==='false'};})()`);
    assert.equal(layout.articles, 1); assert.equal(layout.empty, 0); assert.equal(layout.afterBody, true); assert.equal(layout.collapsed, true);
    assert.match(layout.text, locale === 'zh' ? /回复后又处理.*6 秒.*1 步/ : /Worked 6 s more after replying.*1 step$/i);
    assert.ok(Math.abs(layout.x - layout.contentX) <= 10, 'follow-up line aligns with the reply body');
    assert.ok(Math.abs(layout.x - layout.beforeX) <= 0.5, 'both activity hover areas share the same left edge');
    assert.ok(Math.abs(layout.textX - layout.beforeTextX) <= 0.5, 'both activity texts share the same left edge');
    assert.equal(layout.paddingLeft, layout.beforePaddingLeft, 'follow-up hover padding matches the original activity line');
    if (width === 390) {
      assert.ok(layout.height >= 40 && layout.width >= 40, 'phone toggle offers at least a 40px touch target');
      assert.equal(layout.marginTop, '0px', 'follow-up touch region does not overlap the reply above');
      assert.equal(layout.marginBottom, '0px', 'follow-up touch region does not overlap the row below');
    }
    await screenshot(f.page, `${locale}-${width}`);
    await clickHead(f, tail + ' button', width);
    await until(() => f.page.evaluate(`document.querySelector('${tail} button')?.getAttribute('aria-expanded')==='true'`), 'real pointer click expands follow-up steps');
    const failed = await f.page.evaluate(`document.querySelector('${tail} [data-status=failed]')?.textContent`);
    assert.match(failed, locale === 'zh' ? /出错.*5 秒/ : /Error.*5 s/i);
    await screenshot(f.page, `${locale}-${width}-expanded`);
    await f.page.evaluate(`document.querySelector('${reply} .conversation-activity-slot button').click()`);
    await until(() => f.page.evaluate(`!!document.querySelector('${reply} .conversation-activity-slot [data-status=done]')`), 'original folded activity still expands');
    await checkBrowser(f);
    console.info('after-reply browser result', JSON.stringify({ locale, width, layout, failed, originalStepsVisible: true, realActivityRead: true }));
    await f.browser.close(); await f.sandbox.close();
  });
}

// Real running round and runtime-event completion boundary. Run when live
// follow-up placement, ticking or settlement changes; unrelated work may skip.
// Same official-runner/per-case HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR, private
// socket/DB/profile readbacks and lifecycle cleanup as the locale cases above.
// Only private SQLite rows are appended; no model, collector or live resource.
// The fixture has no collector notification, so its saved stop is read through
// the app's real refresh control instead of assuming a particular poll deadline.
test('running follow-up work updates below the reply and settles there without an empty AI message', { skip: !enabled, timeout: 35000 }, async t => {
  const f = await fixture(t, 'zh', 1280, { running: true });
  await until(() => f.page.evaluate(`!!document.querySelector('${tail}.conversation-activity-live')`), 'running tail is attached under the reply', 5000);
  const initial = await f.page.evaluate(`document.querySelector('${tail} .conversation-activity-head').textContent`);
  assert.match(initial, /回复后正在处理.*1 步/);
  assert.equal(await f.page.evaluate('document.querySelectorAll("article.chat-out").length'), 1);
  assert.equal(await f.page.evaluate('document.querySelectorAll("article.conversation-activity-message").length'), 0);
  await until(() => f.page.evaluate(`document.querySelector('${tail} .conversation-activity-head').textContent!==${JSON.stringify(initial)}`), 'running follow-up elapsed time updates on the real page', 2500);
  await screenshot(f.page, 'running-zh-1280');
  f.finish();
  await clickHead(f, '[data-action="refreshMessages"]');
  await until(() => f.page.evaluate(`!!document.querySelector('${tail}:not(.conversation-activity-live) button')`), 'the real refresh folds the completed follow-up under the same reply', 8000);
  assert.match(await f.page.evaluate(`document.querySelector('${tail} button').textContent`), /回复后又处理.*1 步/);
  assert.equal(await f.page.evaluate('document.querySelectorAll("article.chat-out").length'), 1);
  await clickHead(f, tail + ' button');
  await until(() => f.page.evaluate(`!!document.querySelector('${tail} [data-status=failed]')`), 'the settled failed step stays inspectable');
  await screenshot(f.page, 'running-zh-1280-finished');
  await checkBrowser(f);
  console.info('running after-reply result', JSON.stringify({ initial, completed: true, realManualRefresh: true }));
  await f.browser.close(); await f.sandbox.close();
});

// Mid-turn input chronology boundary. Run for activity placement/round anchors;
// unrelated work may skip. Private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket/DBs,
// authenticated real HTTP app and lifecycle cleanup are proven by fixture(t).
test('follow-up work after a user interjection stays below that user message', { skip: !enabled, timeout: 35000 }, async t => {
  const f = await fixture(t, 'zh', 1280, { interjection: true });
  await until(() => f.page.evaluate('!!document.querySelector(".conversation-activity-message button")'), 'interjected round keeps the existing trailing activity area', 5000);
  const layout = await f.page.evaluate(`(()=>{const user=document.querySelector('[data-message-id="3"]'),area=document.querySelector('.conversation-activity-message');return {attached:!!document.querySelector('${tail}'),afterUser:!!(user.compareDocumentPosition(area)&Node.DOCUMENT_POSITION_FOLLOWING),userText:user.textContent,emptyCount:document.querySelectorAll('.conversation-activity-message').length,summary:area.querySelector('button').textContent};})()`);
  assert.equal(layout.attached, false); assert.equal(layout.afterUser, true); assert.equal(layout.emptyCount, 1);
  assert.match(layout.userText, /谢谢，顺便把日志也存一下/); assert.match(layout.summary, /已处理 8 秒.*1 步/);
  await screenshot(f.page, 'interjection-zh-1280');
  await clickHead(f, '.conversation-activity-message button');
  await until(() => f.page.evaluate('!!document.querySelector(".conversation-activity-message [data-status=failed]")'), 'the trailing failed step remains inspectable after the user interjection');
  await screenshot(f.page, 'interjection-zh-1280-expanded');
  await checkBrowser(f);
  console.info('interjection after-reply result', JSON.stringify(layout));
  await f.browser.close(); await f.sandbox.close();
});

// Desktop intrinsic-bubble-width boundary with no pre-reply steps. Run for
// activity-slot/CSS sizing changes; unrelated work may skip. Same isolated
// HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/private socket/DB/profile and cleanup.
test('expanding follow-up work without earlier steps preserves the desktop reply bubble width', { skip: !enabled, timeout: 35000 }, async t => {
  const f = await fixture(t, 'zh', 1280, { beforeSteps: false });
  await until(() => f.page.evaluate(`!!document.querySelector('${tail} button')`), 'follow-up-only reply is loaded', 5000);
  const before = await f.page.evaluate(`(()=>{const a=document.querySelector('${reply}');return {width:a.querySelector('.chat-message-content').getBoundingClientRect().width,previousSlotHidden:a.querySelector('.conversation-activity-slot:not(.conversation-activity-after-reply-slot)').hidden};})()`);
  assert.equal(before.previousSlotHidden, true, 'this scenario has no visible pre-reply activity');
  assert.ok(before.width < 500, 'the short reply starts narrower than the expanded activity');
  await screenshot(f.page, 'no-earlier-steps-zh-1280');
  await clickHead(f, tail + ' button');
  await until(() => f.page.evaluate(`document.querySelector('${tail} button')?.getAttribute('aria-expanded')==='true'`), 'follow-up-only activity expands');
  const after = await f.page.evaluate(`(()=>{const a=document.querySelector('${reply}');return {width:a.querySelector('.chat-message-content').getBoundingClientRect().width,activityWidth:a.querySelector('.conversation-activity-after-reply').getBoundingClientRect().width};})()`);
  assert.ok(after.activityWidth >= 500, 'expanded activity exercises the wide desktop layout');
  assert.ok(Math.abs(before.width - after.width) <= 0.5, 'the reply bubble keeps its intrinsic width when follow-up activity expands');
  await screenshot(f.page, 'no-earlier-steps-zh-1280-expanded');
  await checkBrowser(f);
  console.info('follow-up-only bubble result', JSON.stringify({ before, after }));
  await f.browser.close(); await f.sandbox.close();
});
