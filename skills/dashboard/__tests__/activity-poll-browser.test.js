import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Store } from '../src/lib/store.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { hashPassword } from '../src/lib/auth.js';
import { migrateSchema } from '../../comm-bridge/scripts/c4-migrations.js';
import { migrateToV2 } from '../../comm-bridge/scripts/c4-migrations-v2.js';
import { groupRunDir, RUN_FILES } from '../../../cli/lib/session-group-paths.js';
import { createChatSandbox, chatEnabled } from './helpers/chat-integration-harness.js';
import { startChatBrowser, until } from './helpers/chat-push-browser-driver.js';

const enabled = chatEnabled() && !!process.env.ZYLOS_CHAT_BROWSER_BIN;
const helper = fileURLToPath(new URL('./helpers/activity-poll-server.js', import.meta.url));
const group = 'dashboard-activity-poll:private';
const conversation = 'g:' + Buffer.from(group).toString('hex').toUpperCase();
const tail = '[data-message-id="2"] .conversation-activity-after-reply';

// First-load polling boundary: run after asynchronous activity reads or poll
// scheduling change; unrelated rendering/backend work may skip. The official
// runner and per-case readbacks prove private HOME/ZYLOS_DIR/PM2_HOME, short
// TMPDIR, tmux socket, C4/Dashboard databases and Chrome profile before use.
// Real createServer/app/login/history/activity + real CoreLogImporter reading
// native JSONL, with the entry's history_changed broadcast behavior. No model,
// runtime collector, production DB, substituted activity API or source rewrite.
// Every service/Chrome process group, DB, importer loop and root belongs to the
// sandbox lifecycle on success/failure/timeout; observations/output are bounded.
test('opening a conversation during follow-up work settles automatically after its log records stop', { skip: !enabled, timeout: 50000 }, async t => {
  const sandbox = createChatSandbox(t);
  console.info('activity-poll browser targets', JSON.stringify(sandbox.assertIsolation()));
  const db = sandbox.openDatabase(sandbox.paths.c4Db, filename => new Database(filename));
  migrateSchema(db, { isNew: true }); migrateToV2(db);
  db.prepare('INSERT INTO channel_namespaces VALUES (?,?)').run('dashboard-activity-poll', 'dashboard');
  const start = Date.now() - 30000;
  const insert = db.prepare(`INSERT INTO conversations (id,timestamp,direction,channel,endpoint_id,session_group,content,status)
    VALUES (?, ?, ?, 'dashboard','private', ?, ?, 'delivered')`);
  insert.run(1, new Date(start).toISOString(), 'in', group, '请整理这次演示的结果。');
  insert.run(2, new Date(start + 10000).toISOString(), 'out', group, '演示已完成。正在保存会话日志。');
  const store = sandbox.openDatabase(sandbox.paths.dashboardDb, filename => new Store(filename));
  const conversations = new ChatConversations({ store, idGenerator: () => 'private' });
  conversations.create(); conversations.bind('private', 'dashboard-activity-poll'); conversations.markCommitted('private', { id: 1 });
  const logDir = groupRunDir(group, { ZYLOS_DIR: sandbox.paths.zylos });
  assert.ok(logDir.startsWith(sandbox.paths.zylos + path.sep));
  fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, RUN_FILES.EVENTS);
  const event = (event, ts, fields = {}) => ({ v: 1, ts, event, runtime: 'claude', session_group: group,
    session_id: 'private-poll-session', run_id: 'private-poll-run', ...fields });
  fs.writeFileSync(log, [event('prompt', start), event('deliver', start + 200, { conversation_id: 1 }),
    event('pre_tool', start + 11000, { tool_name: 'Bash', tool_use_id: 'after', tool_input: { description: '保存会话日志' } })]
    .map(row => JSON.stringify(row) + '\n').join(''));
  console.info('activity-poll native log target', log);
  fs.writeFileSync(path.join(sandbox.paths.zylos, 'components/dashboard/config.json'), JSON.stringify({ auth: { enabled: true, password: hashPassword('private-poll-password') } }));
  fs.mkdirSync(path.join(sandbox.paths.zylos, '.zylos'));
  fs.writeFileSync(path.join(sandbox.paths.zylos, '.zylos/config.json'), JSON.stringify({ session_mode: 'multi', runtime: 'claude' }));
  fs.writeFileSync(path.join(sandbox.paths.zylos, '.env'), 'TZ=Asia/Shanghai\n');
  const bin = path.join(sandbox.root, 'bin'); fs.mkdirSync(bin);
  for (const command of ['zylos', 'claude', 'codex']) fs.writeFileSync(path.join(bin, command), '#!/bin/sh\ncase "$1" in\n--version) printf "1.0.0\\n";;\nsession-mode) printf \'{"ok":true,"data":{"sessionMode":"multi"}}\\n\';;\nstatus) printf \'{"runtime":"claude","status":"stopped"}\\n\';;\n*) exit 1;;\nesac\n', { mode: 0o700 });
  for (const command of ['tmux', 'pm2']) fs.writeFileSync(path.join(bin, command), '#!/bin/sh\nprintf "forbidden runtime access\\n" >&2\nexit 1\n', { mode: 0o700 });
  const child = sandbox.startChild(process.execPath, [helper], { timeoutMs: 48000,
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
        if (line.startsWith('activity-poll-stop-imported ')) importedAt = JSON.parse(line.slice('activity-poll-stop-imported '.length)).at;
      } catch { protocolError = 'invalid child protocol'; child.kill('SIGKILL'); return; }
    }
  });
  await until(() => protocolError || origin || child.exitCode !== null, 'real Dashboard and log importer start', 10000);
  assert.equal(protocolError, undefined); assert.ok(origin);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE source='core-log'").get().n, 3);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE source!='core-log'").get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM core_log_cursors WHERE stream=? AND byte_offset=?').get('events:' + group, fs.statSync(log).size).n, 1);
  const browser = await startChatBrowser(t, sandbox, origin, { expectedBlockedHosts: ['fonts.googleapis.com'] });
  const page = await browser.page({ width: 1280, pathname: '/login', ready: '!!document.querySelector("input[name=password]")' });
  await page.evaluate("localStorage.setItem('zylos-dashboard-locale','zh');document.querySelector('input[name=password]').value='private-poll-password';document.querySelector('form').submit()");
  await until(() => page.evaluate('document.querySelector("#wb-chat")?.children.length>0'), 'full app mounts', 10000);
  await page.evaluate('document.querySelector(".tab[data-tab=chat]").click()');
  await until(() => page.evaluate(`!!document.querySelector('${tail}.conversation-activity-live')`), 'first selection loads already-running follow-up work', 5000);
  const runningText = await page.evaluate(`document.querySelector('${tail} .conversation-activity-head').textContent`);
  assert.match(runningText, /回复后正在处理.*1 步/);
  assert.equal(await page.evaluate('document.querySelectorAll("article.conversation-activity-message").length'), 0);
  assert.equal(await page.evaluate('!!document.querySelector(".chat-error:not([hidden])")'), false);
  // Record the physical stop time, then let the real importer discover it on its
  // ordinary interval. There are no button clicks or manual requests afterwards.
  const stoppedAt = Date.now();
  fs.appendFileSync(log, [event('post_tool', stoppedAt, { tool_name: 'Bash', tool_use_id: 'after' }), event('stop', stoppedAt)]
    .map(row => JSON.stringify(row) + '\n').join(''));
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  await until(() => page.evaluate(`!!document.querySelector('${tail}:not(.conversation-activity-live) button')`), 'follow-up settles without any user action', 6500);
  const elapsedMs = Date.now() - stoppedAt;
  assert.ok(importedAt !== null, 'the real importer observed the appended stop');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE source='core-log'").get().n, 5);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE event_type='stop' AND source='core-log'").get().n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM core_log_cursors WHERE stream=? AND byte_offset=?').get('events:' + group, fs.statSync(log).size).n, 1);
  assert.ok(elapsedMs <= 5000, 'newly discovered running activity settles within a few seconds');
  const completedText = await page.evaluate(`document.querySelector('${tail} button').textContent`);
  assert.match(completedText, /回复后又处理.*1 步/);
  if (evidence) await page.screenshot(path.join(evidence, 'updated-zh-1280.png'));
  assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));
  assert.equal(browser.external.length, 0, JSON.stringify(browser.external));
  const result = { scenario: 'updated', stoppedAt, importedAt,
    elapsedMs, importToSettlementMs: stoppedAt + elapsedMs - importedAt, runningText, completedText,
    runtimeEventsSource: 'core-log', nativeLog: true, noActionAfterStop: true };
  console.info('activity-poll browser timing', JSON.stringify(result));
  if (evidence) fs.writeFileSync(path.join(evidence, 'updated-timing.json'), JSON.stringify(result, null, 2));
  await browser.close(); await sandbox.close();
});
