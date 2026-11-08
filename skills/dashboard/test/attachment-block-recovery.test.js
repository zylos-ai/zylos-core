import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Store } from '../src/lib/store.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { ChatAttachments, ATTACHMENT_TTL_MS, ATTACHMENT_GC_INTERVAL_MS } from '../src/lib/chat/attachments.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { ChatHistory } from '../src/lib/chat/history.js';
import { buildAnnotatedContent } from '../../web-console/scripts/attachment-utils.js';
import { CONTENT_PREFIX, parseC4Content } from '../../comm-bridge/scripts/c4-content-schema.js';
import { guardDatabase } from '../../comm-bridge/scripts/sqlite-schema.js';
import * as coreSchema from '../../comm-bridge/scripts/c4-schema.js';

// Integration boundary: real typed outbound content, private Core/Dashboard
// databases, history and persisted GC cursors. Run for attachment reference,
// association/history/GC or fixture isolation changes; unrelated UI may skip.
// No runtime, model, tmux or PM2 starts. Imports do not read instance paths;
// every product constructor runs after this fixture sets its own environment.
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'abr-')));
  const env = { HOME: path.join(root, 'home'), ZYLOS_DIR: root,
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmp') };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  let core, store, reader, attachments;
  t.after(async () => {
    try { await attachments?.close(); }
    finally {
      try { reader?.close(); core?.close(); store?.close(); }
      finally {
        fs.rmSync(root, { recursive: true, force: true });
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        assert.equal(fs.existsSync(root), false);
      }
    }
  });
  for (const directory of new Set(Object.values(env))) fs.mkdirSync(directory, { recursive: true });
  Object.assign(process.env, env);
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  fs.mkdirSync(path.join(root, 'workspace'));
  const corePath = path.join(root, 'comm-bridge/c4.db'), dashboardPath = path.join(root, 'dashboard.db');
  const realHome = fs.realpathSync(os.userInfo().homedir);
  assert.ok(!root.startsWith(realHome + path.sep), 'fixture is outside the real home');
  for (const key of Object.keys(env)) {
    const actual = fs.realpathSync(process.env[key]);
    assert.ok(actual === root || actual.startsWith(root + path.sep), `${key} belongs to the fixture`);
  }
  for (const target of [corePath, dashboardPath]) assert.ok(target.startsWith(root + path.sep));
  console.log(JSON.stringify({ root, corePath, dashboardPath, ...env, tmux: 'not spawned',
    privateSocket: path.join(env.TMUX_TMPDIR, 'tmux.sock') }));
  core = new Database(corePath);
  guardDatabase(core, coreSchema);
  core.prepare('INSERT INTO channel_namespaces(namespace,component_name) VALUES(?,?)').run('dash', 'dashboard');
  store = new Store(dashboardPath); reader = new C4Reader(root);
  let clock = 10_000_000;
  const conversations = new ChatConversations({ store });
  const a = conversations.create(), b = conversations.create();
  const make = () => new ChatAttachments({ store, c4Reader: reader, zylosDir: root, now: () => clock });
  attachments = make();
  assert.equal(core.name, corePath);
  assert.equal(store.db.name, dashboardPath);
  assert.equal(reader._dbPath, corePath);
  const add = (content, { direction = 'out', localId = a.localId, group = `dash:${localId}` } = {}) => {
    const result = core.prepare(`INSERT INTO conversations(direction,channel,endpoint_id,session_group,content,status)
      VALUES (?,'dashboard',?,?,?,'failed')`).run(direction, localId, group, content);
    return core.prepare('SELECT * FROM conversations WHERE id=?').get(result.lastInsertRowid);
  };
  return { root, core, a, b, add, get store() { return store; }, get attachments() { return attachments; },
    history: () => new ChatHistory({ c4Reader: reader, attachments }),
    saved: id => store.db.prepare('SELECT * FROM chat_attachments WHERE id=?').get(id),
    links: id => store.db.prepare('SELECT c4_id FROM chat_attachment_messages WHERE attachment_id=? ORDER BY c4_id').all(id).map(row => row.c4_id),
    advance(ms) { clock += ms; },
    async reopen() {
      await attachments.close(); reader.close(); store.close();
      store = new Store(dashboardPath); reader = new C4Reader(root); attachments = make();
    },
  };
}
function content(id, name = 'report.txt') {
  const fallbackText = `File: ${name} (attachment ${id})`;
  const raw = CONTENT_PREFIX + JSON.stringify({ version: 1, kind: 'message', messageId: 'same-message-id', fallbackText,
    blocks: [{ id: 'report', type: 'x-zylos.file', schemaVersion: 1,
      data: { attachmentId: id, nameSnapshot: name }, fallbackText }] });
  assert.equal(parseC4Content(raw).kind, 'envelope');
  return raw;
}
async function register(f) {
  const source = path.join(f.root, 'workspace/report.txt');
  fs.writeFileSync(source, 'private agent bytes');
  const result = await f.attachments.register(f.a, { kind: 'file', path: source });
  fs.unlinkSync(source);
  return result;
}

test('history repairs missed outbound callbacks, retains every row and shares download authorization across sources', async t => {
  const f = fixture(t), agent = await register(f);
  const user = await f.attachments.prepareUser(f.a, { name: 'user.txt', mime: 'text/plain', principal: 'owner', stream: Readable.from(['user bytes']) });
  const annotation = buildAnnotatedContent('', f.attachments.prepareSend(f.a, [user.id], 'owner'));
  const inbound = f.add(annotation, { direction: 'in' });
  const one = f.add(content(agent.attachmentId)), two = f.add(content(agent.attachmentId));
  assert.deepEqual(f.links(agent.attachmentId), []);
  f.store.db.exec("CREATE TRIGGER reject_block_link BEFORE INSERT ON chat_attachment_messages BEGIN SELECT RAISE(ABORT,'fixture association'); END");
  const conversationId = `g:${Buffer.from(`dash:${f.a.localId}`).toString('hex').toUpperCase()}`;
  const unavailable = f.history().messages(conversationId);
  assert.equal(unavailable.items.find(row => row.id === one.id).attachments[0].available, false);
  assert.deepEqual(f.links(agent.attachmentId), []);
  f.store.db.exec('DROP TRIGGER reject_block_link');
  f.advance(ATTACHMENT_TTL_MS * 3);
  const recovered = f.history().messages(conversationId);
  assert.equal(recovered.items.length, 3);
  for (const row of recovered.items) {
    assert.equal(row.attachments[0].available, true);
    assert.equal(Object.hasOwn(row.attachments[0], 'path'), false);
    assert.equal(Object.hasOwn(row.attachments[0], 'storage_name'), false);
  }
  assert.deepEqual(f.links(agent.attachmentId), [one.id, two.id]);
  assert.deepEqual(f.links(user.id), [inbound.id]);
  f.history().messages(conversationId);
  assert.deepEqual(f.links(agent.attachmentId), [one.id, two.id]);
  for (const [id, bytes] of [[agent.attachmentId, 'private agent bytes'], [user.id, 'user bytes']]) {
    assert.equal(fs.readFileSync(f.attachments.resolve(f.a.localId, id), 'utf8'), bytes);
    assert.equal(fs.readFileSync(f.attachments.download(f.a.localId, id).path, 'utf8'), bytes);
    assert.throws(() => f.attachments.download(f.b.localId, id), /unavailable/);
    assert.throws(() => f.attachments.resolve(f.b.localId, id), /unavailable/);
  }
  await f.attachments.gc();
  assert.ok(f.saved(agent.attachmentId)); assert.ok(f.saved(user.id));
});

test('outbound watermark GC resumes persisted pages after restart and repairs a missed callback', async t => {
  const f = fixture(t), registered = await register(f), id = registered.attachmentId;
  for (let i = 0; i < 450; i++) f.add(`ordinary-${i}`);
  const reference = f.add(content(id));
  f.advance(ATTACHMENT_TTL_MS);
  await f.attachments.gc();
  assert.equal(f.saved(id).scanned_c4_id, 200);
  assert.equal(f.saved(id).scan_upper_id, reference.id);
  for (let i = 0; i < 20; i++) f.add(`after-upper-${i}`);
  await f.reopen();
  f.advance(ATTACHMENT_GC_INTERVAL_MS);
  await f.attachments.gc();
  assert.equal(f.saved(id).scanned_c4_id, 400);
  assert.equal(f.saved(id).scan_upper_id, reference.id);
  assert.deepEqual(f.links(id), []);
  await f.reopen();
  f.advance(ATTACHMENT_GC_INTERVAL_MS);
  await f.attachments.gc();
  assert.deepEqual(f.links(id), [reference.id]);
  assert.equal(fs.readFileSync(f.attachments.download(f.a.localId, id).path, 'utf8'), 'private agent bytes');
});

test('outbound GC preserves an unlinked copy after association failure and retries the real reference', async t => {
  const f = fixture(t), registered = await register(f), id = registered.attachmentId;
  const row = f.add(content(id));
  f.store.db.exec("CREATE TRIGGER reject_gc_link BEFORE INSERT ON chat_attachment_messages BEGIN SELECT RAISE(ABORT,'fixture association'); END");
  f.advance(ATTACHMENT_TTL_MS);
  await f.attachments.gc();
  assert.ok(f.saved(id));
  assert.equal(f.saved(id).scanned_c4_id, 0);
  assert.equal(f.saved(id).scan_upper_id, row.id);
  assert.deepEqual(f.links(id), []);
  f.store.db.exec('DROP TRIGGER reject_gc_link');
  await f.reopen();
  f.advance(ATTACHMENT_GC_INTERVAL_MS);
  await f.attachments.gc();
  assert.deepEqual(f.links(id), [row.id]);
  assert.ok(f.saved(id));
});

// Boundary: rows can arrive without BeforeSend (for example through admin
// insert). Invalid attachment states must not poison either history tab or GC.
test('invalid attachment lifecycle rows cannot break either history tab or block GC repair', async t => {
  const f = fixture(t), registered = await register(f), id = registered.attachmentId;
  const invalidRows = [];
  for (const type of ['x-zylos.image', 'x-zylos.file']) {
    for (const status of [undefined, 'complete', 'pending', 'error']) {
      const block = { id: 'broken', type, schemaVersion: 1, fallbackText: 'Unavailable attachment',
        ...(status ? { status } : {}), ...(status === 'error' ? { reason: 'unavailable' } : {}) };
      const raw = CONTENT_PREFIX + JSON.stringify({ version: 1, kind: 'message', messageId: 'bad-attachment',
        fallbackText: 'Unavailable attachment', blocks: [block] });
      assert.equal(parseC4Content(raw).kind, 'invalid');
      const own = f.add(raw); invalidRows.push(own);
      f.core.prepare(`INSERT INTO conversations(direction,channel,endpoint_id,session_group,content,status)
        VALUES ('out','web-console','console','wc:console',?,'failed')`).run(raw);
      assert.deepEqual(f.attachments.linkRow(own), []);
    }
  }
  for (const tab of ['mine', 'external']) {
    const history = f.history(), list = history.list({ tab });
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].preview, '无法显示的消息');
    const messages = history.messages(list.items[0].id, { tab });
    assert.equal(messages.items.length, 8);
    for (const row of messages.items) assert.deepEqual(row.attachments, []);
  }
  const valid = f.add(content(id));
  f.advance(ATTACHMENT_TTL_MS);
  await f.attachments.gc();
  assert.deepEqual(f.links(id), [valid.id]);
  assert.ok(f.saved(id));
});
