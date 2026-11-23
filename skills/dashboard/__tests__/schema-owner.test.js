import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';

import { dashboardSchemaOwner as owner } from '../src/lib/schema-owner.js';
import { TARGET_SCHEMA_VERSION } from '../src/lib/schema.js';
import { Store } from '../src/lib/store.js';
import { legacy } from './fixtures/dashboard-history.js';
import { SCHEMA_V1 } from './fixtures/schema13.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-schema-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'dashboard.db');
}
// Existing data is migrated only through the explicit owner path (upgrade
// worker or first takeover); ordinary Store opens refuse it unchanged.
function migrateFile(file) {
  const db = new Database(file);
  try { return owner.migrate(db); } finally { db.close(); }
}
function assertStoreRefuses(file) {
  const before = fs.readFileSync(file);
  assert.throws(() => new Store(file), { code: 'SCHEMA_UPGRADE_REQUIRED' });
  assert.ok(fs.readFileSync(file).equals(before), `${file} changed`);
}
test('migration 20 DDL failure rolls back all its changes and version', t => {
  const file=fixture(t);legacy(file);
  let db=new Database(file);db.exec('ALTER TABLE runtime_events ADD COLUMN run_id TEXT');db.close();
  assertStoreRefuses(file);
  assert.throws(()=>migrateFile(file),/duplicate column/);
  db=new Database(file);t.after(()=>db.close());
  assert.equal(db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,13);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='core_log_cursors'").get(),undefined);
  assert.equal(db.pragma('table_info(runtime_events)').some(c=>c.name==='session_group'),false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM runtime_events').get().n,1);
});

test('supported version missing Store required column is rejected', t => {
  const file=fixture(t);const store=new Store(file);store.close();
  const db=new Database(file);db.exec('ALTER TABLE activity_facts DROP COLUMN project');db.close();
  const handle=new Database(file,{readonly:true,fileMustExist:true});t.after(()=>handle.close());
  assert.throws(()=>owner.inspectSchema(handle),/no such column/);
});

// Migration integration: owned historical SQLite only; run for schema/owner
// changes, skip UI-only edits. No network/children/PM2/tmux; handles close before
// fixture cleanup. Historical DDL is data, not re-evaluated product source.

// Current-layout admission: private SQLite only. Run for schema inspection
// changes; skip UI-only edits. No children/services; handles close before cleanup.

// Migration integration: owned historical SQLite only. Run for run-index or
// schema-owner changes; skip UI-only edits. No network/children/PM2/tmux; owned
// handles close before fixture cleanup. Historical DDL is a frozen data fixture.

// Current-index admission: private SQLite only. Run for run-index/schema checks,
// skip UI-only edits. Readonly owner calls must leave the database unchanged.

// Migration boundary: real historical Dashboard SQLite only. Run for draft
// schema changes; skip unrelated UI edits. No C4, child, network, tmux or PM2;
// every handle closes before the fixture's own directory is removed.

test('draft migration can be replayed without replacing registrations or names', t => {
  const file = fixture(t); const store = new Store(file); store.close();
  const db = new Database(file); t.after(() => db.close());
  db.exec(`INSERT INTO chat_conversations(local_id,display_name,created_at,updated_at) VALUES('saved','Saved draft',1,1);
    INSERT INTO group_display_names(session_group,display_name,source) VALUES('dashboard:old','Human name','human');
    DELETE FROM schema_migrations WHERE version>=24;`);
  assert.deepEqual(owner.migrate(db), { currentVersion: TARGET_SCHEMA_VERSION, targetVersion: TARGET_SCHEMA_VERSION, needsMigration: false });
  assert.equal(db.prepare('SELECT display_name FROM chat_conversations WHERE local_id=?').get('saved').display_name, 'Saved draft');
  assert.equal(db.prepare('SELECT display_name FROM group_display_names').get().display_name, 'Human name');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=24').get().n, 1);
});

// Admission-only fixture mutations exercise schema inspection, never runtime
// source rewriting. A readonly probe must reject these shapes without writes.

// Store opening only checks: an empty file is built at the current layout; any
// existing older or newer layout is refused with the file and sidecars untouched.
test('Store builds an empty database but refuses older or newer data unchanged', t => {
  const file = fixture(t);
  const sidecars = () => ['-wal', '-shm'].filter(suffix => fs.existsSync(file + suffix));
  fs.writeFileSync(file, '');
  const created = new Store(file);
  try {
    assert.equal(created.db.pragma('journal_mode', { simple: true }), 'wal');
    assert.deepEqual(owner.inspectSchema(created.db), { currentVersion: TARGET_SCHEMA_VERSION, targetVersion: TARGET_SCHEMA_VERSION, needsMigration: false });
  } finally { created.close(); }
  new Store(file).close();
  fs.rmSync(file);
  legacy(file);
  const before = fs.readFileSync(file);
  assert.throws(() => new Store(file), error => error.code === 'SCHEMA_UPGRADE_REQUIRED' && error.schemaVersion === 13
    && error.supportedVersion === TARGET_SCHEMA_VERSION
    && error.message === `${file}: schema version 13 is older than supported ${TARGET_SCHEMA_VERSION} and was not migrated; run "zylos upgrade --self" to migrate it.`);
  assert.ok(fs.readFileSync(file).equals(before), `${file} changed`);
  assert.deepEqual(sidecars(), []);
  migrateFile(file);
  const newer = new Database(file);
  newer.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(TARGET_SCHEMA_VERSION + 1);
  newer.pragma('journal_mode = DELETE');
  newer.close();
  const newerBytes = fs.readFileSync(file);
  assert.throws(() => new Store(file), { code: 'SCHEMA_TOO_NEW' });
  assert.ok(fs.readFileSync(file).equals(newerBytes), `${file} changed`);
  assert.deepEqual(sidecars(), []);
});

test('schema 28 migration adds an empty pin order and preserves conversations, drafts and names', t => {
  const file = fixture(t);
  const store = new Store(file);
  store.db.exec(`
    DROP TABLE chat_pins;
    DELETE FROM schema_migrations WHERE version >= 29;
    INSERT INTO chat_conversations(local_id,namespace,state,created_at,updated_at,first_content)
      VALUES ('active','dashboard','active',1,2,'first message');
    INSERT INTO chat_conversations(local_id,display_name,created_at,updated_at,pending_content)
      VALUES ('draft','Draft name',3,4,'draft content');
    CREATE TABLE user_items(value TEXT);
    INSERT INTO user_items VALUES('keep');
  `);
  store.writeGroupDisplayName('dashboard:active', 'Active name', 'human');
  const readExisting = db => [
    db.prepare('SELECT * FROM chat_conversations ORDER BY local_id').all(),
    db.prepare('SELECT * FROM group_display_names').all(),
    db.prepare('SELECT * FROM user_items').all(),
  ];
  const before = readExisting(store.db);
  assert.equal(owner.inspectSchema(store.db).currentVersion, 28);
  store.close();
  assertStoreRefuses(file);
  assert.equal(migrateFile(file).currentVersion, TARGET_SCHEMA_VERSION);
  const upgraded = new Store(file);
  t.after(() => upgraded.close());
  assert.deepEqual(readExisting(upgraded.db), before);
  assert.deepEqual(upgraded.db.pragma('table_info(chat_pins)').map(column => column.name), ['tab', 'conversation_id', 'position']);
  assert.deepEqual(upgraded.db.prepare('SELECT * FROM chat_pins').all(), []);
});

test('the Dashboard migration chain preserves custom objects and columns from schema 1', t => {
  const db = new Database(fixture(t));
  t.after(() => db.close());
  db.exec(SCHEMA_V1);
  db.exec(`
    INSERT INTO schema_migrations(version) VALUES (1);
    ALTER TABLE runtime_events ADD COLUMN user_note TEXT;
    INSERT INTO runtime_events(id,ingest_id,event_seq,timestamp,event_type,category,user_note)
      VALUES ('old','old',1,'2026-01-01','sample','test','keep note');
    CREATE TABLE user_items(value TEXT);
    INSERT INTO user_items VALUES ('keep row');
  `);
  assert.equal(owner.migrate(db).currentVersion, TARGET_SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT user_note FROM runtime_events WHERE id=?').pluck().get('old'), 'keep note');
  assert.equal(db.prepare('SELECT value FROM user_items').pluck().get(), 'keep row');
  assert.deepEqual(db.prepare('SELECT * FROM chat_pins').all(), []);
});
