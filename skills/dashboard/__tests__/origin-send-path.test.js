import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { createStore } from '../../comm-bridge/scripts/c4-v2-store.js';
import { guardDatabase } from '../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../comm-bridge/scripts/c4-schema.js';
import { CONTENT_PREFIX } from '../../comm-bridge/scripts/c4-content-schema.js';
import { Store } from '../src/lib/store.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { ChatHistory } from '../src/lib/chat/history.js';
import { ChatAttachments } from '../src/lib/chat/attachments.js';
import { ensureOriginConversation, ORIGIN_CONVERSATION_ID } from '../src/lib/chat/origin.js';

const dashboardDir = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = path.resolve(dashboardDir, '../..');
const cli = path.join(packageRoot, 'skills', 'comm-bridge', 'scripts', 'c4-send.js');
const attachmentCli = path.join(dashboardDir, 'scripts', 'attachments.js');

// Boundary: the real c4-send CLI, the real Dashboard skill (SKILL.md BeforeSend
// declaration, send-hook.js, send.js delivery and attachments.js) and the real
// Dashboard history over one private root. Run for changes to the Origin
// fixed address, outbound ownership, the Dashboard hook/delivery or Origin
// history; UI-only changes may skip. HOME, ZYLOS_DIR, PM2_HOME, TMPDIR and the
// tmux directory are private and read back before any child starts; PATH holds
// only node and cat, so no runtime, tmux, PM2 or network can start. Children
// have timeouts and output caps; teardown closes both databases and removes the root.
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'origin-send-path-')));
  const home = path.join(root, 'home'), zylos = path.join(home, 'zylos');
  const skillsDir = path.join(zylos, '.claude', 'skills');
  const bin = path.join(root, 'bin'), tmp = path.join(root, 'tmp');
  for (const dir of [bin, tmp, skillsDir, path.join(zylos, '.zylos'), path.join(zylos, 'comm-bridge'),
    path.join(zylos, 'components', 'dashboard'), path.join(zylos, 'workspace')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(zylos, '.zylos', 'config.json'), '{"runtime":"claude","session_mode":"multi"}');
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.symlinkSync('/bin/cat', path.join(bin, 'cat'));
  fs.symlinkSync(dashboardDir, path.join(skillsDir, 'dashboard'));
  const telegram = path.join(skillsDir, 'telegram', 'scripts');
  fs.mkdirSync(telegram, { recursive: true });
  fs.writeFileSync(path.join(telegram, '..', 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(telegram, 'send.js'), 'process.exit(0);');
  const env = { HOME: home, ZYLOS_DIR: zylos, PM2_HOME: path.join(root, 'pm2'), TMPDIR: tmp, TMUX_TMPDIR: tmp,
    PATH: bin, ZYLOS_PACKAGE_ROOT: packageRoot };
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'PATH']) assert.ok(env[key].startsWith(root + path.sep), key);
  assert.deepEqual(fs.readdirSync(bin).sort(), ['cat', 'node']);
  const databasePath = path.join(zylos, 'comm-bridge', 'c4.db');
  console.log('Origin send path isolation:', JSON.stringify({ ...env, databasePath }));

  const db = new Database(databasePath);
  guardDatabase(db, schema); db.pragma('journal_mode=WAL');
  const c4 = createStore(db, { validateComponent: name => ['dashboard', 'telegram'].includes(name) });
  const store = new Store(path.join(zylos, 'components', 'dashboard', 'dashboard.db'));
  ensureOriginConversation(store.db);
  const conversations = new ChatConversations({ store });
  const reader = new C4Reader(zylos);
  const attachments = new ChatAttachments({ store, c4Reader: reader, zylosDir: zylos });
  const history = new ChatHistory({ c4Reader: reader, conversations, attachments });
  t.after(async () => {
    await attachments.close(); reader.close(); store.close(); db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const run = (file, args, sender, input = '') => {
    const childEnv = { ...env, ...(sender ? { ZYLOS_SESSION_GROUP: sender } : {}) };
    return spawnSync(process.execPath, [file, ...args], { cwd: root, env: childEnv, input, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  };
  const shell = (command, sender) => spawnSync('/bin/sh', ['-c', command], { cwd: root,
    env: { ...env, ZYLOS_SESSION_GROUP: sender }, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  return { root, zylos, db, c4, history, run, shell };
}

test('another session is refused on dashboard origin and its internal relay shows in the Origin conversation', { timeout: 30000 }, t => {
  const f = fixture(t);
  f.c4.insertConversation('in', 'telegram', 'x', 'owner asks elsewhere', { groupName: 'x' });
  const before = f.db.prepare('SELECT count(*) AS n FROM conversations').get().n;
  const denied = f.run(cli, ['dashboard', 'origin', '--stdin'], 'telegram:x', 'tell the owner in Origin');
  assert.ifError(denied.error);
  assert.equal(denied.status, 1, denied.stderr);
  assert.match(denied.stderr, /^\[C4\] CROSS_SESSION_OUTBOUND: this dashboard address belongs to session group "origin"/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM conversations').get().n, before, 'nothing was recorded');

  const lines = denied.stderr.split('\n');
  const first = lines.findIndex(line => line.startsWith("cat <<'EOF_INTERNAL'"));
  const last = lines.findIndex((line, i) => i > first && line === 'EOF_INTERNAL');
  assert.ok(first >= 0 && last > first);
  assert.match(lines[first], / internal 'origin'$/);
  const command = [lines[first], 'Please tell the owner in Origin: the export finished. Why: they asked here.', 'EOF_INTERNAL'].join('\n');
  const relay = f.shell(command, 'telegram:x');
  assert.ifError(relay.error);
  assert.equal(relay.status, 0, relay.stderr);

  const items = f.history.messages(ORIGIN_CONVERSATION_ID).items;
  assert.deepEqual(items.map(row => [row.direction, row.channel, row.internal?.peerSessionGroup, row.internal?.content]),
    [['in', 'internal', 'telegram:x', 'Please tell the owner in Origin: the export finished. Why: they asked here.']]);
});

test("Origin's attachment reply to dashboard origin passes the real BeforeSend hook and is delivered with its file", { timeout: 30000 }, t => {
  const f = fixture(t);
  f.c4.insertConversation('in', 'dashboard', 'origin', 'please send the report');
  const source = path.join(f.zylos, 'workspace', 'report.txt');
  fs.writeFileSync(source, 'agent bytes');
  const registered = f.run(attachmentCli, ['register', '--conversation', 'origin', '--kind', 'file', '--path', source], 'origin');
  assert.equal(registered.status, 0, registered.stderr + registered.stdout);
  const id = JSON.parse(registered.stdout).attachmentId;
  assert.ok(id, registered.stdout);
  const reply = CONTENT_PREFIX + JSON.stringify({ version: 1, kind: 'message', messageId: 'origin_report', fallbackText: 'report',
    blocks: [{ id: 'file', type: 'x-zylos.file', schemaVersion: 1, fallbackText: 'report.txt', data: { attachmentId: id, nameSnapshot: 'report.txt' } }] });

  const sent = f.run(cli, ['dashboard', 'origin', '--stdin'], 'origin', reply);
  assert.ifError(sent.error);
  assert.equal(sent.status, 0, sent.stderr);
  const row = f.db.prepare("SELECT * FROM conversations WHERE direction='out' ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual([row.channel, row.endpoint_id, row.session_group, row.status], ['dashboard', 'origin', 'origin', 'delivered']);
  const item = f.history.messages(ORIGIN_CONVERSATION_ID).items.find(entry => String(entry.id) === String(row.id));
  assert.deepEqual(item.attachments.map(file => [file.name, file.available]), [['report.txt', true]]);
});
