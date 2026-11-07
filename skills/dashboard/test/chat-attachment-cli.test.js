import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Store } from '../src/lib/store.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { guardDatabase } from '../../comm-bridge/scripts/sqlite-schema.js';
import * as coreSchema from '../../comm-bridge/scripts/c4-schema.js';

const cli = fileURLToPath(new URL('../scripts/attachments.js', import.meta.url));

// These cases cover the real CLI, SQLite owners, source files and shared limit
// configuration. Run for attachment CLI/storage/root changes; unrelated UI
// changes may skip. The official runner isolates the parent before imports.
// Children have private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR, no runtime or tmux, and
// synchronous bounded execution. Handles close before fixture cleanup.
function fixture(t) {
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key] && !process.env[key].startsWith(os.userInfo().homedir + path.sep), `${key} must be isolated`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-cli-'));
  const home = path.join(root, 'home');
  const zylosDir = path.join(root, 'installation');
  const alias = path.join(root, 'installation-link');
  const dashboardPath = path.join(zylosDir, 'components', 'dashboard', 'dashboard.db');
  const corePath = path.join(zylosDir, 'comm-bridge', 'c4.db');
  const env = { ...process.env, HOME: home, ZYLOS_DIR: alias,
    PM2_HOME: path.join(home, '.pm2'), TMPDIR: path.join(root, 'tmp'),
    TMUX_TMPDIR: path.join(root, 'tmux'), WEB_CONSOLE_MAX_UPLOAD_MB: '300' };
  for (const dir of [home, path.dirname(dashboardPath), path.dirname(corePath),
    path.join(zylosDir, 'workspace'), env.PM2_HOME, env.TMPDIR, env.TMUX_TMPDIR]) fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(zylosDir, alias, 'dir');
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) assert.ok(env[key].startsWith(root + path.sep));
  console.log(JSON.stringify({ isolated: true, home, zylosDir: alias, realRoot: zylosDir,
    pm2Home: env.PM2_HOME, tmpdir: env.TMPDIR, privateSocket: path.join(env.TMUX_TMPDIR, 'private.sock'), dashboardPath, corePath }));
  const core = new Database(corePath);
  guardDatabase(core, coreSchema);
  core.prepare('INSERT INTO channel_namespaces(namespace,component_name) VALUES(?,?)').run('dash', 'dashboard');
  const store = new Store(dashboardPath);
  const conversations = new ChatConversations({ store });
  const a = conversations.create(), b = conversations.create();
  t.after(() => { core.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const run = (...args) => {
    const child = spawnSync(process.execPath, [cli, ...args], {
      cwd: root, env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.stderr, '');
    const lines = child.stdout.trim().split('\n');
    assert.equal(lines.length, 1, child.stdout);
    return { status: child.status, result: JSON.parse(lines[0]) };
  };
  const source = (name, value) => { const file = path.join(zylosDir, 'workspace', name); fs.writeFileSync(file, value); return file; };
  const register = (file, kind = 'file', conversation = a.localId) => run('register', '--conversation', conversation, '--kind', kind, '--path', file);
  const resolve = (id, conversation = a.localId) => run('resolve', '--conversation', conversation, '--id', id);
  const reject = (response, code) => {
    assert.equal(response.status, 1);
    assert.equal(response.result.ok, false);
    assert.equal(response.result.error.code, code);
    assert.equal(Object.hasOwn(response.result, 'attachmentId'), false);
    assert.equal(Object.hasOwn(response.result, 'path'), false);
  };
  return { root, home, zylosDir, alias, env, dashboardPath, corePath, core, store, a, b, run, source, register, resolve, reject };
}

test('register and resolve use a custom symlinked installation and preserve an independent private copy', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.zylosDir, '.env'), 'WEB_CONSOLE_MAX_UPLOAD_MB=1\n');
  const source = f.source('report.txt', 'private report');
  const before = Date.now();
  const registered = f.register(source);
  assert.equal(registered.status, 0);
  assert.equal(registered.result.ok, true);
  assert.equal(registered.result.name, 'report.txt');
  assert.equal(registered.result.kind, 'file');
  assert.match(registered.result.attachmentId, /^[A-Za-z0-9_-]+$/);
  assert.ok(registered.result.expiresAt >= before + 25 * 60 * 1000);
  assert.ok(registered.result.expiresAt <= Date.now() + 25 * 60 * 1000);
  assert.equal(Object.hasOwn(registered.result, 'path'), false);
  fs.unlinkSync(source);
  const resolved = f.resolve(registered.result.attachmentId);
  assert.equal(resolved.status, 0);
  assert.equal(resolved.result.ok, true);
  assert.equal(path.dirname(resolved.result.path), path.join(f.zylosDir, 'components', 'dashboard', 'media'));
  assert.equal(fs.readFileSync(resolved.result.path, 'utf8'), 'private report');
  assert.equal(fs.statSync(resolved.result.path).mode & 0o777, 0o600);
  f.reject(f.resolve(registered.result.attachmentId, f.b.localId), 'chat_attachment_unavailable');
  f.reject(f.resolve('missing'), 'chat_attachment_unavailable');
  assert.equal(f.store.db.prepare('SELECT source FROM chat_attachments WHERE id=?').get(registered.result.attachmentId).source, 'agent');
  assert.equal(f.core.prepare('SELECT count(*) AS n FROM conversations').get().n, 0);
  assert.equal(f.core.prepare('SELECT count(*) AS n FROM group_heads').get().n, 0);
});

test('CLI validates exact command options before opening storage', t => {
  const f = fixture(t);
  const source = f.source('report.txt', 'private report');
  const invalid = [
    [], ['send'], ['register', '--conversation', f.a.localId, '--kind', 'file'],
    ['register', '--conversation', f.a.localId, '--kind', 'audio', '--path', source],
    ['register', '--conversation', f.a.localId, '--kind', 'file', '--path', 'relative.txt'],
    ['resolve', '--conversation', f.a.localId, '--conversation', 'duplicate'],
    ['resolve', '--conversation', f.a.localId, '--id', 'missing', '--extra', 'value'],
    ['resolve', '--conversation', f.a.localId, '--unknown', 'value'],
  ];
  for (const args of invalid) f.reject(f.run(...args), 'invalid_attachment_arguments');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_attachments').get().n, 0);
});

test('CLI enforces target dotenv limits, source roots, image bytes and conversation ownership', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.zylosDir, '.env'), 'WEB_CONSOLE_MAX_UPLOAD_MB=1\n');
  const exact = f.source('exact.bin', Buffer.alloc(1024 * 1024));
  assert.equal(f.register(exact).status, 0);
  const excessive = f.source('large.bin', Buffer.alloc(1024 * 1024 + 1));
  f.reject(f.register(excessive), 'chat_attachment_too_large');
  const text = f.source('false.png', 'not an image');
  f.reject(f.register(text, 'image'), 'chat_attachment_not_image');
  const png = f.source('actual.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const image = f.register(png, 'image');
  assert.equal(image.status, 0);
  assert.equal(image.result.kind, 'image');
  const outside = '/etc/hosts';
  f.reject(f.register(outside), 'chat_attachment_source_forbidden');
  const symlink = path.join(f.zylosDir, 'workspace', 'escape.txt'); fs.symlinkSync(outside, symlink);
  f.reject(f.register(symlink), 'chat_attachment_source_forbidden');
  f.reject(f.register(path.join(f.zylosDir, 'workspace')), 'chat_attachment_source_forbidden');
  f.reject(f.register(text, 'file', 'missing-conversation'), 'chat_conversation_not_found');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_attachments').get().n, 2);
  assert.equal(fs.readdirSync(path.join(f.zylosDir, 'components', 'dashboard', 'media')).some(name => name.endsWith('.part')), false);
});

test('CLI refuses missing or outdated Dashboard storage and never migrates it', t => {
  const f = fixture(t);
  const source = f.source('report.txt', 'private report');
  const unavailable = path.join(f.root, 'unavailable'); fs.mkdirSync(unavailable);
  f.env.ZYLOS_DIR = unavailable;
  f.reject(f.register(source), 'attachment_storage_unavailable');
  assert.equal(fs.existsSync(path.join(unavailable, 'components')), false);
  f.env.ZYLOS_DIR = f.alias;
  f.store.db.prepare('DELETE FROM schema_migrations WHERE version=(SELECT max(version) FROM schema_migrations)').run();
  const version = f.store.db.prepare('SELECT max(version) AS version FROM schema_migrations').get().version;
  f.reject(f.register(source), 'attachment_command_failed');
  assert.equal(f.store.db.prepare('SELECT max(version) AS version FROM schema_migrations').get().version, version);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_attachments').get().n, 0);
});

test('register rejects a FIFO promptly without waiting for a writer', t => {
  const f = fixture(t);
  const fifo = path.join(f.zylosDir, 'workspace', 'source.fifo');
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 1000 });
  assert.equal(made.status, 0, made.stderr);
  f.reject(f.register(fifo), 'chat_attachment_source_forbidden');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_attachments').get().n, 0);
  assert.equal(fs.readdirSync(path.join(f.zylosDir, 'components', 'dashboard', 'media')).length, 0);
});

test('register accepts a private source under literal tmp while rejecting a system file', t => {
  const f = fixture(t);
  const sourceRoot = fs.mkdtempSync('/tmp/attachment-cli-source-');
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  const source = path.join(sourceRoot, 'report.txt');
  fs.writeFileSync(source, 'temporary source', { mode: 0o600 });
  const result = f.register(source);
  assert.equal(result.status, 0);
  const resolved = f.resolve(result.result.attachmentId);
  assert.equal(resolved.status, 0);
  assert.equal(fs.readFileSync(resolved.result.path, 'utf8'), 'temporary source');
  f.reject(f.register('/etc/hosts'), 'chat_attachment_source_forbidden');
});
