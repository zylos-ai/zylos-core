import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { fixture } from './c4-v2-test-helpers.js';
import { seedV1, oldRows, snapshot } from './helpers/c4-v2-fixtures.js';
import { migrateToV2 } from '../c4-migrations-v2.js';
import { migrateToV3 } from '../c4-migrations-v3.js';
import { migrateDatabase, guardDatabase, inspectLayout } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';

const migrate = db => migrateDatabase(db, owner, { allowExtraTables: true, allowExtraColumns: true });
const release = (db, group = 'telegram', runId = 'released') => db.prepare(
  "INSERT INTO run_endings(session_group,run_id,reason,ended_at) VALUES(?,?,'release',100)",
).run(group, runId);

for (const group of ['origin', 'telegram']) test(`release ending clears the matching fence and leaves ${group} cold`, t => {
  const { db, store } = fixture(t);
  store.recordRunEnd(group, { runId: 'previous', reason: 'unexpected' });
  if (group !== 'origin') assert.equal(store.takeSlot(group, { runId: 'released', k: 1 }).taken, true);
  store.setDrainFence(group, { reason: 'release', runId: 'released' });
  assert.deepEqual(store.recordRunEnd(group, {
    runId: 'released', reason: 'release',
    clearFence: { expectedReason: 'release', expectedRunId: 'released' },
  }), { recorded: true });
  assert.equal(store.listRunEndings([group])[0].reason, 'release');
  assert.equal(store.listRunEndings([group])[0].continuationPending, 0);
  assert.deepEqual(store.listPendingContinuations(), []);
  assert.equal(store.getDrainFence(group), null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM slot_occupancy').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM control_queue').get().n, 0);
  if (group !== 'origin') assert.equal(store.takeSlot('next', { runId: 'next', k: 1 }).taken, true);
});

for (const historical of ['c4-v0.1.0.sql', 'c4-v0.4.11.sql', 'c4-v0.5.2.sql', 'c4-v0.9.0-v1.sql']) {
  test(`ending reason constraint is removed from historical ${historical} with user extensions`, t => {
    const db = new Database(':memory:'); t.after(() => db.close());
    db.exec(fs.readFileSync(new URL(`./fixtures/migration-history/${historical}`, import.meta.url), 'utf8'));
    db.exec("CREATE TABLE local_notes(note TEXT); INSERT INTO local_notes VALUES('retained'); ALTER TABLE conversations ADD COLUMN local_tag TEXT; UPDATE conversations SET local_tag='kept'");
    const tags = db.prepare('SELECT id,local_tag FROM conversations ORDER BY id').all();
    migrate(db);
    assert.equal(owner.inspectSchema(db, { allowExtraTables: true, allowExtraColumns: true }).version, 4);
    assertUnrestrictedReason(db);
    release(db);
    assert.equal(db.prepare('SELECT note FROM local_notes').get().note, 'retained');
    assert.deepEqual(db.prepare('SELECT id,local_tag FROM conversations ORDER BY id').all(), tags);
    const before = snapshot(db); migrate(db); assert.deepEqual(snapshot(db), before);
  });
}

function assertUnrestrictedReason(db) {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='run_endings'").get().sql;
  assert.doesNotMatch(sql, /reason\s+IN\s*\(/i);
  assert.equal(db.prepare('PRAGMA table_info(run_endings)').all().find(column => column.name === 'reason').notnull, 1);
  db.exec('SAVEPOINT reason_probe');
  db.prepare("INSERT INTO run_endings(session_group,run_id,reason,ended_at) VALUES('future-reason','future','future_reason',1)").run();
  assert.throws(() => db.prepare("UPDATE run_endings SET reason=NULL WHERE session_group='future-reason'").run(), /NOT NULL/i);
  db.exec('ROLLBACK TO reason_probe; RELEASE reason_probe');
}

test('new databases validate reason nullability but leave reason values to the writer', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  guardDatabase(db, owner); release(db);
  assert.equal(db.pragma('user_version', { simple: true }), 4);
  assertUnrestrictedReason(db);
});

test('a version three opener refuses a version four database without changing it', t => {
  const { db } = fixture(t);
  const before = snapshot(db);
  const previous = { SUPPORTED_SCHEMA_VERSION: 3, inspectSchema: connection => inspectLayout(connection, 'c4', 3, owner.TABLES) };
  assert.throws(() => guardDatabase(db, previous), { code: 'SCHEMA_TOO_NEW' });
  assert.deepEqual(snapshot(db), before);
});

function seedV3(db) {
  seedV1(db, { extensions: true }); migrateToV2(db); migrateToV3(db); db.pragma('user_version=3');
}

test('version two migrates through both rebuilds and writes deletion and release endings', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  seedV1(db, { extensions: true }); migrateToV2(db); db.pragma('user_version=2');
  db.exec("INSERT INTO run_endings(session_group,run_id,reason,ended_at) VALUES('old','run','ttl',1)");
  migrate(db);
  assert.equal(db.pragma('user_version', { simple: true }), 4);
  assert.equal(db.prepare("SELECT reason FROM run_endings WHERE session_group='old'").get().reason, 'ttl');
  db.exec("INSERT INTO run_endings(session_group,run_id,reason,ended_at) VALUES('deleted','run','delete',2)");
  release(db);
  assertUnrestrictedReason(db);
  assert.equal(db.prepare('SELECT note FROM user_notes').get().note, 'retained');
});

test('removing the v3 reason constraint preserves ending data, extensions, generated columns and schema objects', t => {
  const db = new Database(':memory:'); t.after(() => db.close()); seedV3(db);
  db.exec(`ALTER TABLE run_endings ADD COLUMN local_tag TEXT NOT NULL DEFAULT 'extra' CHECK (local_tag IN ('extra','custom'));
    ALTER TABLE run_endings ADD COLUMN local_upper TEXT GENERATED ALWAYS AS (upper(local_tag)) STORED;
    INSERT INTO run_endings(session_group,run_id,reason,ended_at,continuation_pending) VALUES('telegram','old','delete',1,0);
    CREATE INDEX local_ending_idx ON run_endings(local_tag);
    CREATE TABLE local_ending_log(tag TEXT);
    CREATE TRIGGER local_ending_trigger AFTER INSERT ON run_endings BEGIN INSERT INTO local_ending_log VALUES(NEW.local_tag); END;
    CREATE VIEW local_ending_view AS SELECT local_tag,local_upper FROM run_endings;`);
  assert.throws(() => release(db, 'before'), /constraint/i);
  const rows = oldRows(db);
  const ending = db.prepare('SELECT * FROM run_endings').all();
  migrate(db);
  assert.equal(db.pragma('user_version', { simple: true }), 4);
  assertUnrestrictedReason(db);
  assert.deepEqual(oldRows(db), rows);
  assert.deepEqual(db.prepare('SELECT * FROM run_endings').all(), ending);
  assert.equal(db.prepare('SELECT local_upper FROM local_ending_view').get().local_upper, 'EXTRA');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='local_ending_idx'").get());
  release(db, 'dashboard:a');
  assert.equal(db.prepare('SELECT tag FROM local_ending_log').get().tag, 'extra');
  assert.equal(db.prepare('SELECT local_upper FROM run_endings WHERE reason=\'release\'').get().local_upper, 'EXTRA');
  assert.equal(db.prepare('SELECT note FROM user_notes').get().note, 'retained');
  assert.throws(() => db.prepare("UPDATE run_endings SET local_tag='invalid'").run(), /constraint/i);
});

for (const replacement of ['', "CHECK (length(reason)>0)", "CHECK (reason IN ('ttl')) CHECK (reason IN ('ttl','delete'))"]) {
  test(`unrecognized reason constraint rolls back unchanged: ${replacement || 'missing check'}`, t => {
    const db = new Database(':memory:'); t.after(() => db.close()); seedV3(db);
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='run_endings'").get().sql;
    db.exec('DROP TABLE run_endings');
    db.exec(sql.replace(/CHECK\s*\(reason IN\s*\([^)]*\)\)/i, replacement));
    db.exec("INSERT INTO run_endings(session_group,run_id,reason,ended_at) VALUES('kept','old','ttl',1)");
    const before = snapshot(db);
    assert.throws(() => migrate(db), /Run ending constraint is unavailable or ambiguous/);
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.pragma('user_version', { simple: true }), 3);
  });
}

test('ending reason whitelist is enforced by the real writer before any database write', t => {
  const { db, store } = fixture(t);
  assertUnrestrictedReason(db);
  for (const reason of ['future_reason', '', 'TTL', null, undefined, 1]) {
    assert.throws(() => store.recordRunEnd('invalid', { runId: 'run', reason }), { code: 'INVALID_ARGS' });
    assert.equal(db.prepare("SELECT count(*) AS n FROM run_endings WHERE session_group='invalid'").get().n, 0);
  }
  for (const reason of ['ttl', 'evict', 'release', 'upgrade', 'auth', 'model_config', 'mode_switch', 'manual_restart', 'unexpected', 'delete']) {
    assert.deepEqual(store.recordRunEnd('valid', { runId: reason, reason }), { recorded: true });
    assert.equal(store.listRunEndings(['valid'])[0].reason, reason);
  }
});

for (const foreignKeys of [0, 1]) test(`v3 release migration refuses incoming foreign keys with enforcement ${foreignKeys}`, t => {
  const db = new Database(':memory:'); t.after(() => db.close()); seedV3(db);
  db.pragma(`foreign_keys=${foreignKeys}`);
  db.exec(`INSERT INTO run_endings(session_group,run_id,reason,ended_at) VALUES('telegram','old','ttl',1);
    CREATE TABLE local_notes(session_group TEXT REFERENCES RUN_ENDINGS(session_group) ON DELETE CASCADE,note TEXT);
    INSERT INTO local_notes VALUES('telegram','retained');`);
  const before = snapshot(db);
  assert.throws(() => migrate(db), /table "local_notes" has a foreign key referencing run_endings/);
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.pragma('foreign_keys', { simple: true }), foreignKeys);
});
