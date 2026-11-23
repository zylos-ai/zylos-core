import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { fixture } from './c4-v2-test-helpers.js';
import { seedV1, snapshot } from './helpers/c4-v2-fixtures.js';
import { migrateToV2 } from '../c4-migrations-v2.js';
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
    assert.equal(owner.inspectSchema(db, { allowExtraTables: true, allowExtraColumns: true }).version, owner.SUPPORTED_SCHEMA_VERSION);
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

test('an older opener refuses the current database without changing it', t => {
  const { db } = fixture(t);
  const before = snapshot(db);
  const previous = { SUPPORTED_SCHEMA_VERSION: 3, inspectSchema: connection => inspectLayout(connection, 'c4', 3, owner.TABLES) };
  assert.throws(() => guardDatabase(db, previous), { code: 'SCHEMA_TOO_NEW' });
  assert.deepEqual(snapshot(db), before);
});

test('version two migrates through both rebuilds and writes deletion and release endings', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  seedV1(db, { extensions: true }); migrateToV2(db); db.pragma('user_version=2');
  db.exec("INSERT INTO run_endings(session_group,run_id,reason,ended_at) VALUES('old','run','ttl',1)");
  migrate(db);
  assert.equal(db.pragma('user_version', { simple: true }), owner.SUPPORTED_SCHEMA_VERSION);
  assert.equal(db.prepare("SELECT reason FROM run_endings WHERE session_group='old'").get().reason, 'ttl');
  db.exec("INSERT INTO run_endings(session_group,run_id,reason,ended_at) VALUES('deleted','run','delete',2)");
  release(db);
  assertUnrestrictedReason(db);
  assert.equal(db.prepare('SELECT note FROM user_notes').get().note, 'retained');
});
