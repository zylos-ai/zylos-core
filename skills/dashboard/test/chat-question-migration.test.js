import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { dashboardSchemaOwner as owner } from '../src/lib/schema-owner.js';
import { Store } from '../src/lib/store.js';
import { TARGET_SCHEMA_VERSION } from '../src/lib/schema.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-migration-'));
  const file = path.join(root, 'dashboard.db');
  let db = new Database(file);
  t.after(() => { if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.ok(file.startsWith(root + path.sep));
  console.log('Migration isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR, PM2_HOME: process.env.PM2_HOME, file, resources: 'SQLite only; no child/HTTP/PM2/tmux/runtime' }));
  db.exec(fs.readFileSync(new URL('./fixtures/dashboard-schema22.sql', import.meta.url), 'utf8'));
  db.exec("INSERT INTO auth_sessions(token_hash,created_at,last_activity_at) VALUES('retained',1,2); INSERT INTO group_display_names(session_group,display_name,source) VALUES('dashboard:old','Old chat','human')");
  return { db, file, reopen: () => { db.close(); const store = new Store(file); db = store.db; return store; } };
}

// Boundary: actual historical database upgrade preserves prior owner data and table
// identities. Run on question schema/owner changes; UI-only edits may skip.
test('Question schema upgrade preserves historical Dashboard tables and records', t => {
  const f = fixture(t), before = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const store = f.reopen();
  for (const { name } of before) assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name), name);
  assert.equal(store.db.prepare('SELECT token_hash FROM auth_sessions').get().token_hash, 'retained');
  assert.equal(store.db.prepare('SELECT display_name FROM group_display_names').get().display_name, 'Old chat');
  assert.equal(owner.inspectSchema(store.db).currentVersion, TARGET_SCHEMA_VERSION);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM chat_questions').get().n, 0);
  owner.migrate(store.db);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=23').get().n, 1);
  f.reopen();
});

// Boundary: failed question DDL must not advance its version or alter old data.
// Run on question migration changes; UI-only edits may skip.
test('Question migration failure retains the prior version and records', t => {
  const f = fixture(t);
  f.db.exec("CREATE TRIGGER fail_question_version BEFORE INSERT ON schema_migrations WHEN NEW.version=23 BEGIN SELECT RAISE(ABORT,'fixture migration failure'); END");
  assert.throws(() => owner.migrate(f.db), /fixture migration failure/);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='chat_questions'").get(), undefined);
  assert.equal(f.db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v, 22);
  assert.equal(f.db.prepare('SELECT token_hash FROM auth_sessions').get().token_hash, 'retained');
});

// Boundary: current layout must keep both question identity constraints.
// Run on schema inspection changes; UI-only edits may skip.
test('Question schema inspection rejects a missing unique group and interrupt reference', t => {
  const f = fixture(t); owner.migrate(f.db);
  f.db.exec('DROP TABLE chat_questions; CREATE TABLE chat_questions(c4_id TEXT PRIMARY KEY, session_group TEXT,endpoint_id TEXT,message_id TEXT,interrupt_id TEXT,question_summary TEXT,constraints TEXT,status TEXT,created_at TEXT)');
  assert.throws(() => owner.inspectSchema(f.db), /question identity/);
});
