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
  assert.deepEqual(owner.inspectSchema(store.db), {currentVersion:20,targetVersion:20,needsMigration:false});
  assert.deepEqual(owner.migrate(store.db), {currentVersion:20,targetVersion:20,needsMigration:false});
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
test('unsupported layout is refused on the supplied handle without mutation', t => {
  const file=fixture(t);
  const db=new Database(file); t.after(()=>db.close());
  db.exec('CREATE TABLE unrelated(x)');
  const before=fs.readFileSync(file);
  assert.throws(()=>owner.migrate(db),/Unsupported Dashboard layout/);
  assert.deepEqual(fs.readFileSync(file),before);
  assert.equal(db.open,true);
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

for (const version of [14, 15, 16, 17, 18, 19]) test(`unpublished schema ${version} is rejected before migration writes`, t => {
  const file = fixture(t); legacy(file);
  const db = new Database(file); db.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(version); db.close();
  const before = fs.readFileSync(file);
  const handle = new Database(file, {readonly:true,fileMustExist:true}); t.after(() => handle.close());
  assert.throws(() => owner.inspectSchema(handle), /Unsupported Dashboard migration source/);
  assert.throws(() => owner.migrate(handle), /Unsupported Dashboard migration source/);
  assert.deepEqual(fs.readFileSync(file), before);
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
