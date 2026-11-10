import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { Store } from '../src/lib/store.js';
import { TARGET_SCHEMA_VERSION } from '../src/lib/schema.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { ChatAttachments, withChatAttachments, ATTACHMENT_SEND_WINDOW_MS } from '../src/lib/chat/attachments.js';
import { evaluateBeforeSend } from '../scripts/send-hook.js';
import { acceptDelivery } from '../src/lib/chat/channel.js';
import { runSend } from '../scripts/send.js';
import { CONTENT_PREFIX } from '../../comm-bridge/scripts/c4-content-schema.js';
import { guardDatabase } from '../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../comm-bridge/scripts/c4-schema.js';

// Boundary: real read-only hook and post-storage receiver over private files/DBs.
// Run for attachment validation/association/routing changes; skip unrelated UI.
// No HTTP/runtime/PM2/tmux. The isolated runner owns the outer environment;
// fixture resources close before cleanup, including on a failed assertion.
function fixture(t) {
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key] && !process.env[key].startsWith(os.userInfo().homedir + path.sep));
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-send-'));
  const env = { ...process.env, ZYLOS_DIR: root };
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  fs.mkdirSync(path.join(root, 'components/dashboard'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspace'));
  const corePath = path.join(root, 'comm-bridge/c4.db');
  const dashboardPath = path.join(root, 'components/dashboard/dashboard.db');
  console.log(JSON.stringify({ home: env.HOME, zylosDir: root, pm2Home: env.PM2_HOME,
    tmpdir: env.TMPDIR, privateSocket: path.join(root, 'tmux.sock'), corePath, dashboardPath }));
  const core = new Database(corePath); guardDatabase(core, schema);
  core.prepare('INSERT INTO channel_namespaces(namespace,component_name) VALUES(?,?)').run('dash', 'dashboard');
  const store = new Store(dashboardPath), conversations = new ChatConversations({ store });
  const a = conversations.create(), b = conversations.create();
  const reader = new C4Reader(root);
  const cleanup = [];
  const attachments = new ChatAttachments({ store, c4Reader: reader, zylosDir: root });
  const add = (content, change = {}) => {
    const localId = change.endpoint_id ?? a.localId;
    const values = { direction: 'out', channel: 'dashboard', endpoint_id: localId,
      session_group: `dash:${localId}`, content, ...change };
    const result = core.prepare(`INSERT INTO conversations(direction,channel,endpoint_id,session_group,content,status)
      VALUES(@direction,@channel,@endpoint_id,@session_group,@content,'failed')`).run(values);
    return core.prepare('SELECT * FROM conversations WHERE id=?').get(result.lastInsertRowid);
  };
  for (const c of [a, b]) {
    const row = add('initial inbound', { direction: 'in', endpoint_id: c.localId });
    core.prepare('INSERT INTO group_heads(session_group,head_id) VALUES(?,?)').run(row.session_group, row.id);
  }
  const register = async (kind = 'file', name = 'report.txt') => {
    const source = path.join(root, 'workspace', name);
    fs.writeFileSync(source, kind === 'image' ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) : 'agent bytes');
    const result = await attachments.register(a, { kind, path: source });
    return { ...result, id: result.attachmentId, source };
  };
  const upload = () => attachments.prepareUser(a, { name: 'user.txt', mime: 'text/plain', principal: 'cookie', stream: Readable.from(['user bytes']) });
  const input = (content, change = {}) => ({ version: 1, hook_event_name: 'BeforeSend',
    hook_id: 'dashboard.content', request_id: 'request', invocation_id: 'invocation',
    request: { channel: 'dashboard', endpoint: a.localId, content, options: { groupName: a.localId }, ...change },
    context: { session_group: 'origin' } });
  const hook = (content, change = {}) => evaluateBeforeSend(input(content, change), { env });
  t.after(async () => { for (const close of cleanup) await close(); await attachments.close(); reader.close(); if (store.db.open) store.close(); if (core.open) core.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, env, core, store, a, b, attachments, register, upload, input, hook, add, cleanup,
    count: () => store.db.prepare('SELECT count(*) n FROM chat_attachment_messages').get().n,
    age: (id, age) => store.db.prepare('UPDATE chat_attachments SET created_at=? WHERE id=?').run(Date.now() - age, id) };
}
const block = (record, extra = {}) => ({ id: 'attachment_' + record.id.replace(/-/g, ''),
  type: `x-zylos.${record.kind}`, schemaVersion: 1,
  data: { attachmentId: record.id, nameSnapshot: record.name }, fallbackText: record.name, ...extra });
const content = (...blocks) => CONTENT_PREFIX + JSON.stringify({ version: 1, kind: 'message', messageId: 'reusable_message_id',
  fallbackText: 'Registered attachments', blocks });
const packet = row => ({ version: 1, c4_id: row.id, channel: row.channel, endpoint_id: row.endpoint_id, session_group: row.session_group, content: row.content });
function snapshot(root) {
  const out = {};
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), key = path.relative(root, file), stat = fs.lstatSync(file);
      out[key] = { mode: stat.mode, uid: stat.uid, gid: stat.gid, mtime: stat.mtimeMs, size: stat.size, hash: entry.isDirectory() ? null : createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
      if (entry.isDirectory()) visit(file);
    }
  };
  visit(root); return out;
}

// SQLite read-only WAL connections may create sidecars/update read marks:
// https://sqlite.org/wal.html#read_only_databases . This asserts business
// immutability and explicitly does not claim physical zero writes.
function logicalContents(f) {
  return [f.core, f.store.db].map((database, index) => {
    const temporary = !database.open;
    const db = temporary ? new Database(path.join(f.root, index ? 'components/dashboard/dashboard.db' : 'comm-bridge/c4.db'),
      { readonly: true, fileMustExist: true }) : database;
    try {
      const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
      return { schema, tables: schema.filter(row => row.type === 'table').map(row => ({ name: row.name,
        rows: db.prepare('SELECT * FROM "' + row.name.replaceAll('"', '""') + '"').all()
          .map(value => JSON.stringify(value)).sort() })) };
    } finally { if (temporary) db.close(); }
  });
}
function audit(f) {
  const logical = logicalContents(f);
  return { logical, files: snapshot(f.root) };
}
function assertAudit(f, before) {
  const after = snapshot(f.root), files = before.files;
  const databases = ['comm-bridge/c4.db', 'components/dashboard/dashboard.db'];
  const sidecars = new Set(databases.flatMap(file => [file + '-wal', file + '-shm']));
  const parents = new Set(databases.map(file => path.dirname(file)));
  for (const file of new Set([...Object.keys(files), ...Object.keys(after)])) {
    if (sidecars.has(file)) {
      if (!after[file]) { assert.equal(files[file], undefined, file); continue; }
      const main = after[file.slice(0, -4)];
      assert.equal(after[file].mode, main.mode, file + ' permissions');
      assert.equal(after[file].uid, main.uid, file + ' owner');
      assert.equal(after[file].gid, main.gid, file + ' group');
      if (file.endsWith('-wal')) {
        if (files[file]) {
          assert.equal(after[file].size, files[file].size, file + ' has no appended frames');
          assert.equal(after[file].hash, files[file].hash, file + ' existing prefix unchanged');
        } else assert.equal(after[file].size, 0, file + ' new WAL has no frames');
      }
      continue;
    }
    if (parents.has(file)) {
      assert.deepEqual({ ...after[file], mtime: 0, size: 0 }, { ...files[file], mtime: 0, size: 0 }, file);
    } else assert.deepEqual(after[file], files[file], file);
  }
  assert.deepEqual(logicalContents(f), before.logical);
}

test('attachment hook uses the destination without business writes; SQLite bookkeeping is allowed', async t => {
  const f = fixture(t), file = await f.register(), image = await f.register('image', 'photo.png');
  const value = content(block(file), block(image));
  const before = audit(f);
  assert.equal(f.hook(value).decision, 'continue');
  assertAudit(f, before);
  assert.equal(f.count(), 0);
  for (const change of [{ options: {} }, { options: { groupName: f.b.localId } },
    { options: { groupName: f.a.localId, wholeGroup: true } },
    { endpoint: 'missing_conversation', options: { groupName: 'missing_conversation' } }]) {
    const result = f.hook(value, change);
    assert.equal(result.decision, 'abort');
    assert.match(result.message, /original reply-via command/);
    assert.doesNotMatch(result.message, /register/);
  }
  f.core.prepare('DELETE FROM group_heads WHERE session_group=?').run(`dash:${f.a.localId}`);
  const missingGroup = f.hook(value);
  assert.equal(missingGroup.decision, 'abort');
  assert.match(missingGroup.message, /original reply-via command/);
});

test('attachment hook reserves registration advice for invalid attachment data and references', async t => {
  const f = fixture(t), registered = await f.register();
  const invalidChart = { id: 'chart', type: 'time_series', schemaVersion: 1, data: {}, fallbackText: 'Invalid chart' };
  const badEnvelope = JSON.parse(content(block(registered)).slice(CONTENT_PREFIX.length));
  badEnvelope.unexpected = true;
  const before = audit(f);
  for (const value of [content(block(registered), invalidChart), CONTENT_PREFIX + JSON.stringify(badEnvelope),
    content(block(registered, { status: 'pending' }))]) {
    const result = f.hook(value);
    assert.equal(result.decision, 'abort');
    assert.match(result.message, /^Invalid Dashboard structured content/);
    assert.doesNotMatch(result.message, /register/);
  }
  for (const data of [{ nameSnapshot: registered.name }, { attachmentId: registered.id, nameSnapshot: registered.name, url: 'https://example.invalid/file' },
    { attachmentId: 'unknown_id', nameSnapshot: registered.name }]) {
    const result = f.hook(content(block(registered, { data })));
    assert.equal(result.decision, 'abort');
    assert.match(result.message, /register again on the target machine/);
  }
  assertAudit(f, before);
});

test('attachment hook reads closed WAL databases with SQLite bookkeeping and no business writes', async t => {
  const f = fixture(t), registered = await f.register(), value = content(block(registered));
  const before = audit(f);
  f.attachments.c4Reader.close();
  f.store.close(); f.core.close();
  before.files = snapshot(f.root);
  assert.equal(f.hook(value).decision, 'continue');
  assertAudit(f, before);
});

// Boundary: a killed writer leaves committed attachment data only in WAL.
// Run on hook storage/open-mode changes; unrelated UI may skip. The child is
// bounded and reaped before fixture cleanup, on success and every failure.
test('attachment hook preserves crash-left committed WAL frames and main database bytes', async t => {
  const f = fixture(t), source = path.join(f.root, 'workspace', 'crash-report.txt');
  fs.writeFileSync(source, 'registered only in crash-left WAL');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM chat_attachments').get().n, 0);
  f.attachments.c4Reader.close(); f.store.close(); f.core.close();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/attachment-wal-writer.js', import.meta.url))],
    { env: f.env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
  let stdout = '', stderr = '', failure, exitCode;
  child.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 65536) child.kill('SIGKILL'); });
  child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > 65536) child.kill('SIGKILL'); });
  child.on('error', error => { failure = error; });
  const finished = new Promise(resolve => child.once('close', code => { exitCode = code; resolve(); }));
  f.cleanup.push(async () => { if (exitCode === undefined) child.kill('SIGKILL'); await finished; });
  child.stdin.on('error', error => { failure = error; });
  child.stdin.end(JSON.stringify({ root: f.root, conversation: f.a.localId, source }));
  const deadline = performance.now() + 3000;
  while (!stdout.includes('ATTACHMENT_WAL_COMMITTED')) {
    if (failure) throw failure;
    assert.equal(exitCode, undefined, stderr);
    assert.ok(performance.now() < deadline, 'writer commits the attachment within its bound');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  child.kill('SIGKILL'); await finished;
  assert.equal(exitCode, null);
  const registered = JSON.parse(stdout.split('\n').find(line => line.startsWith('ATTACHMENT_WAL_COMMITTED ')).slice('ATTACHMENT_WAL_COMMITTED '.length));
  const value = content(block({ ...registered, id: registered.attachmentId }));
  const wal = path.join(f.root, 'components/dashboard/dashboard.db-wal');
  assert.ok(fs.statSync(wal).size > 32, 'crash fixture contains committed WAL frames');
  const before = audit(f);
  assert.equal(f.hook(value).decision, 'continue', 'hook reads the registered record from committed WAL');
  assertAudit(f, before);
});

test('read-only attachment access closes both database handles and rejects writes', async t => {
  const f = fixture(t); let dashboardHandle, coreHandle;
  withChatAttachments(f.root, { readonly: true }, service => {
    dashboardHandle = service.db; coreHandle = service.c4Reader._open();
    assert.equal(dashboardHandle.open, true); assert.equal(coreHandle.open, true);
    assert.equal(dashboardHandle.readonly, true); assert.equal(coreHandle.readonly, true);
    assert.throws(() => dashboardHandle.prepare("UPDATE chat_conversations SET display_name='must-not-write'").run(), { code: 'SQLITE_READONLY' });
  });
  assert.equal(dashboardHandle.open, false);
  assert.equal(coreHandle.open, false);
});

// Boundary: actual hook process with open readers alongside existing writers.
// Required for read-only connection lifecycle changes; unrelated UI may skip.
// The helper's 3s hold, child timeout and after-hook kill bound every failure.
test('an open hook reader permits writes and checkpoints and releases its connections', async t => {
  const f = fixture(t), registered = await f.register();
  f.core.pragma('journal_mode = WAL');
  const ready = path.join(f.root, 'hook-ready'), release = path.join(f.root, 'hook-release');
  const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./helpers/attachment-hook-reader.js', import.meta.url)),
    fileURLToPath(new URL('../scripts/send-hook.js', import.meta.url))], {
    env: { ...f.env, ATTACHMENT_HOOK_MEDIA: f.attachments.mediaDir, ATTACHMENT_HOOK_READY: ready, ATTACHMENT_HOOK_RELEASE: release },
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
  });
  let stdout = '', stderr = '', exitCode, failure;
  child.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 65536) child.kill('SIGKILL'); });
  child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > 65536) child.kill('SIGKILL'); });
  child.on('error', error => { failure = error; });
  const finished = new Promise(resolve => child.once('close', code => { exitCode = code; resolve(); }));
  f.cleanup.push(async () => { if (exitCode === undefined) child.kill('SIGKILL'); await finished; });
  child.stdin.on('error', error => { failure = error; });
  child.stdin.end(JSON.stringify(f.input(content(block(registered)))));
  const deadline = performance.now() + 3000;
  while (!fs.existsSync(ready)) {
    if (failure) throw failure;
    assert.equal(exitCode, undefined, stderr);
    assert.ok(performance.now() < deadline, 'actual hook reaches its open-reader boundary');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const started = performance.now();
  for (const db of [f.core, f.store.db]) db.pragma('busy_timeout = 100');
  f.add('concurrent outbound write');
  f.store.db.prepare('UPDATE chat_attachments SET name=? WHERE id=?').run('concurrent-name.txt', registered.id);
  for (const db of [f.core, f.store.db]) {
    const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)')[0];
    assert.equal(checkpoint.busy, 0);
    assert.equal(checkpoint.log, checkpoint.checkpointed);
  }
  assert.ok(performance.now() - started < 1000, 'writer and checkpoints finish while hook remains open');
  fs.writeFileSync(release, 'release');
  await finished;
  if (failure) throw failure;
  assert.equal(exitCode, 0, stderr);
  assert.equal(JSON.parse(stdout).decision, 'continue');
  for (const db of [f.core, f.store.db]) assert.equal(db.pragma('wal_checkpoint(TRUNCATE)')[0].busy, 0);
});

test('attachment hook prioritizes the path registration hint before closed schema including cooldown suffix', async t => {
  const f = fixture(t), registered = await f.register();
  const bad = block(registered); bad.data.path = '/private/source.txt'; delete bad.data.attachmentId;
  const before = audit(f);
  for (const suffix of ['', '\n\n[C4] Status notification suppressed by cooldown while health=bad reason=busy.']) {
    const result = f.hook(content(bad) + suffix);
    assert.equal(result.decision, 'abort');
    assert.match(result.message, /register command first/);
    assert.equal(result.message.includes('/private/source.txt'), false);
  }
  assertAudit(f, before);
});

test('attachment hook rejects unknown fields URLs missing IDs cross-group kind and unreadable files without business writes', async t => {
  const f = fixture(t), registered = await f.register();
  const wrongGroup = await f.attachments.prepareUser(f.b, { name: 'foreign.txt', mime: 'text/plain', principal: 'cookie', stream: Readable.from(['foreign']) });
  const variants = [
    { attachmentId: registered.id, nameSnapshot: registered.name, url: 'https://example.invalid/file' },
    { attachmentId: registered.id, nameSnapshot: registered.name, size: 10 },
    { nameSnapshot: registered.name },
    { attachmentId: 'missing', nameSnapshot: registered.name },
    { attachmentId: wrongGroup.id, nameSnapshot: wrongGroup.name },
  ];
  const before = audit(f);
  for (const data of variants) {
    const result = f.hook(content(block(registered, { data })));
    assert.equal(result.decision, 'abort'); assert.match(result.message, /target machine/);
  }
  for (const value of [content(block(registered, { type: 'x-zylos.image' })),
    content(block(registered), { ...block(registered), id: 'duplicate_reference' })]) {
    const result = f.hook(value);
    assert.equal(result.decision, 'abort');
    assert.match(result.message, /register again on the target machine/);
  }
  assertAudit(f, before);
  fs.unlinkSync(f.attachments.resolve(f.a, registered.id));
  const missingBefore = audit(f);
  const unreadable = f.hook(content(block(registered)));
  assert.equal(unreadable.decision, 'abort');
  assert.match(unreadable.message, /register again on the target machine/);
  assertAudit(f, missingBefore);
});

test('unlinked agent references have a strict window and unlinked user references are rejected', async t => {
  t.mock.method(Date, 'now', () => 50_000_000);
  const f = fixture(t), registered = await f.register(), user = await f.upload();
  const value = content(block(registered));
  assert.equal(f.hook(value).decision, 'continue');
  assert.equal(f.hook(content(block(user))).decision, 'abort');
  f.age(registered.id, ATTACHMENT_SEND_WINDOW_MS - 1);
  assert.equal(f.hook(value).decision, 'continue');
  for (const age of [ATTACHMENT_SEND_WINDOW_MS, ATTACHMENT_SEND_WINDOW_MS + 1, -60_000]) {
    f.age(registered.id, age);
    const before = audit(f);
    const result = f.hook(value);
    assert.equal(result.decision, 'abort');
    assert.match(result.message, /register again on the target machine/);
    assertAudit(f, before);
  }
});

test('attachment hook accepts twenty distinct IDs and rejects a twenty-first without business writes', async t => {
  const f = fixture(t), records = [];
  for (let i = 0; i < 21; i++) records.push(await f.register('file', `report-${i}.txt`));
  const before = audit(f);
  assert.equal(f.hook(content(...records.slice(0, 20).map(record => block(record)))).decision, 'continue');
  const excess = f.hook(content(...records.map(record => block(record))));
  assert.equal(excess.decision, 'abort');
  assert.match(excess.message, /register again on the target machine/);
  assertAudit(f, before);
});

test('verified outbound rows link idempotently by C4 ID and linked user and agent copies outlive preparation', async t => {
  const f = fixture(t), registered = await f.register(), user = await f.upload();
  const userPath = f.attachments.resolve(f.a, user.id);
  const annotation = `[attachment:file ${userPath} name="user.txt" 10B]`;
  f.attachments.linkRow(f.add(annotation, { direction: 'in' }));
  assert.equal(f.count(), 1);
  const value = content(block(registered), block(user)), rows = [f.add(value), f.add(value)];
  for (const row of rows) {
    acceptDelivery(packet(row), { env: f.env }); acceptDelivery(packet(row), { env: f.env });
  }
  assert.equal(f.count(), 5);
  fs.unlinkSync(registered.source);
  for (const record of [registered, user]) {
    f.age(record.id, ATTACHMENT_SEND_WINDOW_MS * 4);
    assert.equal(f.hook(content(block(record))).decision, 'continue');
    assert.ok(fs.readFileSync(f.attachments.download(f.a, record.id).path).length);
    assert.throws(() => f.attachments.download(f.b, record.id));
  }
  assert.equal(fs.readFileSync(f.attachments.resolve(f.a, registered.id), 'utf8'), 'agent bytes');
});

test('forged delivery packets never create attachment associations', async t => {
  const f = fixture(t), registered = await f.register(), value = content(block(registered));
  const row = f.add(value), original = packet(row);
  for (const change of [{ c4_id: row.id + 100 }, { channel: 'other' }, { endpoint_id: f.b.localId },
    { session_group: `dash:${f.b.localId}` }, { content: value + ' ' }, { version: 2 }]) {
    assert.throws(() => acceptDelivery({ ...original, ...change }, { env: f.env }), { code: 'DELIVERY_MISMATCH' });
  }
  assert.throws(() => acceptDelivery(packet(f.add(value, { direction: 'in' })), { env: f.env }), { code: 'DELIVERY_MISMATCH' });
  assert.equal(f.count(), 0);
  acceptDelivery(original, { env: f.env }); assert.equal(f.count(), 1);
});

test('stored association failures prohibit resend and recover using the existing authoritative row', async t => {
  const f = fixture(t), registered = await f.register(), row = f.add(content(block(registered)));
  f.store.db.exec("CREATE TRIGGER reject_link BEFORE INSERT ON chat_attachment_messages BEGIN SELECT RAISE(ABORT,'fixture association'); END");
  let output = '';
  assert.equal(runSend({ input: () => JSON.stringify(packet(row)), env: f.env, stderr: { write(value) { output += value; } } }), 1);
  assert.match(output, /ATTACHMENT_ASSOCIATION_FAILED/); assert.match(output, /already stored.*Do not resend/);
  assert.equal(f.count(), 0);
  f.store.db.exec('DROP TRIGGER reject_link');
  assert.equal(f.attachments.linkRow(row)[0].available, true);
  assert.equal(f.count(), 1);
});

test('attachment hook refuses absent storage missing media and old schema without creating or migrating files', async t => {
  const f = fixture(t), registered = await f.register(), value = content(block(registered));
  const missing = path.join(f.root, 'absent');
  const input = { version: 1, hook_event_name: 'BeforeSend', hook_id: 'dashboard.content', request_id: 'r', invocation_id: 'i',
    request: { channel: 'dashboard', endpoint: f.a.localId, options: { groupName: f.a.localId }, content: value }, context: {} };
  assert.equal(evaluateBeforeSend(input, { env: { ...f.env, ZYLOS_DIR: missing } }).decision, 'abort');
  assert.equal(fs.existsSync(missing), false);
  const media = f.attachments.mediaDir;
  fs.renameSync(media, media + '-hidden');
  let before = audit(f);
  assert.equal(f.hook(value).decision, 'abort'); assertAudit(f, before);
  fs.renameSync(media + '-hidden', media);
  f.store.db.prepare('DELETE FROM schema_migrations WHERE version=?').run(TARGET_SCHEMA_VERSION);
  before = audit(f);
  assert.equal(f.hook(value).decision, 'abort'); assertAudit(f, before);
});

// Boundary: actual missing/unopenable Core storage reaches the read-only hook.
// Run for attachment service diagnostics; unrelated UI changes may skip.
// Only fixture DB paths are changed; no process or runtime is started.
for (const state of ['missing', 'unopenable']) {
  test(`attachment hook reports service unavailable when Core storage is ${state}`, async t => {
    const f = fixture(t), registered = await f.register(), value = content(block(registered));
    f.attachments.c4Reader.close(); f.core.close();
    const before = audit(f), corePath = path.join(f.root, 'comm-bridge/c4.db');
    fs.renameSync(corePath, corePath + '-hidden');
    if (state === 'unopenable') fs.mkdirSync(corePath);
    try {
      assert.throws(() => withChatAttachments(f.root, { readonly: true }, service => {
        service.validateAgentReferences(f.a.localId, [block(registered)]);
      }), { code: 'chat_attachment_core_unavailable' });
      const result = f.hook(value);
      assert.equal(result.decision, 'abort');
      assert.equal(result.message, 'Dashboard attachment service unavailable.');
      assert.doesNotMatch(result.message, /register/);
    } finally {
      if (state === 'unopenable') fs.rmdirSync(corePath);
      fs.renameSync(corePath + '-hidden', corePath);
    }
    assertAudit(f, before);
  });
}

// Boundary: invalid metadata and versions on both sides of the supported one.
// Run for storage-version/diagnostic changes; unrelated UI changes may skip.
// The fixture owns both databases and all cleanup; no migration is requested.
for (const version of [-1, TARGET_SCHEMA_VERSION - 1, TARGET_SCHEMA_VERSION + 1]) {
  test(`attachment hook reports service unavailable for Dashboard schema version ${version}`, async t => {
    const f = fixture(t), registered = await f.register(), value = content(block(registered));
    f.store.db.prepare('DELETE FROM schema_migrations WHERE version>?').run(version);
    f.store.db.prepare('INSERT OR IGNORE INTO schema_migrations(version) VALUES(?)').run(version);
    const before = audit(f);
    assert.throws(() => withChatAttachments(f.root, { readonly: true }, () => assert.fail('unsupported storage')),
      { code: 'chat_attachment_schema_unavailable', statusCode: 502 });
    const result = f.hook(value);
    assert.equal(result.decision, 'abort');
    assert.equal(result.message, 'Dashboard attachment service unavailable.');
    assert.doesNotMatch(result.message, /register/);
    assertAudit(f, before);
  });
}

// Boundary: an absent Dashboard binding keeps the existing destination mapping.
// Run for hook diagnostic changes; unrelated UI changes may skip. Private DBs only.
test('attachment hook keeps the destination hint when the Dashboard binding is absent', async t => {
  const f = fixture(t), registered = await f.register(), value = content(block(registered));
  f.core.prepare("DELETE FROM channel_namespaces WHERE component_name='dashboard'").run();
  const before = audit(f);
  assert.throws(() => withChatAttachments(f.root, { readonly: true }, service => {
    service.validateAgentReferences(f.a.localId, [block(registered)]);
  }), { code: 'invalid_chat_attachment_destination' });
  const result = f.hook(value);
  assert.equal(result.decision, 'abort');
  assert.match(result.message, /original reply-via command/);
  assert.doesNotMatch(result.message, /register|service unavailable/);
  assertAudit(f, before);
});

// Boundary: real missing/corrupt Dashboard storage reaches the actual hook.
// Run for attachment diagnostic/storage-open changes; unrelated UI may skip.
// Only private fixture files are moved/replaced; no process or service starts.
for (const state of ['missing', 'corrupt']) {
  test(`attachment hook reports service unavailable when Dashboard storage is ${state}`, async t => {
    const f = fixture(t), registered = await f.register(), value = content(block(registered));
    f.store.close();
    const before = audit(f), file = path.join(f.root, 'components/dashboard/dashboard.db');
    fs.renameSync(file, file + '-hidden');
    if (state === 'corrupt') fs.writeFileSync(file, 'This is not a SQLite database.');
    try {
      const result = f.hook(value);
      assert.equal(result.decision, 'abort');
      assert.equal(result.message, 'Dashboard attachment service unavailable.');
      assert.doesNotMatch(result.message, /register/);
      if (state === 'missing') assert.equal(fs.existsSync(file), false, 'hook never creates missing storage');
      else assert.equal(fs.readFileSync(file, 'utf8'), 'This is not a SQLite database.');
    } finally {
      if (state === 'corrupt') fs.unlinkSync(file);
      fs.renameSync(file + '-hidden', file);
    }
    assertAudit(f, before);
  });
}
