import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { fixture } from './c4-v2-test-helpers.js';
import { seedV1, oldRows, snapshot } from './helpers/c4-v2-fixtures.js';
import { migrateToV2 } from '../c4-migrations-v2.js';
import { migrateToV3 } from '../c4-migrations-v3.js';
import { migrateDatabase, guardDatabase } from '../sqlite-schema.js';
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
  test(`release constraint migrates historical ${historical} with user extensions`, t => {
    const db = new Database(':memory:'); t.after(() => db.close());
    db.exec(fs.readFileSync(new URL(`./fixtures/migration-history/${historical}`, import.meta.url), 'utf8'));
    db.exec("CREATE TABLE local_notes(note TEXT); INSERT INTO local_notes VALUES('retained'); ALTER TABLE conversations ADD COLUMN local_tag TEXT; UPDATE conversations SET local_tag='kept'");
    const tags = db.prepare('SELECT id,local_tag FROM conversations ORDER BY id').all();
    migrate(db);
    assert.equal(owner.inspectSchema(db, { allowExtraTables: true, allowExtraColumns: true }).version, 4);
    release(db);
    assert.equal(db.prepare('SELECT note FROM local_notes').get().note, 'retained');
    assert.deepEqual(db.prepare('SELECT id,local_tag FROM conversations ORDER BY id').all(), tags);
    const before = snapshot(db); migrate(db); assert.deepEqual(snapshot(db), before);
  });
}

test('new databases include release through the full migration chain', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  guardDatabase(db, owner); release(db);
  assert.equal(db.pragma('user_version', { simple: true }), 4);
  assert.throws(() => db.prepare("UPDATE run_endings SET reason='unsupported'").run(), /constraint/i);
});

function seedV3(db) {
  seedV1(db, { extensions: true }); migrateToV2(db); migrateToV3(db); db.pragma('user_version=3');
}

test('v3 release constraint preserves ending data, extensions, generated columns and schema objects', t => {
  const db = new Database(':memory:'); t.after(() => db.close()); seedV3(db);
  db.exec(`ALTER TABLE run_endings ADD COLUMN local_tag TEXT NOT NULL DEFAULT 'extra';
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
  assert.deepEqual(oldRows(db), rows);
  assert.deepEqual(db.prepare('SELECT * FROM run_endings').all(), ending);
  assert.equal(db.prepare('SELECT local_upper FROM local_ending_view').get().local_upper, 'EXTRA');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='local_ending_idx'").get());
  release(db, 'dashboard:a');
  assert.equal(db.prepare('SELECT tag FROM local_ending_log').get().tag, 'extra');
  assert.equal(db.prepare('SELECT local_upper FROM run_endings WHERE reason=\'release\'').get().local_upper, 'EXTRA');
  assert.equal(db.prepare('SELECT note FROM user_notes').get().note, 'retained');
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
