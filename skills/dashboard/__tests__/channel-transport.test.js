import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { guardDatabase } from '../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../comm-bridge/scripts/c4-schema.js';
import { createStore } from '../../comm-bridge/scripts/c4-v2-store.js';
import { MAX_CONTENT_BYTES } from '../../comm-bridge/scripts/c4-content-schema.js';

const dashboard = fileURLToPath(new URL('../', import.meta.url));
const core = path.resolve(dashboard, '../..');
const observer = new URL('./helpers/channel-delivery-observer.js', import.meta.url).href;

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
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: path.join(root, 'pm2'), TMPDIR: tmp,
    TMUX_TMPDIR: tmp, PATH: bin, ZYLOS_PACKAGE_ROOT: core,
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

// Boundary: awaited notification calls real c4-send and real Dashboard receiver, no HTTP callback.
// Run on send/status notification changes; skip for UI-only edits. No runtime/socket is created.

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
