import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { execFileSync } from 'node:child_process';
import { dashboardSchemaOwner as owner } from '../src/lib/schema-owner.js';
import { TARGET_SCHEMA_VERSION } from '../src/lib/schema.js';
import { Store } from '../src/lib/store.js';
import { legacy, schema20 } from './fixtures/dashboard-history.js';

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
test('first Store open creates a missing database; owner only consumes open handles', t => {
  const file = fixture(t);
  assert.equal(fs.existsSync(file), false);
  assert.equal('supportsNewDatabase' in owner, false);
  const store = new Store(file);
  t.after(() => store.close());
  assert.deepEqual(owner.inspectSchema(store.db), {currentVersion:TARGET_SCHEMA_VERSION,targetVersion:TARGET_SCHEMA_VERSION,needsMigration:false});
  assert.deepEqual(owner.migrate(store.db), {currentVersion:TARGET_SCHEMA_VERSION,targetVersion:TARGET_SCHEMA_VERSION,needsMigration:false});
  assert.equal(store.db.open, true, 'owner must not close the caller handle');
});
test('explicit schema 13 migration preserves history/auth, nullable identity, constraints and reentry', t => {
  const file=fixture(t); legacy(file);
  const before=fs.readFileSync(file);
  const probe = new Database(file, {readonly:true,fileMustExist:true});
  assert.equal(probe.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,13);
  probe.close();
  assert.deepEqual(fs.readFileSync(file),before);
  assertStoreRefuses(file);
  migrateFile(file);
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
  assertStoreRefuses(file);
  assert.throws(()=>migrateFile(file),/duplicate column/);
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
test('explicit migration initializes its schema alongside unrelated tables', t => {
  const file=fixture(t);
  const db=new Database(file);
  db.exec('CREATE TABLE unrelated(x); INSERT INTO unrelated VALUES(42)');
  db.close();
  assertStoreRefuses(file);
  migrateFile(file);
  const store=new Store(file); t.after(()=>store.close());
  assert.equal(store.db.prepare('SELECT x FROM unrelated').get().x,42);
  assert.deepEqual(owner.inspectSchema(store.db),{currentVersion:TARGET_SCHEMA_VERSION,targetVersion:TARGET_SCHEMA_VERSION,needsMigration:false});
});
test('explicit migration attempts legacy migration without a layout admission check', t => {
  const file=fixture(t);
  const db=new Database(file);
  db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES(13)');
  db.close();
  assertStoreRefuses(file);
  assert.throws(()=>migrateFile(file),/no such table: runtime_events/);
  const result=new Database(file); t.after(()=>result.close());
  assert.equal(result.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,13);
  assert.equal(result.prepare("SELECT name FROM sqlite_master WHERE name='core_log_cursors'").get(),undefined);
});
test('legacy auto_vacuum stays NONE across migration (no startup VACUUM)', t => {
  const file=fixture(t);legacy(file);
  const db=new Database(file);db.pragma('auto_vacuum=NONE');db.exec('VACUUM');db.close();
  migrateFile(file);
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

for (const version of [14, 15, 16, 17, 18, 19]) test(`explicit migration upgrades older schema ${version} without a source-version admission gate`, t => {
  const file = fixture(t); legacy(file);
  const db = new Database(file); db.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(version); db.close();
  assertStoreRefuses(file);
  migrateFile(file);
  const store = new Store(file); t.after(() => store.close());
  assert.equal(owner.inspectSchema(store.db).currentVersion,TARGET_SCHEMA_VERSION);
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
  const writer = `const {default:Database}=await import(process.argv[1]);const db=new Database(process.argv[2]);db.pragma('journal_mode=WAL');db.pragma('wal_autocheckpoint=0');db.exec('INSERT INTO schema_migrations(version) VALUES(99)');process.exit(0);`;
  execFileSync(process.execPath, ['--input-type=module', '-e', writer, new URL('../../comm-bridge/scripts/sqlite-driver.js', import.meta.url).href, file]);
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


// Migration integration: owned historical SQLite only; run for schema/owner
// changes, skip UI-only edits. No network/children/PM2/tmux; handles close before
// fixture cleanup. Historical DDL is data, not re-evaluated product source.
test('historical schema migrates group data atomically without changing old metrics', t => {
  const file = fixture(t); schema20(file);
  const db = new Database(file); t.after(() => db.close());
  const before = db.prepare('SELECT * FROM metric_points').get();
  assert.deepEqual(owner.inspectSchema(db), { currentVersion: 20, targetVersion: TARGET_SCHEMA_VERSION, needsMigration: true });
  assert.deepEqual(owner.migrate(db), { currentVersion: TARGET_SCHEMA_VERSION, targetVersion: TARGET_SCHEMA_VERSION, needsMigration: false });
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
  db.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(TARGET_SCHEMA_VERSION + 1);
  assert.equal(owner.inspectSchema(db).currentVersion, TARGET_SCHEMA_VERSION + 1);
  assert.throws(() => owner.migrate(db), { code: 'SCHEMA_TOO_NEW' });
});

// Current-layout admission: private SQLite only. Run for schema inspection
// changes; skip UI-only edits. No children/services; handles close before cleanup.
test('current schema rejects a missing display-name table or metric group column', t => {
  for (const missing of ['names', 'metric-group']) {
    const file = fixture(t); const store = new Store(file); store.close();
    const db = new Database(file);
    try {
      if (missing === 'names') db.exec('DROP TABLE group_display_names');
      else db.exec('DROP INDEX idx_metric_points_group_ts; ALTER TABLE metric_points DROP COLUMN session_group');
      assert.equal(db.prepare('SELECT MAX(version) version FROM schema_migrations').get().version, TARGET_SCHEMA_VERSION);
      assert.throws(() => owner.inspectSchema(db), missing === 'names'
        ? /no such table: group_display_names/ : /no such column: session_group/);
    } finally { db.close(); }
  }
});

function schema21(file) {
  schema20(file);
  const db = new Database(file);
  db.exec(`
    CREATE TABLE group_display_names (
      session_group TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('human','agent')),
      updated_at TEXT NOT NULL DEFAULT(datetime('now'))
    );
    ALTER TABLE metric_points ADD COLUMN session_group TEXT;
    CREATE INDEX idx_metric_points_group_ts ON metric_points(metric_name,session_group,timestamp);
    CREATE TABLE usage_transcripts (
      transcript_path TEXT PRIMARY KEY, parent_path TEXT,
      runtime TEXT NOT NULL CHECK(runtime IN ('claude','codex')),
      session_group TEXT, run_id TEXT, session_id TEXT NOT NULL,
      byte_offset INTEGER NOT NULL DEFAULT 0 CHECK(byte_offset>=0),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','finished','missing')),
      first_seen_at TEXT NOT NULL DEFAULT(datetime('now')),
      updated_at TEXT NOT NULL DEFAULT(datetime('now'))
    );
    CREATE INDEX idx_usage_transcripts_status_updated ON usage_transcripts(status,updated_at);
    INSERT INTO schema_migrations(version) VALUES(21);
  `);
  db.close();
}

// Migration integration: owned historical SQLite only. Run for run-index or
// schema-owner changes; skip UI-only edits. No network/children/PM2/tmux; owned
// handles close before fixture cleanup. Historical DDL is a frozen data fixture.
test('historical group schema gains the run event index while preserving data and reentry', t => {
  const file = fixture(t); schema21(file);
  const db = new Database(file); t.after(() => db.close());
  db.exec(`
    CREATE TABLE user_notes(note TEXT);
    INSERT INTO user_notes VALUES('retained');
    ALTER TABLE runtime_events ADD COLUMN user_note TEXT;
    UPDATE runtime_events SET session_group='telegram:a', run_id='old-run', user_note='retained';
  `);
  const before = db.prepare('SELECT * FROM runtime_events').get();
  assert.deepEqual(owner.inspectSchema(db), { currentVersion: 21, targetVersion: TARGET_SCHEMA_VERSION, needsMigration: true });
  assert.equal(db.pragma('index_info(idx_events_group_run_seq)').length, 0);
  assert.deepEqual(owner.migrate(db), { currentVersion: TARGET_SCHEMA_VERSION, targetVersion: TARGET_SCHEMA_VERSION, needsMigration: false });
  assert.deepEqual(db.pragma('index_info(idx_events_group_run_seq)').map(column => column.name),
    ['session_group', 'run_id', 'event_seq']);
  const index = db.pragma('index_list(runtime_events)').find(item => item.name === 'idx_events_group_run_seq');
  assert.equal(index.unique, 0); assert.equal(index.partial, 0);
  assert.deepEqual(db.prepare('SELECT * FROM runtime_events').get(), before);
  assert.equal(db.prepare('SELECT note FROM user_notes').get().note, 'retained');
  assert.deepEqual(owner.migrate(db), { currentVersion: TARGET_SCHEMA_VERSION, targetVersion: TARGET_SCHEMA_VERSION, needsMigration: false });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=22').get().n, 1);
  const reopened = new Store(file); reopened.close();
  assert.deepEqual(db.prepare('SELECT * FROM runtime_events').get(), before);
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM runtime_events
    WHERE session_group=? AND run_id=? AND timestamp<=? AND event_type IN (?,?)
    ORDER BY event_seq DESC LIMIT 200`).all('telegram:a', 'old-run', '2026-12-31', 'subagent_start', 'subagent_stop');
  assert.ok(plan.some(row => /SEARCH runtime_events USING INDEX idx_events_group_run_seq \(session_group=\? AND run_id=\?\)/.test(row.detail)));
  assert.equal(plan.some(row => /SCAN runtime_events|USE TEMP B-TREE/.test(row.detail)), false);
});

test('run event index migration failure retains the old version and events', t => {
  const file = fixture(t); schema21(file);
  const db = new Database(file); t.after(() => db.close());
  db.exec('CREATE TABLE idx_events_group_run_seq(note TEXT)');
  const before = db.prepare('SELECT * FROM runtime_events').get();
  assert.throws(() => owner.migrate(db), /already a table/);
  assert.equal(owner.inspectSchema(db).currentVersion, 21);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=22').get().n, 0);
  assert.deepEqual(db.prepare('SELECT * FROM runtime_events').get(), before);
});

// Current-index admission: private SQLite only. Run for run-index/schema checks,
// skip UI-only edits. Readonly owner calls must leave the database unchanged.
for (const [kind, ddl] of [
  ['missing', ''],
  ['wrong columns', 'CREATE INDEX idx_events_group_run_seq ON runtime_events(session_group,event_seq)'],
  ['unique', 'CREATE UNIQUE INDEX idx_events_group_run_seq ON runtime_events(session_group,run_id,event_seq)'],
  ['partial', 'CREATE INDEX idx_events_group_run_seq ON runtime_events(session_group,run_id,event_seq) WHERE run_id IS NOT NULL'],
]) test(`current schema rejects a ${kind} run event index without mutation`, t => {
  const file = fixture(t); const store = new Store(file); store.close();
  const db = new Database(file);
  db.exec('DROP INDEX idx_events_group_run_seq');
  if (ddl) db.exec(ddl);
  db.close();
  const before = fs.readFileSync(file);
  const reader = new Database(file, { readonly: true, fileMustExist: true });
  try {
    assert.throws(() => owner.inspectSchema(reader), /Unsupported Dashboard event run index/);
    assert.throws(() => owner.migrate(reader), /Unsupported Dashboard event run index/);
  } finally { reader.close(); }
  assert.deepEqual(fs.readFileSync(file), before);
});

function schema23(file) {
  const db = new Database(file);
  db.exec(fs.readFileSync(new URL('./fixtures/dashboard-schema22.sql', import.meta.url), 'utf8'));
  // Frozen prior owner migration: the question table already belongs to the
  // preceding schema, so upgrading drafts must neither recreate nor rewrite it.
  db.exec(`CREATE TABLE IF NOT EXISTS chat_questions (
    c4_id TEXT PRIMARY KEY NOT NULL,
    session_group TEXT NOT NULL,
    endpoint_id TEXT,
    message_id TEXT NOT NULL,
    interrupt_id TEXT NOT NULL,
    question_summary TEXT NOT NULL,
    constraints TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'paused',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_group, interrupt_id)
  );
  INSERT OR IGNORE INTO schema_migrations(version) VALUES(23);
  INSERT INTO runtime_events(id,ingest_id,event_seq,timestamp,event_type,category) VALUES('old','old',1,'2026-01-01','prompt','activity');
  INSERT INTO chat_questions(c4_id,session_group,endpoint_id,message_id,interrupt_id,question_summary,constraints)
    VALUES('5','dashboard:old','old','message','interrupt','Question','{}');`);
  db.close();
}

// Migration boundary: real historical Dashboard SQLite only. Run for draft
// schema changes; skip unrelated UI edits. No C4, child, network, tmux or PM2;
// every handle closes before the fixture's own directory is removed.
test('draft migration preserves existing group names and user data from the prior schema', t => {
  const file = fixture(t); schema23(file);
  const db = new Database(file); t.after(() => db.close());
  db.exec(`INSERT INTO group_display_names(session_group,display_name,source) VALUES('dashboard:old','Existing name','human');
    CREATE TABLE user_chat_notes(note TEXT);
    INSERT INTO user_chat_notes VALUES('retained');
    ALTER TABLE runtime_events ADD COLUMN user_label TEXT;
    UPDATE runtime_events SET user_label='retained';`);
  const names = db.prepare('SELECT * FROM group_display_names').all();
  const events = db.prepare('SELECT * FROM runtime_events').all();
  const questions = db.prepare('SELECT * FROM chat_questions').all();
  assert.equal(questions.length, 1);
  assert.deepEqual(owner.inspectSchema(db), { currentVersion: 23, targetVersion: TARGET_SCHEMA_VERSION, needsMigration: true });
  assert.deepEqual(owner.migrate(db), { currentVersion: TARGET_SCHEMA_VERSION, targetVersion: TARGET_SCHEMA_VERSION, needsMigration: false });
  assert.deepEqual(db.prepare('SELECT * FROM group_display_names').all(), names);
  assert.deepEqual(db.prepare('SELECT * FROM runtime_events').all(), events);
  assert.deepEqual(db.prepare('SELECT * FROM chat_questions').all(), questions);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=23').get().n, 1);
  assert.equal(db.prepare('SELECT note FROM user_chat_notes').get().note, 'retained');
  db.prepare(`INSERT INTO chat_conversations(local_id,display_name,created_at,updated_at) VALUES(?,?,?,?)`)
    .run('fresh-local', 'Draft name', 1, 1);
  assert.equal(db.prepare('SELECT state FROM chat_conversations').get().state, 'draft');
  assert.deepEqual(owner.migrate(db), { currentVersion: TARGET_SCHEMA_VERSION, targetVersion: TARGET_SCHEMA_VERSION, needsMigration: false });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=24').get().n, 1);
  const reopened = new Store(file); reopened.close();
  assert.equal(db.prepare('SELECT display_name FROM chat_conversations').get().display_name, 'Draft name');
});

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
for (const [shape, transform] of [
  ['missing first content', sql => sql.replace('first_content TEXT,', '')],
  ['nullable local identifier', sql => sql.replace('local_id TEXT PRIMARY KEY NOT NULL', 'local_id TEXT PRIMARY KEY')],
  ['non-text local identifier', sql => sql.replace('local_id TEXT PRIMARY KEY NOT NULL', 'local_id INTEGER PRIMARY KEY NOT NULL')],
  ['missing primary key', sql => sql.replace('local_id TEXT PRIMARY KEY NOT NULL', 'local_id TEXT NOT NULL')],
  ['nullable state', sql => sql.replace("state TEXT NOT NULL DEFAULT 'draft'", "state TEXT DEFAULT 'draft'")],
  ['nullable creation timestamp', sql => sql.replace('created_at INTEGER NOT NULL', 'created_at INTEGER')],
  ['nullable update timestamp', sql => sql.replace('updated_at INTEGER NOT NULL', 'updated_at INTEGER')],
  ['required namespace', sql => sql.replace('namespace TEXT,', 'namespace TEXT NOT NULL,')],
  ['required draft name', sql => sql.replace('display_name TEXT,', 'display_name TEXT NOT NULL,')],
]) test(`current schema rejects a ${shape} registration layout without mutation`, t => {
  const file = fixture(t); const store = new Store(file); store.close();
  const db = new Database(file);
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE name='chat_conversations'").get().sql;
  const index = db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_chat_conversations_drafts_page'").get().sql;
  const changed = transform(table); assert.notEqual(changed, table);
  db.exec('DROP TABLE chat_conversations'); db.exec(changed); db.exec(index); db.close();
  const before = fs.readFileSync(file);
  const reader = new Database(file, { readonly: true, fileMustExist: true });
  try {
    assert.throws(() => owner.inspectSchema(reader), /Unsupported Dashboard conversation registration|no such column: first_content/);
    assert.throws(() => owner.migrate(reader), /Unsupported Dashboard conversation registration|no such column: first_content/);
  } finally { reader.close(); }
  assert.deepEqual(fs.readFileSync(file), before);
});

for (const [shape, sql] of [
  ['missing', ''],
  ['wrong expression', "CREATE INDEX idx_chat_conversations_drafts_page ON chat_conversations(updated_at DESC,local_id) WHERE state <> 'active'"],
  ['unfiltered', "CREATE INDEX idx_chat_conversations_drafts_page ON chat_conversations(updated_at / 86400000.0 + 2440587.5 DESC, ('d:' || local_id) COLLATE BINARY)"],
]) test(`current schema rejects a ${shape} draft pagination index`, t => {
  const file = fixture(t); const store = new Store(file); store.close();
  const db = new Database(file); t.after(() => db.close());
  db.exec('DROP INDEX idx_chat_conversations_drafts_page'); if (sql) db.exec(sql);
  assert.throws(() => owner.inspectSchema(db), /Unsupported Dashboard draft page index/);
});

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
