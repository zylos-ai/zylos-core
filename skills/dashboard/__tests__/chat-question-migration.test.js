import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { dashboardSchemaOwner as owner } from '../src/lib/schema-owner.js';
import { Store } from '../src/lib/store.js';
import { migrateDashboardFile } from './helpers/explicit-migration.js';
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
  assert.throws(() => new Store(f.file), { code: 'SCHEMA_UPGRADE_REQUIRED' });
  f.db.close(); migrateDashboardFile(f.file);
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

// Boundary: current layout must keep both question identity constraints.
// Run on schema inspection changes; UI-only edits may skip.
