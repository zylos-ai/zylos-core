import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { dashboardSchemaOwner as owner } from '../src/lib/schema-owner.js';
import { Store } from '../src/lib/store.js';
import { migrateSchema13 } from './fixtures/schema13.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-schema-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'dashboard.db');
}
function legacy(file) {
  const db = new Database(file);
  migrateSchema13(db);
  db.exec(`
    INSERT INTO runtime_events(id,ingest_id,event_seq,timestamp,event_type,category) VALUES('old','old',1,'2026-01-01','prompt','activity');
    INSERT INTO auth_sessions(token_hash,created_at,last_activity_at) VALUES('retained',1,2);`);
  db.close();
}
test('first Store open creates a missing database; owner only consumes open handles', t => {
  const file = fixture(t);
  assert.equal(fs.existsSync(file), false);
  assert.equal('supportsNewDatabase' in owner, false);
  const store = new Store(file);
  t.after(() => store.close());
  assert.deepEqual(owner.inspectSchema(store.db), {currentVersion:21,targetVersion:21,needsMigration:false});
  assert.deepEqual(owner.migrate(store.db), {currentVersion:21,targetVersion:21,needsMigration:false});
  assert.equal(store.db.open, true, 'owner must not close the caller handle');
});
test('first Store open schema 13 migration preserves history/auth, nullable identity, constraints and reentry', t => {
  const file=fixture(t); legacy(file);
  const before=fs.readFileSync(file);
  const probe = new Database(file, {readonly:true,fileMustExist:true});
  assert.equal(probe.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,13);
  probe.close();
  assert.deepEqual(fs.readFileSync(file),before);
  const migrated = new Store(file); migrated.close();
  const db=new Database(file); t.after(()=>db.close());
  assert.deepEqual(db.prepare('SELECT session_group,run_id FROM runtime_events WHERE id=?').get('old'),{session_group:null,run_id:null});
  assert.equal(db.prepare('SELECT token_hash FROM auth_sessions').get().token_hash,'retained');
  db.exec("INSERT INTO core_log_cursors(stream,file_dev,file_ino,generation,file_name) VALUES('x',1,1,1,'a')");
  assert.throws(()=>db.exec("INSERT INTO core_log_cursors(stream,file_dev,file_ino,generation,file_name) VALUES('x',1,1,2,'b')"),/UNIQUE/);
  assert.throws(()=>db.exec("UPDATE core_log_cursors SET byte_offset=1"),/CHECK/);
  assert.throws(()=>db.exec("UPDATE core_log_cursors SET anchor_len=4097,anchor_sha256='x'"),/CHECK/);
  db.exec("UPDATE core_log_cursors SET status='gap'");
  db.exec("INSERT INTO core_log_cursors(stream,file_dev,file_ino,generation,file_name) VALUES('x',1,1,2,'b')");
  owner.migrate(db);
  const store=new Store(file); store.close();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM runtime_events').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=20').get().n,1);
});
test('migration 20 DDL failure rolls back all its changes and version', t => {
  const file=fixture(t);legacy(file);
  let db=new Database(file);db.exec('ALTER TABLE runtime_events ADD COLUMN run_id TEXT');db.close();
  assert.throws(()=>new Store(file),/duplicate column/);
  db=new Database(file);t.after(()=>db.close());
  assert.equal(db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,13);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='core_log_cursors'").get(),undefined);
  assert.equal(db.pragma('table_info(runtime_events)').some(c=>c.name==='session_group'),false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM runtime_events').get().n,1);
});
test('newer schema with user_version zero rejects writes; inspection remains read only', t => {
  const file=fixture(t);legacy(file);
  const db=new Database(file);db.exec('INSERT INTO schema_migrations(version) VALUES(99)');db.close();
  const before=fs.readFileSync(file);
  const handle=new Database(file,{readonly:true,fileMustExist:true}); t.after(()=>handle.close());
  assert.equal(owner.inspectSchema(handle).currentVersion,99);
  assert.throws(()=>owner.migrate(handle),{code:'SCHEMA_TOO_NEW'});
  assert.deepEqual(fs.readFileSync(file),before);
});
test('first Store open initializes its schema alongside unrelated tables', t => {
  const file=fixture(t);
  const db=new Database(file);
  db.exec('CREATE TABLE unrelated(x); INSERT INTO unrelated VALUES(42)');
  db.close();
  const store=new Store(file); t.after(()=>store.close());
  assert.equal(store.db.prepare('SELECT x FROM unrelated').get().x,42);
  assert.deepEqual(owner.inspectSchema(store.db),{currentVersion:21,targetVersion:21,needsMigration:false});
});
test('first Store open attempts legacy migration without a layout admission check', t => {
  const file=fixture(t);
  const db=new Database(file);
  db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES(13)');
  db.close();
  assert.throws(()=>new Store(file),/no such table: runtime_events/);
  const result=new Database(file); t.after(()=>result.close());
  assert.equal(result.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,13);
  assert.equal(result.prepare("SELECT name FROM sqlite_master WHERE name='core_log_cursors'").get(),undefined);
});
test('legacy auto_vacuum stays NONE across migration (no startup VACUUM)', t => {
  const file=fixture(t);legacy(file);
  const db=new Database(file);db.pragma('auto_vacuum=NONE');db.exec('VACUUM');db.close();
  const store=new Store(file); store.close();
  const result=new Database(file);t.after(()=>result.close());
  assert.equal(result.pragma('auto_vacuum',{simple:true}),0);
});

test('supported version with wrong same-name index is rejected before mutation', t => {
  const file=fixture(t);const store=new Store(file);store.close();
  const db=new Database(file);db.exec('DROP INDEX idx_core_log_cursors_active; CREATE INDEX idx_core_log_cursors_active ON core_log_cursors(file_name)');db.close();
  const before=fs.readFileSync(file);
  const handle=new Database(file,{readonly:true,fileMustExist:true});t.after(()=>handle.close());
  assert.throws(()=>owner.inspectSchema(handle),/Unsupported Dashboard active cursor index/);
  assert.throws(()=>owner.migrate(handle),/Unsupported Dashboard active cursor index/);
  assert.deepEqual(fs.readFileSync(file),before);
});
test('supported version missing Store required column is rejected', t => {
  const file=fixture(t);const store=new Store(file);store.close();
  const db=new Database(file);db.exec('ALTER TABLE activity_facts DROP COLUMN project');db.close();
  const handle=new Database(file,{readonly:true,fileMustExist:true});t.after(()=>handle.close());
  assert.throws(()=>owner.inspectSchema(handle),/no such column/);
});

for (const version of [14, 15, 16, 17, 18, 19]) test(`first Store open migrates older schema ${version} without a source-version admission gate`, t => {
  const file = fixture(t); legacy(file);
  const db = new Database(file); db.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(version); db.close();
  const store = new Store(file); t.after(() => store.close());
  assert.equal(owner.inspectSchema(store.db).currentVersion,21);
  assert.equal(store.db.prepare('SELECT token_hash FROM auth_sessions').get().token_hash,'retained');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM runtime_events').get().n,1);
});

test('readonly inspection includes committed WAL state without changing database contents', t => {
  const file = fixture(t); legacy(file);
  const writer = new Database(file); t.after(() => writer.close());
  writer.pragma('journal_mode = WAL'); writer.pragma('wal_autocheckpoint = 0');
  writer.exec('INSERT INTO schema_migrations(version) VALUES(99)');
  const before = fs.readFileSync(file);
  const wal = fs.readFileSync(file + '-wal');
  const reader = new Database(file, {readonly:true,fileMustExist:true}); t.after(() => reader.close());
  assert.equal(owner.inspectSchema(reader).currentVersion, 99);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readFileSync(file + '-wal'), wal);
});


test('too-new committed WAL is refused on a caller-owned readonly handle', t => {
  const file = fixture(t); legacy(file);
  // Exit with a live connection so committed WAL survives without a final checkpoint.
  const writer = `const {createRequire}=await import('node:module');const Database=createRequire(process.argv[1])('better-sqlite3');const db=new Database(process.argv[2]);db.pragma('journal_mode=WAL');db.pragma('wal_autocheckpoint=0');db.exec('INSERT INTO schema_migrations(version) VALUES(99)');process.exit(0);`;
  execFileSync(process.execPath, ['--input-type=module', '-e', writer, new URL('../package.json', import.meta.url).pathname, file]);
  const mainBefore = fs.readFileSync(file), walBefore = fs.readFileSync(file + '-wal');
  assert.ok(walBefore.length > 0);
  const reader = new Database(file, {readonly:true,fileMustExist:true});
  assert.throws(() => owner.migrate(reader), { code: 'SCHEMA_TOO_NEW' });
  assert.equal(reader.open, true);
  reader.close();
  assert.deepEqual(fs.readFileSync(file), mainBefore);
  assert.deepEqual(fs.readFileSync(file + '-wal'), walBefore);
  // Positive control: opening/closing a writable connection does checkpoint these bytes.
  const control = new Database(file);
  assert.equal(control.prepare('SELECT MAX(version) v FROM schema_migrations').get().v, 99);
  control.close();
  assert.notDeepEqual(fs.readFileSync(file), mainBefore);
});

function schema20(file) {
  legacy(file);
  const db = new Database(file);
  db.exec(`
    CREATE TABLE core_log_cursors (
      stream TEXT NOT NULL, file_dev INTEGER NOT NULL, file_ino INTEGER NOT NULL,
      generation INTEGER NOT NULL CHECK(generation>=1), anchor_len INTEGER NOT NULL DEFAULT 0 CHECK(anchor_len BETWEEN 0 AND 4096),
      anchor_sha256 TEXT, file_name TEXT NOT NULL, byte_offset INTEGER NOT NULL DEFAULT 0 CHECK(byte_offset>=0),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done','gap','source_missing')),
      updated_at TEXT NOT NULL DEFAULT(datetime('now')), PRIMARY KEY(stream,file_dev,file_ino,generation),
      CHECK((anchor_len=0)=(anchor_sha256 IS NULL)), CHECK(anchor_len>0 OR byte_offset=0)
    );
    CREATE UNIQUE INDEX idx_core_log_cursors_active ON core_log_cursors(stream,file_dev,file_ino) WHERE status='active';
    ALTER TABLE runtime_events ADD COLUMN session_group TEXT;
    ALTER TABLE runtime_events ADD COLUMN run_id TEXT;
    CREATE INDEX idx_events_group_seq ON runtime_events(session_group,event_seq);
    INSERT INTO schema_migrations(version) VALUES(20);
    INSERT INTO metric_points(timestamp,metric_name,metric_value,source) VALUES('2026-01-01','retained',42,'fixture');
  `);
  db.close();
}

// Migration integration: owned historical SQLite only; run for schema/owner
// changes, skip UI-only edits. No network/children/PM2/tmux; handles close before
// fixture cleanup. Historical DDL is data, not re-evaluated product source.
test('historical schema migrates group data atomically without changing old metrics', t => {
  const file = fixture(t); schema20(file);
  const db = new Database(file); t.after(() => db.close());
  const before = db.prepare('SELECT * FROM metric_points').get();
  assert.deepEqual(owner.inspectSchema(db), { currentVersion: 20, targetVersion: 21, needsMigration: true });
  assert.deepEqual(owner.migrate(db), { currentVersion: 21, targetVersion: 21, needsMigration: false });
  assert.deepEqual(db.prepare('SELECT * FROM metric_points').get(), { ...before, session_group: null });
  for (const table of ['group_display_names', 'usage_transcripts']) assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
  assert.deepEqual(db.pragma('index_info(idx_metric_points_group_ts)').map(c => c.name), ['metric_name', 'session_group', 'timestamp']);
  assert.deepEqual(db.pragma('index_info(idx_usage_transcripts_status_updated)').map(c => c.name), ['status', 'updated_at']);
  assert.throws(() => db.exec("INSERT INTO usage_transcripts(transcript_path,runtime,session_id,byte_offset) VALUES('bad','claude','s',-1)"), /CHECK/);
  assert.throws(() => db.exec("INSERT INTO usage_transcripts(transcript_path,runtime,session_id,status) VALUES('bad','claude','s','bad')"), /CHECK/);
  assert.throws(() => db.exec("INSERT INTO usage_transcripts(transcript_path,runtime,session_id) VALUES('bad','bad','s')"), /CHECK/);
  assert.throws(() => db.exec("INSERT INTO group_display_names(session_group,display_name,source) VALUES('a','n','bad')"), /CHECK/);
  owner.migrate(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=21').get().n, 1);
  const store = new Store(file); store.close();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM runtime_events').get().n, 1);
});
test('group data migration failure rolls back preceding DDL and version', t => {
  const file = fixture(t); schema20(file);
  const db = new Database(file); t.after(() => db.close());
  db.exec('CREATE TABLE usage_transcripts(unrelated TEXT)');
  assert.throws(() => owner.migrate(db), /no such column/);
  assert.equal(owner.inspectSchema(db).currentVersion, 20);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='group_display_names'").get(), undefined);
  assert.equal(db.pragma('table_info(metric_points)').some(c => c.name === 'session_group'), false);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='idx_metric_points_group_ts'").get(), undefined);
  assert.equal(db.prepare('SELECT metric_value FROM metric_points').get().metric_value, 42);
});
test('schema above target refuses migration and malformed group indexes are rejected', t => {
  const file = fixture(t); const store = new Store(file); store.close();
  const db = new Database(file); t.after(() => db.close());
  db.exec('DROP INDEX idx_metric_points_group_ts; CREATE INDEX idx_metric_points_group_ts ON metric_points(timestamp)');
  assert.throws(() => owner.inspectSchema(db), /Unsupported Dashboard group data index/);
  db.exec('INSERT INTO schema_migrations(version) VALUES(22)');
  assert.equal(owner.inspectSchema(db).currentVersion, 22);
  assert.throws(() => owner.migrate(db), { code: 'SCHEMA_TOO_NEW' });
});
