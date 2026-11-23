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

import { ChatConversations } from '../src/lib/chat/conversations.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { ChatAttachments } from '../src/lib/chat/attachments.js';
import { evaluateBeforeSend } from '../scripts/send-hook.js';
import { acceptDelivery } from '../src/lib/chat/channel.js';

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

// Boundary: actual hook process with open readers alongside existing writers.
// Required for read-only connection lifecycle changes; unrelated UI may skip.
// The helper's 3s hold, child timeout and after-hook kill bound every failure.

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

// Boundary: actual missing/unopenable Core storage reaches the read-only hook.
// Run for attachment service diagnostics; unrelated UI changes may skip.
// Only fixture DB paths are changed; no process or runtime is started.

// Boundary: invalid metadata and versions on both sides of the supported one.
// Run for storage-version/diagnostic changes; unrelated UI changes may skip.
// The fixture owns both databases and all cleanup; no migration is requested.

// Boundary: an absent Dashboard binding keeps the existing destination mapping.
// Run for hook diagnostic changes; unrelated UI changes may skip. Private DBs only.

// Boundary: real missing/corrupt Dashboard storage reaches the actual hook.
// Run for attachment diagnostic/storage-open changes; unrelated UI may skip.
// Only private fixture files are moved/replaced; no process or service starts.

// Boundary: the same private databases and the real post-storage receiver as
// above. In single mode Core records every conversation's rows under `origin`
// at delivery; a row still belongs to the conversation of its endpoint. Run for
// attachment association, collection or download changes; UI-only edits may skip.
