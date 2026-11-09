import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { hashPassword } from '../src/lib/auth.js';
import { migrateSchema } from '../../comm-bridge/scripts/c4-migrations.js';
import { migrateToV2 } from '../../comm-bridge/scripts/c4-migrations-v2.js';
import { createChatSandbox, chatEnabled } from './helpers/chat-integration-harness.js';
import { startChatBrowser, until, pause } from './helpers/chat-push-browser-driver.js';

const enabled = chatEnabled() && !!process.env.ZYLOS_CHAT_BROWSER_BIN;
const helper = fileURLToPath(new URL('./helpers/chat-recovery-server.js', import.meta.url));
const group = 'dashboard-recovery:private';
const conversation = 'g:' + Buffer.from(group).toString('hex').toUpperCase();

async function fixture(t) {
  const sandbox = createChatSandbox(t);
  console.info('full dashboard recovery targets', JSON.stringify(sandbox.assertIsolation()));
  const writer = sandbox.openDatabase(sandbox.paths.c4Db, filename => new Database(filename));
  migrateSchema(writer, { isNew: true }); migrateToV2(writer);
  writer.prepare('INSERT INTO channel_namespaces VALUES (?,?)').run('dashboard-recovery', 'dashboard');
  let nextId = 0;
  let activeWriter = writer;
  const insert = text => {
    const id = ++nextId;
    activeWriter.prepare(`INSERT INTO conversations (id,timestamp,direction,channel,endpoint_id,session_group,content,status)
      VALUES (?,?,'out','dashboard','private',?,?,'delivered')`).run(id, new Date().toISOString(), group, text);
    return { id, committedAt: Date.now() };
  };
  insert('Original private database message');
  const configDirectory = path.join(sandbox.paths.zylos, 'components/dashboard');
  fs.writeFileSync(path.join(configDirectory, 'config.json'), JSON.stringify({ auth: { enabled: true, password: hashPassword('private-recovery-password') } }));
  fs.mkdirSync(path.join(sandbox.paths.zylos, '.zylos'));
  fs.writeFileSync(path.join(sandbox.paths.zylos, '.zylos/config.json'), JSON.stringify({ session_mode: 'multi', runtime: 'codex' }));
  const bin = path.join(sandbox.root, 'bin'); fs.mkdirSync(bin);
  for (const command of ['zylos', 'claude', 'codex']) fs.writeFileSync(path.join(bin, command), '#!/bin/sh\ncase "$1" in\n--version) printf "1.0.0\\n";;\nsession-mode) printf \'{"mode":"multi","session_mode":"multi"}\\n\';;\nstatus) printf \'{"runtime":"codex","status":"stopped"}\\n\';;\n*) exit 1;;\nesac\n', { mode: 0o700 });
  for (const command of ['tmux', 'pm2']) fs.writeFileSync(path.join(bin, command), '#!/bin/sh\nprintf "forbidden runtime access\\n" >&2\nexit 1\n', { mode: 0o700 });
  const child = sandbox.startChild(process.execPath, [helper], { timeoutMs: 60000,
    env: { PATH: bin + ':/usr/bin:/bin', ZYLOS_CHAT_CASE_ROOT: sandbox.root,
      TMUX: sandbox.paths.socket + ',0,0', ZYLOS_CHAT_TMUX_SOCKET: sandbox.paths.socket } });
  let output = '', origin, serial = 0, protocolError;
  const replies = new Map();
  child.stdout.on('data', data => {
    output += data.toString();
    if (output.length >= 65536) { protocolError = 'child protocol bound exceeded'; child.kill('SIGKILL'); return; }
    let newline;
    while ((newline = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, newline); output = output.slice(newline + 1);
      if (line.startsWith('full dashboard child isolation ')) console.info(line);
      try {
        if (line.startsWith('recovery-server-ready ')) origin = JSON.parse(line.slice('recovery-server-ready '.length)).origin;
        if (line.startsWith('recovery-server-result ')) { const result = JSON.parse(line.slice('recovery-server-result '.length)); replies.set(result.id, result); }
      } catch { protocolError = 'invalid child protocol'; child.kill('SIGKILL'); return; }
    }
  });
  await until(() => protocolError || origin || child.exitCode !== null, 'real HTTP server starts', 10000);
  assert.equal(protocolError, undefined);
  assert.ok(origin, 'child serves real Dashboard HTTP entry');
  async function command(action) {
    const id = ++serial; child.stdin.write(JSON.stringify({ id, action }) + '\n');
    await until(() => protocolError || replies.has(id), 'child command acknowledged');
    assert.equal(protocolError, undefined);
    const reply = replies.get(id); replies.delete(id); return reply;
  }
  // Full index.html references Google Fonts. The driver blocks every external
  // request; only that known optional stylesheet is exempt from the error list.
  const browser = await startChatBrowser(t, sandbox, origin, { expectedBlockedHosts: ['fonts.googleapis.com'] });
  const received = { ready: 0, ordinary: 0, unavailable: 0, blockedExternalFonts: 0, messages: 0 };
  const page = await browser.page({ pathname: '/login', ready: '!!document.querySelector("input[name=password]")', onEvent(event) {
    if (event.method === 'Fetch.requestPaused' && new URL(event.params.request.url).hostname === 'fonts.googleapis.com') received.blockedExternalFonts++;
    if (event.method !== 'Network.eventSourceMessageReceived') return;
    const kind = event.params.eventName;
    if (kind === 'chat_ready') received.ready++;
    if (kind === 'chat_unavailable') received.unavailable++;
    if (kind === 'chat_messages_changed') received.messages++;
    if (kind === 'health_update' && event.params.data.includes('private-recovery-health')) received.ordinary++;
  } });
  await page.evaluate(`document.querySelector('input[name=password]').value='private-recovery-password';document.querySelector('form').submit()`);
  await until(() => page.evaluate('document.querySelector("#wb-chat")?.children.length>0'), 'real app mounts conversation controller after login', 10000);
  await page.evaluate('document.querySelector(".tab[data-tab=chat]").click()');
  await until(() => page.evaluate(`!!document.querySelector('[data-conversation-id="${conversation}"]')`), 'seeded conversation is listed', 5000);
  await page.evaluate(`document.querySelector('[data-conversation-id="${conversation}"]').click()`);
  await until(() => page.evaluate(`document.querySelector('.conversation-push-status')?.dataset.streamState==='live'`), 'full application receives ready', 5000);
  await until(() => page.evaluate(`!!document.querySelector('[data-message-id="1"]')`), 'original message is rendered');
  return { sandbox, browser, page, received, command, insert, writer,
    replace() {
      const replacement = sandbox.paths.c4Db + '.replacement';
      writer.close();
      fs.copyFileSync(sandbox.paths.c4Db, replacement);
      const before = fs.statSync(sandbox.paths.c4Db);
      fs.renameSync(replacement, sandbox.paths.c4Db);
      assert.notEqual(fs.statSync(sandbox.paths.c4Db).ino, before.ino, 'replacement has a new inode');
      activeWriter = sandbox.openDatabase(sandbox.paths.c4Db, filename => new Database(filename));
      return Date.now();
    },
    takeOffline() { fs.renameSync(sandbox.paths.c4Db, sandbox.paths.c4Db + '.offline'); return Date.now(); },
    restore() { fs.renameSync(sandbox.paths.c4Db + '.offline', sandbox.paths.c4Db); return Date.now(); }
  };
}

async function verifyLive(f, start, previousStreams) {
  await until(async () => (await f.command('status')).streams === previousStreams + 1
    && await f.page.evaluate(`document.querySelector('.conversation-push-status')?.dataset.streamState==='live'`), 'database generation restores live through exactly one real application reconnect', 2200);
  const latency = Date.now() - start;
  assert.ok(latency <= 2200, `live recovery latency ${latency}ms`);
  const update = f.insert('Committed after automatic live recovery');
  try {
    await until(() => f.page.evaluate(`!!document.querySelector('[data-message-id="${update.id}"]')`), 'post-recovery commit renders in under one second', 1000);
  } catch (error) {
    console.info('full application recovery diagnostic', JSON.stringify({ update, received: f.received,
      page: await f.page.evaluate(`({text:document.querySelector('#wb-chat')?.innerText.slice(0,3000),state:document.querySelector('.conversation-push-status')?.dataset.streamState,selected:document.querySelector('.conversation-list-item[aria-selected=true]')?.dataset.conversationId})`) }));
    throw error;
  }
  const writeLatency = Date.now() - update.committedAt;
  assert.ok(writeLatency < 1000);
  await pause(1100);
  assert.equal((await f.command('status')).streams, previousStreams + 1, 'no repeated reconnect after recovery');
  assert.equal(f.browser.errors.length, 0, JSON.stringify(f.browser.errors));
  assert.equal(f.browser.external.length, 0, JSON.stringify(f.browser.external));
  assert.ok(f.received.blockedExternalFonts > 0, 'known full-index font request is observed and blocked by the driver');
  return { recoveryMs: latency, writeLatencyMs: writeLatency, reconnects: 1, blockedExternalFonts: f.received.blockedExternalFonts };
}

// Real createServer + full app.js + Chrome native EventSource and independent
// SQLite writer. Run for generation/stream recovery changes; rendering-only or
// model changes may skip. Official runner plus case isolation prove HOME,
// ZYLOS_DIR, PM2_HOME, short TMPDIR, private socket and DBs before starting.
// Sandbox/abort/timeout own the service process group, browser, DBs and root.
test('the full application reconnects once after a database inode replacement and resumes live updates', { skip: !enabled, timeout: 45000 }, async t => {
  const f = await fixture(t), before = (await f.command('status')).streams;
  const result = await verifyLive(f, f.replace(), before);
  console.info('full application database replacement', JSON.stringify(result));
  await f.browser.close(); await f.sandbox.close();
});

// Same isolated service/browser boundary. The twelve-second open-stream
// assertion rejects closing on every unavailable sample; the restore/live and
// exact reconnect assertions reject never closing on a database generation.
test('the full application keeps an unavailable database stream for twelve seconds and reconnects only after restoration', { skip: !enabled, timeout: 45000 }, async t => {
  const f = await fixture(t), before = (await f.command('status')).streams;
  const missingAt = f.takeOffline();
  await until(() => f.received.unavailable > 0, 'ordinary stream receives unavailable metadata');
  await f.command('ordinary');
  await until(() => f.received.ordinary > 0, 'ordinary event reaches native application EventSource');
  while (Date.now() - missingAt < 12200) {
    await pause(250);
    assert.equal((await f.command('status')).streams, before, 'persistent absence must not reconnect');
    assert.equal(f.browser.errors.length, 0, JSON.stringify(f.browser.errors));
    assert.equal(f.browser.external.length, 0, JSON.stringify(f.browser.external));
  }
  assert.equal((await f.command('status')).active, 1, 'ordinary stream stays connected');
  const restoredAt = f.restore();
  const result = await verifyLive(f, restoredAt, before);
  console.info('full application database restoration', JSON.stringify({ ...result, missingMs: restoredAt - missingAt, missingReconnects: 0, ordinaryEvents: f.received.ordinary }));
  await f.browser.close(); await f.sandbox.close();
});
