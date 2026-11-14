import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Store } from '../src/lib/store.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { SETTLE_MS } from '../src/lib/chat/activity.js';
import { hashPassword } from '../src/lib/auth.js';
import { migrateSchema } from '../../comm-bridge/scripts/c4-migrations.js';
import { migrateToV2 } from '../../comm-bridge/scripts/c4-migrations-v2.js';
import { groupRunDir, RUN_FILES } from '../../../cli/lib/session-group-paths.js';
import { createChatSandbox, chatEnabled } from './helpers/chat-integration-harness.js';
import { startChatBrowser, until } from './helpers/chat-push-browser-driver.js';

const enabled = chatEnabled() && !!process.env.ZYLOS_CHAT_BROWSER_BIN;
// The conversation page's read interval on a live message stream when nothing in the group can change soon.
const SLOW_READ_MS = 30000;
const helper = fileURLToPath(new URL('./helpers/activity-poll-server.js', import.meta.url));
const group = 'dashboard-activity-poll:private';
const conversation = 'g:' + Buffer.from(group).toString('hex').toUpperCase();
const live = '.conversation-activity-message .conversation-activity-live';

// Cold-start boundary: run after changes to how activity is read (turn grouping,
// working state, queued-message handling) or to activity polling; unrelated
// rendering/backend work may skip. The official runner and per-case readbacks
// prove private HOME/ZYLOS_DIR/PM2_HOME, short TMPDIR, tmux socket, C4/Dashboard
// databases and Chrome profile before use. Real createServer/app/login/history/
// activity + real CoreLogImporter reading native JSONL, with the entry's
// history_changed broadcast behavior. No model, runtime collector, production
// DB, substituted activity API or source rewrite. Every service/Chrome process
// group, DB, importer loop and root belongs to the sandbox lifecycle on
// success/failure/timeout; observations/output are bounded.
test('the first message after a cold start claims no work without the header\'s reading, settles after the stop and leaves after the reply', { skip: !enabled, timeout: 95000 }, async t => {
  const sandbox = createChatSandbox(t);
  console.info('activity-poll browser targets', JSON.stringify(sandbox.assertIsolation()));
  const db = sandbox.openDatabase(sandbox.paths.c4Db, filename => new Database(filename));
  migrateSchema(db, { isNew: true }); migrateToV2(db);
  db.prepare('INSERT INTO channel_namespaces VALUES (?,?)').run('dashboard-activity-poll', 'dashboard');
  const start = Date.now() - 30000;
  const insert = db.prepare(`INSERT INTO conversations (id,timestamp,direction,channel,endpoint_id,session_group,content,status)
    VALUES (?, ?, ?, 'dashboard','private', ?, ?, 'delivered')`);
  insert.run(1, new Date(start).toISOString(), 'in', group, '请整理这次演示的结果。');
  const store = sandbox.openDatabase(sandbox.paths.dashboardDb, filename => new Store(filename));
  const conversations = new ChatConversations({ store, idGenerator: () => 'private' });
  conversations.create(); conversations.bind('private', 'dashboard-activity-poll'); conversations.markCommitted('private', { id: 1 });
  const logDir = groupRunDir(group, { ZYLOS_DIR: sandbox.paths.zylos });
  assert.ok(logDir.startsWith(sandbox.paths.zylos + path.sep));
  fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, RUN_FILES.EVENTS);
  const event = (event, ts, fields = {}) => ({ v: 1, ts, event, runtime: 'claude', session_group: group,
    session_id: 'private-poll-session', run_id: 'private-poll-run', ...fields });
  // The start-up turn claims the queued message and stops; the runtime then takes the message from its own queue,
  // which records no event, and the work it starts arrives without a prompt of its own.
  const tookAt = Date.now() - 1000;
  fs.writeFileSync(log, [event('prompt', start), event('deliver', start + 200, { conversation_id: 1 }), event('stop', start + 2000),
    event('pre_tool', tookAt, { tool_name: 'Bash', tool_use_id: 'taken', tool_input: { description: '保存会话日志' } })]
    .map(row => JSON.stringify(row) + '\n').join(''));
  console.info('activity-poll native log target', log);
  fs.writeFileSync(path.join(sandbox.paths.zylos, 'components/dashboard/config.json'), JSON.stringify({ auth: { enabled: true, password: hashPassword('private-poll-password') } }));
  fs.mkdirSync(path.join(sandbox.paths.zylos, '.zylos'));
  fs.writeFileSync(path.join(sandbox.paths.zylos, '.zylos/config.json'), JSON.stringify({ session_mode: 'multi', runtime: 'claude' }));
  fs.writeFileSync(path.join(sandbox.paths.zylos, '.env'), 'TZ=Asia/Shanghai\n');
  const bin = path.join(sandbox.root, 'bin'); fs.mkdirSync(bin);
  for (const command of ['zylos', 'claude', 'codex']) fs.writeFileSync(path.join(bin, command), '#!/bin/sh\ncase "$1" in\n--version) printf "1.0.0\\n";;\nsession-mode) printf \'{"ok":true,"data":{"sessionMode":"multi"}}\\n\';;\nstatus) printf \'{"runtime":"claude","status":"stopped"}\\n\';;\n*) exit 1;;\nesac\n', { mode: 0o700 });
  for (const command of ['tmux', 'pm2']) fs.writeFileSync(path.join(bin, command), '#!/bin/sh\nprintf "forbidden runtime access\\n" >&2\nexit 1\n', { mode: 0o700 });
  const child = sandbox.startChild(process.execPath, [helper], { timeoutMs: 93000,
    env: { PATH: bin + ':/usr/bin:/bin', ZYLOS_CHAT_CASE_ROOT: sandbox.root, TMUX: sandbox.paths.socket + ',0,0' } });
  let output = '', origin, importedAt = null, protocolError;
  child.stdout.on('data', data => {
    output += data.toString();
    if (output.length >= 65536) { protocolError = 'child protocol bound exceeded'; child.kill('SIGKILL'); return; }
    let newline;
    while ((newline = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, newline); output = output.slice(newline + 1);
      if (line.startsWith('activity-poll child isolation ')) console.info(line);
      try {
        if (line.startsWith('activity-poll-server-ready ')) origin = JSON.parse(line.slice('activity-poll-server-ready '.length)).origin;
        if (line.startsWith('activity-poll-stop-imported ')) {
          const seen = JSON.parse(line.slice('activity-poll-stop-imported '.length));
          if (seen.stops === 2) importedAt = seen.at;
        }
      } catch { protocolError = 'invalid child protocol'; child.kill('SIGKILL'); return; }
    }
  });
  await until(() => protocolError || origin || child.exitCode !== null, 'real Dashboard and log importer start', 10000);
  assert.equal(protocolError, undefined); assert.ok(origin);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE source='core-log'").get().n, 4);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE source!='core-log'").get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM core_log_cursors WHERE stream=? AND byte_offset=?').get('events:' + group, fs.statSync(log).size).n, 1);
  const browser = await startChatBrowser(t, sandbox, origin, { expectedBlockedHosts: ['fonts.googleapis.com'] });
  const page = await browser.page({ width: 1280, pathname: '/login', ready: '!!document.querySelector("input[name=password]")' });
  await page.evaluate("localStorage.setItem('zylos-dashboard-locale','zh');document.querySelector('input[name=password]').value='private-poll-password';document.querySelector('form').submit()");
  await until(() => page.evaluate('document.querySelector("#wb-chat")?.children.length>0'), 'full app mounts', 10000);
  await page.evaluate('document.querySelector(".tab[data-tab=chat]").click()');
  await until(() => page.evaluate('!!document.querySelector(\'[data-message-id="1"]\')'), 'first selection shows the message', 5000);
  // This sandbox runs no session, so the header has no reading of its own (the fixture-API browser case covers the
  // working area under a running header): the area works exactly when the header says the main AI works, so it
  // claims no work here even though steps were recorded.
  await until(() => page.evaluate("performance.getEntriesByType('resource').some(entry => entry.name.includes('/activity?'))"),
    'the page read the activity', 5000);
  for (let i = 0; i < 4; i++) await page.evaluate('new Promise(resolve => requestAnimationFrame(() => resolve()))');
  const beforeStop = await page.evaluate('document.querySelector(".conversation-activity-message")?.textContent ?? null');
  assert.equal(beforeStop, null, 'no working area without the header\'s reading');
  assert.equal(await page.evaluate('!!document.querySelector(".chat-error:not([hidden])")'), false);
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) { fs.mkdirSync(evidence, { recursive: true }); await page.screenshot(path.join(evidence, 'cold-start-before-stop-zh-1280.png')); }
  // The log records the step's end and the stop; the real importer discovers them on its ordinary interval. There
  // are no button clicks or manual requests afterwards. Once the work around the stop settled for the settle time,
  // the area says the message was handled without a reply. Nothing was live before the stop here, so the page sees
  // the stop at its next slow read (live stream: every 30 s); a read within the settle time keeps it reading every 2 s.
  const stoppedAt = Date.now();
  fs.appendFileSync(log, [event('post_tool', stoppedAt, { tool_name: 'Bash', tool_use_id: 'taken' }), event('stop', stoppedAt)]
    .map(row => JSON.stringify(row) + '\n').join(''));
  await until(() => page.evaluate(`!!document.querySelector('[data-message-id="1"] + .conversation-activity-message .conversation-activity-handled')`),
    'the area settles after the stop without any user action', SLOW_READ_MS + 6000);
  const elapsedMs = Date.now() - stoppedAt;
  assert.ok(importedAt !== null, 'the real importer observed the appended stop');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE source='core-log'").get().n, 6);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE event_type='stop' AND source='core-log'").get().n, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM core_log_cursors WHERE stream=? AND byte_offset=?').get('events:' + group, fs.statSync(log).size).n, 1);
  assert.ok(elapsedMs >= SETTLE_MS - 1000 && elapsedMs <= Math.max(SETTLE_MS, SLOW_READ_MS) + 5000,
    `handled no earlier than the settle time and within one slow read of it (${elapsedMs} ms)`);
  const handledText = await page.evaluate(`document.querySelector('${live}').textContent`);
  assert.equal(handledText, '已处理，没有回复·在组详情查看过程');
  if (evidence) await page.screenshot(path.join(evidence, 'cold-start-handled-zh-1280.png'));
  // A reply that lands afterwards ends it: nothing stays under either message.
  insert.run(2, new Date().toISOString(), 'out', group, '会话日志已保存。');
  await until(() => page.evaluate('!!document.querySelector(\'[data-message-id="2"]\') && !document.querySelector(".conversation-activity-message")'),
    'the reply shows and the area leaves', 6500);
  assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));
  assert.equal(browser.external.length, 0, JSON.stringify(browser.external));
  const result = { scenario: 'cold-start', stoppedAt, importedAt,
    elapsedMs, importToSettlementMs: stoppedAt + elapsedMs - importedAt, beforeStop, handledText,
    runtimeEventsSource: 'core-log', nativeLog: true, noActionAfterStop: true };
  console.info('activity-poll browser timing', JSON.stringify(result));
  if (evidence) fs.writeFileSync(path.join(evidence, 'cold-start-timing.json'), JSON.stringify(result, null, 2));
  await browser.close(); await sandbox.close();
});
