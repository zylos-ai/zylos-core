import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Store } from '../src/lib/store.js';
import { inspectDatabase, migrateDatabase, TARGET_SCHEMA_VERSION } from '../src/lib/schema.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { ChatAttachments, ATTACHMENT_SEND_WINDOW_MS, ATTACHMENT_TTL_MS, ATTACHMENT_GC_INTERVAL_MS } from '../src/lib/chat/attachments.js';
import { buildAnnotatedContent } from '../../web-console/scripts/attachment-utils.js';
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
  assert.equal(TARGET_SCHEMA_VERSION, 26);
  assert.equal(inspectDatabase(f.store.db).needsMigration, false);
  f.store.db.exec('CREATE TABLE custom_attachment_owner(value TEXT); INSERT INTO custom_attachment_owner VALUES(\'keep\')');
  f.store.db.exec('DROP TABLE chat_attachment_messages; DROP TABLE chat_attachments; DELETE FROM schema_migrations WHERE version=26');
  assert.equal(inspectDatabase(f.store.db).currentVersion, 25);
  migrateDatabase(f.store.db);
  assert.equal(inspectDatabase(f.store.db).currentVersion, 26);
  f.store.db.exec('DELETE FROM schema_migrations WHERE version=26');
  migrateDatabase(f.store.db);
  assert.equal(inspectDatabase(f.store.db).currentVersion, 26);
  assert.equal(f.store.db.prepare('SELECT value FROM custom_attachment_owner').get().value, 'keep');
  f.store.db.exec('DROP INDEX idx_chat_attachments_due');
  assert.throws(() => inspectDatabase(f.store.db), /attachment lookup index/);
});

test('a user copy is private and complete without creating a Core head', async t => {
  const f = fixture(t);
  const result = await f.upload({ name: '../quoted"\nreport.txt' });
  assert.equal(result.expiresAt, f.getTime() + ATTACHMENT_SEND_WINDOW_MS);
  const saved = f.saved(result.id);
  assert.equal(saved.source, 'user');
  assert.equal(saved.principal, 'owner-session');
  assert.equal(saved.created_at, f.getTime());
  assert.equal(saved.c4_watermark, 0);
  assert.equal(saved.next_check_at, f.getTime() + ATTACHMENT_TTL_MS);
  assert.equal(saved.scan_upper_id, null);
  assert.equal(fs.readFileSync(f.attachments.resolve(f.a.localId, result.id), 'utf8'), 'attachment bytes');
  assert.equal(fs.statSync(f.attachments.resolve(f.a.localId, result.id)).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(f.attachments.mediaDir, saved.storage_name + '.part')), false);
  assert.equal(f.core.prepare('SELECT count(*) AS n FROM group_heads').get().n, 0);
  assert.equal(f.core.prepare('SELECT count(*) AS n FROM conversations').get().n, 0);
  assert.throws(() => f.attachments.download(f.a.localId, result.id), /unavailable/);
});

test('user send requires the same source, conversation, principal and strict preparation window', async t => {
  const f = fixture(t), result = await f.upload();
  assert.equal(f.attachments.prepareSend(f.a, [result.id], 'owner-session').length, 1);
  assert.throws(() => f.attachments.prepareSend(f.a, [result.id], 'other-session'));
  assert.throws(() => f.attachments.prepareSend(f.b, [result.id], 'owner-session'));
  assert.throws(() => f.attachments.prepareSend(f.a, [result.id, result.id], 'owner-session'));
  assert.throws(() => f.attachments.prepareSend(f.a, Array.from({ length: 21 }, (_, i) => `id-${i}`), 'owner-session'));
  f.advance(ATTACHMENT_SEND_WINDOW_MS - 1);
  assert.equal(f.attachments.prepareSend(f.a, [result.id], 'owner-session').length, 1);
  f.advance(1);
  assert.throws(() => f.attachments.prepareSend(f.a, [result.id], 'owner-session'));
  f.setUnavailable(true);
  assert.equal(f.attachments.prepareSend({}, [], null).length, 0, 'ordinary text sends never query Core');
});

test('the request-start watermark remains fixed while upload bytes arrive', async t => {
  const f = fixture(t);
  const watermark = f.attachments.captureWatermark();
  f.add('another message while receiving upload');
  const record = await f.attachments.prepareUser(f.a, { name: 'received.txt', mime: 'text/plain',
    stream: Readable.from(['received']), principal: 'owner-session', watermark });
  assert.equal(f.saved(record.id).c4_watermark, 0);
  assert.equal(f.saved(record.id).scanned_c4_id, 0);
});

test('twenty distinct attachments can be used and missing or future-dated records are rejected', async t => {
  const f = fixture(t);
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push((await f.upload()).id);
  assert.equal(f.attachments.prepareSend(f.a, ids, 'owner-session').length, 20);
  assert.throws(() => f.attachments.prepareSend(f.a, [ids[0], 'missing'], 'owner-session'));
  f.advance(-1);
  assert.throws(() => f.attachments.prepareSend(f.a, [ids[0]], 'owner-session'));
});

test('copy errors, byte limits, Core failures and failed record commits return no usable ID', async t => {
  const f = fixture(t);
  f.attachments.maxUploadBytes = 3;
  await assert.rejects(f.upload({ stream: Readable.from(['ab', 'cd']) }), { code: 'chat_attachment_too_large' });
  assert.equal(fs.readdirSync(f.attachments.mediaDir).length, 0);
  f.setUnavailable(true);
  await assert.rejects(f.upload());
  f.setUnavailable(false);
  f.attachments.maxUploadBytes = 100;
  f.store.db.exec("CREATE TRIGGER reject_attachment BEFORE INSERT ON chat_attachments BEGIN SELECT RAISE(ABORT,'fixture insert'); END");
  await assert.rejects(f.upload(), { code: 'chat_attachment_write_failed' });
  assert.equal(fs.readdirSync(f.attachments.mediaDir).length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_attachments').get().n, 0);
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

test('exact authoritative rows link idempotently and survive failed receipts and preparation expiry', async t => {
  const f = fixture(t), result = await f.upload();
  const annotation = f.annotation(result);
  const one = f.add(annotation, { status: 'failed' });
  const two = f.add(annotation, { status: 'delivered' });
  assert.equal(f.attachments.linkRow(one)[0].available, true);
  assert.equal(f.attachments.linkRow(one)[0].available, true);
  assert.equal(f.attachments.linkRow(two)[0].available, true);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_attachment_messages').get().n, 2);
  f.advance(ATTACHMENT_TTL_MS * 3);
  assert.equal(f.attachments.prepareSend(f.a, [result.id], 'new-login').length, 1);
  await f.attachments.gc();
  assert.ok(f.saved(result.id));
  assert.equal(f.attachments.download(f.a.localId, result.id).id, result.id);
});

test('watermark, foreign groups, substrings, malformed and nonmanaged annotations cannot link', async t => {
  const f = fixture(t);
  const prior = f.add('before upload');
  const result = await f.upload(), annotation = f.annotation(result);
  f.core.prepare('UPDATE conversations SET content=? WHERE id=?').run(annotation, prior.id);
  const rows = [
    f.core.prepare('SELECT * FROM conversations WHERE id=?').get(prior.id),
    f.add(annotation, { localId: f.b.localId }),
    f.add(annotation, { group: `dash:${f.b.localId}` }),
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

test('pasted inbound annotations cannot link an unlinked agent attachment', async t => {
  const f = fixture(t);
  const source = path.join(f.root, 'workspace', 'report.txt');
  fs.writeFileSync(source, 'agent report');
  const registered = await f.attachments.register(f.a, { kind: 'file', path: source });
  const file = f.attachments.resolve(f.a.localId, registered.attachmentId);
  const annotation = buildAnnotatedContent('', [{ kind: 'file', name: registered.name, path: file, size: 12 }]);
  const row = f.add(annotation);
  assert.equal(f.attachments.linkRow(row)[0].available, false);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_attachment_messages WHERE attachment_id=?').get(registered.attachmentId).n, 0);
  assert.throws(() => f.attachments.download(f.a.localId, registered.attachmentId), { code: 'chat_attachment_unavailable' });
});

test('downloads reject vanished authoritative rows and collection preserves newly linked records', async t => {
  const f = fixture(t), uploaded = await f.upload();
  const record = f.saved(uploaded.id);
  const row = f.add(f.annotation(uploaded));
  assert.equal(f.attachments.linkRow(row)[0].available, true);
  await f.attachments._remove(record);
  assert.ok(f.saved(uploaded.id));
  assert.equal(f.attachments.download(f.a.localId, uploaded.id).id, uploaded.id);
  f.core.prepare('DELETE FROM conversations WHERE id=?').run(row.id);
  assert.throws(() => f.attachments.download(f.a.localId, uploaded.id), { code: 'chat_attachment_unavailable' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM chat_attachment_messages WHERE attachment_id=?').get(uploaded.id).n, 1);
});

test('a history batch repairs late links without Core N+1 reads and retries failed association', async t => {
  const f = fixture(t), rows = [];
  for (let i = 0; i < 20; i++) { const upload = await f.upload(); rows.push(f.add(f.annotation(upload))); }
  f.store.db.exec("CREATE TRIGGER reject_link BEFORE INSERT ON chat_attachment_messages BEGIN SELECT RAISE(ABORT,'fixture association'); END");
  assert.equal(f.attachments.metadata(rows).get(rows[0].id)[0].available, false);
  f.store.db.exec('DROP TRIGGER reject_link');
  f.resetReads();
  const recovered = f.attachments.metadata(rows);
  assert.equal(f.reads(), 1);
  for (const row of rows) assert.equal(recovered.get(row.id)[0].available, true);
  assert.throws(() => f.attachments.metadata(Array.from({ length: 101 }, () => rows[0])));
});

test('history metadata remains unavailable during Core query failures and recovers on the next read', async t => {
  const f = fixture(t), result = await f.upload();
  const row = f.add(f.annotation(result));
  f.setUnavailable(true);
  const unavailable = f.attachments.metadata([row]).get(row.id)[0];
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.name, result.name);
  assert.equal('id' in unavailable, false);
  assert.equal('path' in unavailable, false);
  assert.throws(() => f.attachments.metadata([{ ...row, id: 0 }]), { code: 'invalid_chat_message_ids' });
  assert.throws(() => f.attachments.metadata([null]), { code: 'invalid_chat_message_ids' });
  assert.throws(() => f.attachments.metadata(Array.from({ length: 101 }, () => row)), { code: 'invalid_chat_message_ids' });
  f.setUnavailable(false);
  f.core.exec('ALTER TABLE conversations RENAME TO unavailable_conversations');
  assert.equal(f.attachments.metadata([row]).get(row.id)[0].available, false);
  f.core.exec('ALTER TABLE unavailable_conversations RENAME TO conversations');
  assert.equal(f.attachments.metadata([row]).get(row.id)[0].available, true);
});

test('history metadata remains unavailable during Dashboard query failures and retries without cached failure', async t => {
  const f = fixture(t), result = await f.upload();
  const row = f.add(f.annotation(result));
  f.store.db.exec('ALTER TABLE chat_attachments RENAME TO unavailable_attachments');
  const unavailable = f.attachments.metadata([row]).get(row.id)[0];
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.name, result.name);
  assert.equal('id' in unavailable, false);
  assert.equal('path' in unavailable, false);
  f.store.db.exec('ALTER TABLE unavailable_attachments RENAME TO chat_attachments');
  assert.equal(f.attachments.metadata([row]).get(row.id)[0].available, true);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_attachment_messages').get().n, 1);
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

test('GC persists a two-page scan, keeps its first upper bound and resumes after reopen', async t => {
  const f = fixture(t), result = await f.upload();
  for (let i = 0; i < 450; i++) f.add(`irrelevant-${i}`);
  f.advance(ATTACHMENT_TTL_MS);
  await f.attachments.gc();
  assert.equal(f.saved(result.id).scanned_c4_id, 200);
  assert.equal(f.saved(result.id).scan_upper_id, 450);
  assert.equal(f.saved(result.id).next_check_at, f.getTime() + ATTACHMENT_GC_INTERVAL_MS);
  for (let i = 0; i < 250; i++) f.add(`beyond fixed scan-${i}`);
  await f.attachments.gc();
  assert.equal(f.saved(result.id).scanned_c4_id, 200);
  const reopened = f.reopen();
  f.advance(ATTACHMENT_GC_INTERVAL_MS);
  await reopened.gc();
  assert.equal(f.saved(result.id).scanned_c4_id, 400);
  assert.equal(f.saved(result.id).scan_upper_id, 450);
  f.advance(ATTACHMENT_GC_INTERVAL_MS);
  await reopened.gc();
  assert.equal(f.saved(result.id), undefined);
});

test('GC query and association failures preserve records and rotate the next check', async t => {
  const f = fixture(t), result = await f.upload(), annotation = f.annotation(result);
  f.add(annotation);
  f.advance(ATTACHMENT_TTL_MS);
  f.setUnavailable(true);
  await f.attachments.gc();
  assert.ok(f.saved(result.id));
  assert.equal(f.saved(result.id).scanned_c4_id, 0);
  assert.equal(f.saved(result.id).next_check_at, f.getTime() + ATTACHMENT_GC_INTERVAL_MS);
  f.setUnavailable(false);
  f.store.db.exec("CREATE TRIGGER reject_link BEFORE INSERT ON chat_attachment_messages BEGIN SELECT RAISE(ABORT,'fixture association'); END");
  f.advance(ATTACHMENT_GC_INTERVAL_MS);
  await f.attachments.gc();
  assert.ok(f.saved(result.id));
  assert.equal(f.saved(result.id).scanned_c4_id, 0);
  f.store.db.exec('DROP TRIGGER reject_link');
  f.advance(ATTACHMENT_GC_INTERVAL_MS);
  await f.attachments.gc();
  assert.equal(f.attachments.download(f.a.localId, result.id).id, result.id);
});

test('GC rotates a stuck first hundred so later candidates are collected', async t => {
  const f = fixture(t);
  const ids = [];
  for (let i = 0; i < 101; i++) ids.push((await f.upload()).id);
  f.advance(ATTACHMENT_TTL_MS);
  f.setUnavailable(true);
  assert.equal((await f.attachments.gc()).checked, 100);
  const due = f.store.db.prepare('SELECT id FROM chat_attachments WHERE next_check_at<=?').all(f.getTime());
  assert.equal(due.length, 1);
  f.setUnavailable(false);
  assert.equal((await f.attachments.gc()).checked, 1);
  assert.equal(f.saved(due[0].id), undefined);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_attachments').get().n, 100);
});

test('directory cleanup resumes after one hundred entries and only removes old unregistered names', async t => {
  const f = fixture(t), media = f.attachments.mediaDir;
  for (let i = 0; i < 120; i++) {
    const file = path.join(media, `orphan-${i}.part`); fs.writeFileSync(file, 'old'); fs.utimesSync(file, new Date(0), new Date(0));
  }
  const fresh = path.join(media, 'fresh.part'); fs.writeFileSync(fresh, 'fresh');
  fs.utimesSync(fresh, new Date(f.getTime()), new Date(f.getTime()));
  await f.attachments.gc();
  const afterFirst = fs.readdirSync(media).length;
  assert.ok(afterFirst >= 21 && afterFirst <= 22);
  await f.attachments.gc();
  assert.equal(fs.readdirSync(media).length, 1);
  assert.equal(fs.existsSync(fresh), true);
});

test('GC handles committed temporary copies and retries a failed file deletion', async t => {
  const f = fixture(t), result = await f.upload();
  const record = f.saved(result.id), file = f.attachments.resolve(f.a.localId, result.id);
  fs.renameSync(file, file + '.part');
  f.advance(ATTACHMENT_TTL_MS);
  await f.attachments.gc();
  assert.equal(f.saved(result.id), undefined);
  assert.equal(fs.existsSync(file + '.part'), false);
  const second = await f.upload(), secondPath = f.attachments.resolve(f.a.localId, second.id);
  fs.unlinkSync(secondPath); fs.mkdirSync(secondPath);
  f.advance(ATTACHMENT_TTL_MS);
  await f.attachments.gc();
  assert.ok(f.saved(second.id));
  assert.equal(f.saved(second.id).next_check_at, f.getTime() + ATTACHMENT_GC_INTERVAL_MS);
  fs.rmdirSync(secondPath);
  f.advance(ATTACHMENT_GC_INTERVAL_MS);
  await f.attachments.gc();
  assert.equal(f.saved(second.id), undefined);
  assert.equal(record.storage_name.endsWith('.part'), false);
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

test('validation delayed beyond collection can leave a later message unavailable without reviving its ID', async t => {
  const f = fixture(t), result = await f.upload();
  f.advance(ATTACHMENT_SEND_WINDOW_MS - 1);
  const annotation = f.annotation(result);
  f.advance(ATTACHMENT_GC_INTERVAL_MS + 1);
  await f.attachments.gc();
  assert.equal(f.saved(result.id), undefined);
  const late = f.add(annotation);
  assert.equal(f.attachments.linkRow(late)[0].available, false);
  assert.throws(() => f.attachments.resolve(f.a.localId, result.id));
});
