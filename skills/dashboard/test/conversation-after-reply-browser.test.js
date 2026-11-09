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

async function fixture(t, locale, width) {
  const sandbox = createChatSandbox(t);
  console.info('after-reply browser targets', JSON.stringify(sandbox.assertIsolation()));
  const db = sandbox.openDatabase(sandbox.paths.c4Db, filename => new Database(filename));
  migrateSchema(db, { isNew: true }); migrateToV2(db);
  db.prepare('INSERT INTO channel_namespaces VALUES (?,?)').run('dashboard-after-reply', 'dashboard');
  const start = Date.now() - 120000;
  const at = seconds => new Date(start + seconds * 1000).toISOString();
  const insert = db.prepare(`INSERT INTO conversations (id,timestamp,direction,channel,endpoint_id,session_group,content,status)
    VALUES (?, ?, ?, 'dashboard','private', ?, ?, 'delivered')`);
  insert.run(1, at(0), 'in', group, locale === 'zh' ? '请整理这次演示的结果。' : 'Please summarize the demo results.');
  insert.run(2, at(10), 'out', group, locale === 'zh' ? '演示已完成。图表和结果已经准备好，可以继续查看。' : 'The demo is complete. The chart and results are ready to review.');
  const store = sandbox.openDatabase(sandbox.paths.dashboardDb, filename => new Store(filename));
  const conversations = new ChatConversations({ store, idGenerator: () => 'private' });
  conversations.create(); conversations.bind('private', 'dashboard-after-reply'); conversations.markCommitted('private', { id: 1 });
  const event = (type, seconds, metadata = {}) => store.insertEvent({ id: crypto.randomUUID(), ingest_id: crypto.randomUUID(),
    timestamp: at(seconds), runtime: 'codex', session_id: 'private-after-reply-session', session_group: group,
    run_id: 'private-after-reply-run', event_type: type, category: 'test', summary: null, metadata, source: 'test' });
  event('user_prompt_submit', 0); event('deliver', 0.2, { conversation_id: 1 });
  event('tool_call', 1, { call_id: 'before', tool_name: 'Read', tool_detail: 'demo-notes.md' });
  event('tool_result', 3, { call_id: 'before', tool_name: 'Read' });
  event('tool_call', 11, { call_id: 'after', tool_name: 'exec_command' });
  event('tool_result', 16, { call_id: 'after', tool_name: 'exec_command', outcome: 'failed' });
  event('stop', 16);
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
  return { sandbox, browser, page };
}

// Full createServer/app.js, real authenticated history/activity routes and
// private C4 + runtime_events: no mocked activity response or browser rendering.
// Run for after-reply placement/toggle/CSS changes; unrelated backend/runtime
// work may skip. Official runner and case readbacks prove HOME/ZYLOS_DIR,
// PM2_HOME, short TMPDIR, private socket/DB paths. Runtime CLI is refused or
// fixture-only; all outside browser requests are blocked. Lifecycle/abort owns
// service and Chrome process groups, DBs and private roots on every exit path.
for (const locale of ['zh', 'en']) for (const width of [1280, 390]) {
  test(`reply follow-up activity stays under the reply and opens its failed step in ${locale} at ${width}`, { skip: !enabled, timeout: 35000 }, async t => {
    const f = await fixture(t, locale, width);
    const reply = '[data-message-id="2"]';
    try {
      await until(() => f.page.evaluate(`!!document.querySelector('${reply} .conversation-activity-after-reply')`), 'completed tail is attached inside the loaded reply', 5000);
    } catch (error) {
      console.info('after-reply load diagnostic', JSON.stringify(await f.page.evaluate(`(async()=>({page:document.querySelector('#wb-chat')?.innerText.slice(0,2500),activity:await(await fetch('/api/chat/conversations/${conversation}/activity?tab=mine&ids=1')).json()}))()`)));
      throw error;
    }
    assert.equal(await f.page.evaluate('!!document.querySelector(".chat-error:not([hidden])")'), false, 'the real app has no conversation error banner');
    const layout = await f.page.evaluate(`(()=>{const article=document.querySelector('${reply}'),tail=article.querySelector('.conversation-activity-after-reply'),button=tail.querySelector('button'),content=article.querySelector('.chat-message-content'),b=button.getBoundingClientRect(),c=content.getBoundingClientRect();return {articles:document.querySelectorAll('article.chat-out').length,empty:document.querySelectorAll('article.conversation-activity-message').length,text:button.textContent,height:b.height,width:b.width,x:b.x,y:b.y,contentX:c.x,afterBody:!!(content.compareDocumentPosition(tail)&Node.DOCUMENT_POSITION_FOLLOWING),collapsed:button.getAttribute('aria-expanded')==='false'};})()`);
    assert.equal(layout.articles, 1); assert.equal(layout.empty, 0); assert.equal(layout.afterBody, true); assert.equal(layout.collapsed, true);
    assert.match(layout.text, locale === 'zh' ? /回复后又处理.*6 秒.*1 步/ : /After replying.*6 s.*steps: 1/i);
    assert.ok(Math.abs(layout.x - layout.contentX) <= 10, 'follow-up text aligns with the reply body');
    if (width === 390) assert.ok(layout.height >= 40 && layout.width >= 40, 'phone toggle offers at least a 40px touch target');
    const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
    if (evidence) {
      fs.mkdirSync(evidence, { recursive: true });
      await f.page.screenshot(path.join(evidence, `${locale}-${width}.png`));
    }
    if (width === 390) {
      await f.page.call('Emulation.setTouchEmulationEnabled', { enabled: true });
      await f.page.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: layout.x + layout.width / 2, y: layout.y + layout.height / 2 }] });
      await f.page.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await f.page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: layout.x + layout.width / 2, y: layout.y + layout.height / 2, button: 'left', clickCount: 1 });
      await f.page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: layout.x + layout.width / 2, y: layout.y + layout.height / 2, button: 'left', clickCount: 1 });
    }
    await until(() => f.page.evaluate(`document.querySelector('${reply} .conversation-activity-after-reply button')?.getAttribute('aria-expanded')==='true'`), 'real pointer click expands follow-up steps');
    const failed = await f.page.evaluate(`document.querySelector('${reply} .conversation-activity-after-reply [data-status=failed]')?.textContent`);
    assert.match(failed, locale === 'zh' ? /没有完成.*5 秒/ : /Did not finish.*5 s/i);
    await f.page.evaluate(`document.querySelector('${reply} .conversation-activity-slot button').click()`);
    await until(() => f.page.evaluate(`!!document.querySelector('${reply} .conversation-activity-slot [data-status=done]')`), 'original folded activity still expands');
    assert.equal(f.browser.errors.length, 0, JSON.stringify(f.browser.errors)); assert.equal(f.browser.external.length, 0, JSON.stringify(f.browser.external));
    if (evidence && width === 390) await f.page.screenshot(path.join(evidence, `${locale}-${width}-expanded.png`));
    console.info('after-reply browser result', JSON.stringify({ locale, width, layout, failed, originalStepsVisible: true, realActivityRead: true }));
    await f.browser.close(); await f.sandbox.close();
  });
}
