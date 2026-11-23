import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { Store } from '../src/lib/store.js';
import { inspectDatabase, migrateDatabase, TARGET_SCHEMA_VERSION } from '../src/lib/schema.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { ChatAttachments, ATTACHMENT_SEND_WINDOW_MS, ATTACHMENT_TTL_MS } from '../src/lib/chat/attachments.js';
import { buildAnnotatedContent } from '../../comm-bridge/scripts/attachment-annotations.js';
import { guardDatabase } from '../../comm-bridge/scripts/sqlite-schema.js';
import * as coreSchema from '../../comm-bridge/scripts/c4-schema.js';

// Exercise real Dashboard migrations, C4 queries and private files. Run when
// attachment persistence, authorization, linking or collection changes; skip
// for unrelated UI changes. The official runner isolates HOME/ZYLOS_DIR/
// PM2_HOME/TMPDIR before imports. These cases start no HTTP, process or runtime
// and use neither PM2 nor tmux. Every handle closes before its fixture is removed.
function fixture(t, { now = 10_000_000, coreReader } = {}) {
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key] && !process.env[key].startsWith(os.userInfo().homedir + path.sep), `${key} must be isolated`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachments-'));
  const dashboardPath = path.join(root, 'dashboard.db');
  const corePath = path.join(root, 'c4.db');
  console.log(JSON.stringify({ isolated: true, home: process.env.HOME, zylosDir: root,
    pm2Home: process.env.PM2_HOME, tmpdir: process.env.TMPDIR, privateSocket: path.join(root, 'tmux.sock'), dashboardPath, corePath }));
  const core = new Database(corePath);
  guardDatabase(core, coreSchema);
  core.prepare('INSERT INTO channel_namespaces(namespace,component_name) VALUES(?,?)').run('dash', 'dashboard');
  const store = new Store(dashboardPath);
  const conversations = new ChatConversations({ store });
  const a = conversations.create(), b = conversations.create();
  let clock = now;
  let unavailable = false;
  let coreReads = 0;
  const reader = coreReader ?? { _open() { coreReads++; if (unavailable) throw Error('fixture Core unavailable'); return core; } };
  const make = () => new ChatAttachments({ store, c4Reader: reader, zylosDir: root, now: () => clock });
  const instances = [];
  const attachments = make(); instances.push(attachments);
  fs.mkdirSync(path.join(root, 'workspace'));
  const add = (content, options = {}) => {
    const localId = options.localId ?? a.localId;
    const result = core.prepare(`INSERT INTO conversations(direction,channel,endpoint_id,session_group,content,status)
      VALUES (?,?,?,?,?,?)`).run(options.direction ?? 'in', options.channel ?? 'dashboard', localId,
      options.group ?? `dash:${localId}`, content, options.status ?? 'failed');
    return core.prepare('SELECT * FROM conversations WHERE id=?').get(result.lastInsertRowid);
  };
  const upload = (options = {}) => attachments.prepareUser(options.conversation ?? a,
    { name: options.name ?? 'report.txt', mime: options.mime ?? 'text/plain', principal: options.principal ?? 'owner-session',
      stream: options.stream ?? Readable.from([Buffer.from('attachment bytes')]) });
  const saved = id => store.db.prepare('SELECT * FROM chat_attachments WHERE id=?').get(id);
  t.after(async () => {
    for (const instance of instances) await instance.close();
    core.close(); store.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, core, store, conversations, a, b, attachments, add, upload, saved,
    setTime(value) { clock = value; }, advance(value) { clock += value; }, getTime() { return clock; },
    setUnavailable(value) { unavailable = value; },
    resetReads() { coreReads = 0; }, reads() { return coreReads; },
    reopen() { const next = make(); instances.push(next); return next; },
    annotation(record) { return buildAnnotatedContent('', attachments.prepareSend(a, [record.id], 'owner-session')); },
  };
}

test('attachment schema migrates an existing database without removing custom objects', t => {
  const f = fixture(t);
  assert.equal(inspectDatabase(f.store.db).needsMigration, false);
  f.store.db.exec('CREATE TABLE custom_attachment_owner(value TEXT); INSERT INTO custom_attachment_owner VALUES(\'keep\')');
  f.store.db.exec('DROP TABLE chat_attachment_messages; DROP TABLE chat_attachments; DELETE FROM schema_migrations WHERE version>=26');
  assert.equal(inspectDatabase(f.store.db).currentVersion, 25);
  migrateDatabase(f.store.db);
  assert.equal(inspectDatabase(f.store.db).currentVersion, TARGET_SCHEMA_VERSION);
  f.store.db.exec('DELETE FROM schema_migrations WHERE version>=26');
  migrateDatabase(f.store.db);
  assert.equal(inspectDatabase(f.store.db).currentVersion, TARGET_SCHEMA_VERSION);
  assert.equal(f.store.db.prepare('SELECT value FROM custom_attachment_owner').get().value, 'keep');
  f.store.db.exec('DROP INDEX idx_chat_attachments_due');
  assert.throws(() => inspectDatabase(f.store.db), /attachment lookup index/);
});

test('agent register checks roots, kind, magic bytes and preserves an independent fresh copy', async t => {
  const f = fixture(t);
  const source = path.join(f.root, 'workspace', 'picture.png');
  fs.writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  fs.utimesSync(source, new Date(0), new Date(0));
  const before = f.add('before registration');
  const result = await f.attachments.register(f.a, { kind: 'image', path: source });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'image');
  assert.equal(result.expiresAt, f.getTime() + ATTACHMENT_SEND_WINDOW_MS);
  assert.equal(f.saved(result.attachmentId).source, 'agent');
  assert.equal(f.saved(result.attachmentId).c4_watermark, before.id);
  assert.equal(f.saved(result.attachmentId).scanned_c4_id, before.id);
  assert.ok(fs.statSync(f.attachments.resolve(f.a.localId, result.attachmentId)).mtimeMs > 0);
  assert.throws(() => f.attachments.prepareSend(f.a, [result.attachmentId], 'owner-session'));
  fs.unlinkSync(source);
  assert.equal(fs.readFileSync(f.attachments.resolve(f.a.localId, result.attachmentId)).length, 8);
  assert.throws(() => f.attachments.resolve(f.b.localId, result.attachmentId));
  const text = path.join(f.root, 'workspace', 'false.png'); fs.writeFileSync(text, 'not an image');
  await assert.rejects(f.attachments.register(f.a, { kind: 'image', path: text }), { code: 'chat_attachment_not_image' });
  await assert.rejects(f.attachments.register(f.a, { kind: 'file', path: f.root }), { code: 'chat_attachment_source_forbidden' });
  await assert.rejects(f.attachments.register(f.a, { kind: 'file', path: 'relative.txt' }));
  await assert.rejects(f.attachments.register(f.a, { kind: 'file', path: path.join(f.root, 'workspace') }), { code: 'chat_attachment_source_forbidden' });
});

test('watermark, foreign groups, substrings, malformed and nonmanaged annotations cannot link', async t => {
  const f = fixture(t);
  const prior = f.add('before upload');
  const result = await f.upload(), annotation = f.annotation(result);
  f.core.prepare('UPDATE conversations SET content=? WHERE id=?').run(annotation, prior.id);
  const rows = [
    f.core.prepare('SELECT * FROM conversations WHERE id=?').get(prior.id),
    f.add(annotation, { localId: f.b.localId }),
    // Conversations are identified by endpoint, not recording group: another
    // conversation's row cannot link even when recorded under this conversation's group.
    f.add(annotation, { localId: f.b.localId, group: `dash:${f.a.localId}` }),
    f.add('prefix ' + annotation),
    f.add(annotation.slice(0, -1)),
    f.add('[attachment:file /outside/report.txt name="report.txt" 16B]'),
    f.add(annotation, { direction: 'out' }),
  ];
  for (const row of rows) f.attachments.linkRow(row);
  const forged = { ...f.add('real content'), content: annotation };
  assert.equal(f.attachments.linkRow(forged).length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_attachment_messages').get().n, 0);
  assert.throws(() => f.attachments.download(f.a.localId, result.id));
  f.advance(ATTACHMENT_TTL_MS);
  await f.attachments.gc();
  assert.equal(f.saved(result.id), undefined);
});

test('GC waits thirty minutes and recovers an unacknowledged authoritative reference', async t => {
  const f = fixture(t), result = await f.upload(), annotation = f.annotation(result);
  f.add(annotation);
  f.advance(ATTACHMENT_TTL_MS - 1);
  await f.attachments.gc();
  assert.equal(f.saved(result.id).scan_upper_id, null);
  f.advance(1);
  await f.attachments.gc();
  assert.ok(f.saved(result.id));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_attachment_messages').get().n, 1);
});

test('media aliases use one storage identity while symlink escapes remain unreadable', async t => {
  const f = fixture(t), result = await f.upload(), file = f.attachments.resolve(f.a.localId, result.id);
  const alias = path.join(f.root, 'media-alias'); fs.symlinkSync(f.attachments.mediaDir, alias);
  const annotation = buildAnnotatedContent('', [{ ...result, path: path.join(alias, path.basename(file)) }]);
  assert.equal(f.attachments.linkRow(f.add(annotation))[0].available, true);
  fs.unlinkSync(file);
  const outside = path.join(f.root, 'outside.txt'); fs.writeFileSync(outside, 'outside');
  fs.symlinkSync(outside, file);
  assert.throws(() => f.attachments.resolve(f.a.localId, result.id));
  assert.throws(() => f.attachments.download(f.a.localId, result.id));
  f.advance(ATTACHMENT_TTL_MS);
  await f.attachments.gc();
  assert.equal(fs.existsSync(outside), true);
});
