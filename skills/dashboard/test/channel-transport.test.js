import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { guardDatabase } from '../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../comm-bridge/scripts/c4-schema.js';
import { createStore } from '../../comm-bridge/scripts/c4-v2-store.js';
import { CONTENT_PREFIX, MAX_CONTENT_BYTES } from '../../comm-bridge/scripts/c4-content-schema.js';
import { acceptDelivery } from '../src/lib/chat/channel.js';

const dashboard = fileURLToPath(new URL('../', import.meta.url));
const core = path.resolve(dashboard, '../..');
const observer = new URL('./helpers/channel-delivery-observer.js', import.meta.url).href;
const fixtures = JSON.parse(fs.readFileSync(path.join(core, 'test/fixtures/c4-content-protocol.json'), 'utf8'));

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-channel-'));
  let db;
  t.after(() => { db?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const home = path.join(root, 'h'), zylos = path.join(home, 'zylos');
  const skills = path.join(zylos, '.claude/skills'), tmp = path.join(root, 'tmp'), bin = path.join(root, 'bin');
  for (const directory of [skills, tmp, bin, path.join(zylos, 'comm-bridge'), path.join(zylos, '.zylos')]) fs.mkdirSync(directory, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.writeFileSync(path.join(zylos, '.zylos/config.json'), JSON.stringify({ runtime: 'codex', session_mode: 'multi' }));
  for (const name of ['comm-bridge', 'dashboard']) {
    const source = path.join(core, 'skills', name), dest = path.join(skills, name);
    fs.mkdirSync(dest);
    for (const file of ['package.json', 'SKILL.md']) fs.copyFileSync(path.join(source, file), path.join(dest, file));
    fs.cpSync(path.join(source, 'scripts'), path.join(dest, 'scripts'), { recursive: true, filter: file => !file.split(path.sep).includes('__tests__') });
    fs.symlinkSync(fs.realpathSync(path.join(source, 'node_modules')), path.join(dest, 'node_modules'));
    if (name === 'comm-bridge') fs.copyFileSync(path.join(source, 'init-db.sql'), path.join(dest, 'init-db.sql'));
    else fs.cpSync(path.join(source, 'src/lib'), path.join(dest, 'src/lib'), { recursive: true });
  }
  // The attachment service imports only WC's existing shared utility, not its server.
  const utility = path.join(skills, 'web-console');
  fs.mkdirSync(path.join(utility, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(core, 'skills/web-console/package.json'), path.join(utility, 'package.json'));
  fs.copyFileSync(path.join(core, 'skills/web-console/scripts/attachment-utils.js'), path.join(utility, 'scripts/attachment-utils.js'));
  fs.symlinkSync(fs.realpathSync(path.join(core, 'skills/web-console/node_modules')), path.join(utility, 'node_modules'));
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: path.join(root, 'pm2'), TMPDIR: tmp,
    TMUX_TMPDIR: tmp, PATH: bin, ZYLOS_PACKAGE_ROOT: core, ZYLOS_SESSION_GROUP: 'origin',
    CHANNEL_SEND_LOG: path.join(root, 'sends'), CHANNEL_HTTP_LOG: path.join(root, 'http'),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${observer}` };
  for (const key of Object.keys(env)) if (key === 'TMUX' || /TOKEN|SECRET|PASSWORD|API_KEY/.test(key) || ['ZYLOS_RUN_ID', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID'].includes(key)) delete env[key];
  const dbPath = path.join(zylos, 'comm-bridge/c4.db');
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) assert.ok(env[key].startsWith(root + path.sep));
  assert.ok(dbPath.startsWith(root + path.sep));
  console.log('Channel isolation:', JSON.stringify({ ...Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'PATH'].map(key => [key, env[key]])), dbPath, tmux: 'not spawned' }));
  db = new Database(dbPath); guardDatabase(db, schema);
  const store = createStore(db, { validateComponent: () => true, readConfig: () => ({ state: 'ok', config: { runtime: 'codex', session_mode: 'multi' } }) });
  const invoke = (script, args, input) => spawnSync(process.execPath, [script, ...args], { env, cwd: root, input, encoding: 'utf8', timeout: 5000 });
  const send = input => invoke(path.join(skills, 'comm-bridge/scripts/c4-send.js'), ['dashboard', 'conversation_a', '--session-group', 'conversation_a'], input);
  const receive = packet => invoke(path.join(skills, 'dashboard/scripts/send.js'), [], typeof packet === 'string' ? packet : JSON.stringify(packet));
  const insert = (content, options = {}) => store.insertConversation(options.direction || 'out', options.channel || 'dashboard', options.endpoint || 'conversation_a', content, { status: options.direction === 'in' ? 'pending' : 'delivered', groupName: options.group || 'conversation_a' });
  return { root, env, db, store, send, receive, insert, invoke, skills };
}
const packetFor = row => ({ version: 1, c4_id: row.id, channel: row.channel, endpoint_id: row.endpoint_id, session_group: row.session_group, content: row.content });
const count = (f, table) => f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const noHttpOrDashboard = f => {
  assert.equal(fs.existsSync(f.env.CHANNEL_HTTP_LOG), false);
  assert.equal(fs.existsSync(path.join(f.env.ZYLOS_DIR, 'components/dashboard')), false);
};

// Boundary: read-only authority lookup. Run on channel/schema changes; skip for UI-only edits.
test('Dashboard delivery associates identical sends with their exact stored IDs', t => {
  const f = setup(t), text = 'Unicode 😀 中 "quotes"\nnext line';
  const a = f.insert(text), b = f.insert(text);
  for (const row of [a, b]) {
    const accepted = acceptDelivery(packetFor(row), { env: f.env });
    assert.equal(accepted.id, String(row.id));
    assert.equal(f.receive(packetFor(row)).status, 0);
  }
  assert.notEqual(a.id, b.id);
  assert.equal(count(f, 'conversations'), 2); assert.equal(count(f, 'group_heads'), 1);
  noHttpOrDashboard(f);
});

// Boundary: authoritative mismatch rejection. Run on packet/lookup changes; skip for UI-only edits.
test('Dashboard rejects forged IDs and mismatched channel endpoint group content or direction', t => {
  const f = setup(t), row = f.insert('original'), packet = packetFor(row);
  for (const change of [{ c4_id: 999 }, { c4_id: [] }, { channel: 'other' }, { endpoint_id: 'other' },
    { session_group: 'dashboard:other' }, { content: 'other' }, { version: 2 }, { extra: true }]) {
    assert.notEqual(f.receive({ ...packet, ...change }).status, 0, JSON.stringify(change));
  }
  for (const options of [{ channel: 'other' }, { direction: 'in' }]) assert.notEqual(f.receive(packetFor(f.insert('original', options))).status, 0);
  for (const value of ['bad json', '{}', 'null']) assert.notEqual(f.receive(value).status, 0);
  noHttpOrDashboard(f);
});

// Boundary: SQLite 64-bit identity and shared fixture. Run on ID/DB changes; skip for UI-only edits.
test('Dashboard accepts the shared delivery fixture and canonical SQLite IDs without rounding', t => {
  const f = setup(t), example = fixtures.delivery.find(item => item.valid);
  const row = example.row;
  f.db.prepare('INSERT INTO conversations(id,direction,channel,endpoint_id,session_group,content,status) VALUES(?,?,?,?,?,?,?)')
    .run(row.id, 'out', row.channel, row.endpoint_id, row.session_group, row.content, 'delivered');
  assert.equal(f.receive(example.packet).status, 0);
  f.db.prepare("INSERT INTO conversations(id,direction,channel,endpoint_id,session_group,content,status) VALUES(9223372036854775807,'out','dashboard','e','dashboard:g','large ID','delivered')").run();
  const packet = { version: 1, c4_id: '9223372036854775807', channel: 'dashboard', endpoint_id: 'e', session_group: 'dashboard:g', content: 'large ID' };
  assert.equal(f.receive(packet).status, 0);
  assert.notEqual(f.receive({ ...packet, c4_id: '09223372036854775807' }).status, 0);
});

// Boundary: awaited notification calls real c4-send and real Dashboard receiver, no HTTP callback.
// Run on send/status notification changes; skip for UI-only edits. No runtime/socket is created.
test('Core status notification traverses the real Dashboard receiver without HTTP or extra groups', t => {
  const f = setup(t);
  const result = f.invoke(fileURLToPath(new URL('./helpers/channel-status-notice.js', import.meta.url)), [], '');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(count(f, 'conversations'), 1); assert.equal(count(f, 'group_heads'), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.env.CHANNEL_SEND_LOG, 'utf8').trim()), []);
  noHttpOrDashboard(f);
});

const attachmentContent = data => CONTENT_PREFIX + JSON.stringify({ version: 1, kind: 'message',
  messageId: 'attachment_reference', fallbackText: 'report.txt', blocks: [{ id: 'file', type: 'x-zylos.file', schemaVersion: 1,
    data, fallbackText: 'report.txt' }] });
for (const [name, content] of [
  ['marked content', CONTENT_PREFIX + '{}'], ['oversized Unicode', '😀'.repeat(MAX_CONTENT_BYTES / 4) + 'a'],
  ['attachment path', attachmentContent({ path: '/tmp/source.txt', nameSnapshot: 'report.txt' })],
  ['attachment URL', attachmentContent({ attachmentId: 'missing', nameSnapshot: 'report.txt', url: 'https://example.invalid/report.txt' })],
  ['unknown attachment data', attachmentContent({ attachmentId: 'missing', nameSnapshot: 'report.txt', size: 10 })],
  ['missing attachment ID', attachmentContent({ nameSnapshot: 'report.txt' })],
]) {
  // Boundary: actual pre-storage hook rejection. Run on Core/hook/transport changes; skip for UI-only edits.
  test(`Real send rejects ${name} before storage or receiver invocation`, t => {
    const f = setup(t), result = f.send(content);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /HOOK_ABORTED/);
    assert.equal(JSON.parse(result.stdout.trim()).error.code, 'HOOK_ABORTED');
    for (const table of ['conversations', 'group_heads', 'channel_namespaces']) assert.equal(count(f, table), 0, table);
    assert.equal(fs.existsSync(f.env.CHANNEL_SEND_LOG), false);
    noHttpOrDashboard(f);
  });
}

// Boundary: both installed ends and original UTF-8 content. Run on transport/hook changes; skip for UI-only edits.
test('Real Dashboard sends preserve Unicode quotes and the inclusive byte limit', t => {
  const f = setup(t), content = '😀中 "quoted"\n' + 'x'.repeat(MAX_CONTENT_BYTES - Buffer.byteLength('😀中 "quoted"\n'));
  assert.equal(Buffer.byteLength(content), MAX_CONTENT_BYTES);
  for (let i = 0; i < 2; i++) {
    const result = f.send(content + '\n');
    assert.equal(result.status, 0, result.stderr);
  }
  const rows = f.db.prepare('SELECT * FROM conversations ORDER BY id').all();
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.content, content);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.equal(count(f, 'group_heads'), 1);
  assert.equal(fs.readFileSync(f.env.CHANNEL_SEND_LOG, 'utf8'), '[]\n[]\n');
  noHttpOrDashboard(f);
});

// Boundary: a missing C4 database must fail closed without creating one.
// Run on database path/open changes; skip for UI-only edits.
test('Dashboard reports an unavailable authority without creating a database', t => {
  const f = setup(t), missing = path.join(f.root, 'missing');
  assert.throws(() => acceptDelivery(packetFor(f.insert('text')), { env: { ...f.env, ZYLOS_DIR: missing } }), { code: 'C4_READ_FAILED' });
  assert.equal(fs.existsSync(missing), false);
});
