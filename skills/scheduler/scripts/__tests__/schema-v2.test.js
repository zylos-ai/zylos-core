import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import * as owner from '../schema.js';
import { guardDatabase, migrateDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';

const fixtures = new URL('../../../comm-bridge/scripts/__tests__/fixtures/migration-history/', import.meta.url);
function seed(t, name) {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec(fs.readFileSync(new URL(name, fixtures), 'utf8'));
  db.exec("INSERT INTO tasks(id,name,prompt,type,next_run_at,created_at,updated_at,reply_channel,reply_endpoint) VALUES('route','kept','content','one-time',2,1,1,'telegram','-1'),('plain','no route','other','one-time',3,1,1,NULL,NULL)");
  return db;
}
const snapshot = db => ({ layout: db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), rows: db.prepare('SELECT * FROM tasks ORDER BY id').all(), version: db.pragma('user_version', { simple: true }) });
function verify(db, before) {
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  const rows = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  assert.deepEqual(rows.map(({ session_component, session_group_name, ...row }) => row), before.rows);
  assert.ok(rows.every(row => row.session_component === null && row.session_group_name === null));
}
for (const name of ['scheduler-v0.1.0.sql', 'scheduler-v0.9.0-v1.sql']) test(`DM-10 ${name} preserves bytes, no inferred group, repeat entry is inert`, t => {
  const db = seed(t, name);
  db.exec('CREATE TABLE user_data(id INTEGER); ALTER TABLE tasks ADD COLUMN user_extra TEXT');
  const before = snapshot(db); let calls = 0;
  const counted = { ...owner, MIGRATIONS: { ...owner.MIGRATIONS, 1: { ...owner.MIGRATIONS[1], migrate(connection) { calls++; owner.MIGRATIONS[1].migrate(connection); } } } };
  migrateDatabase(db, counted, { strict: false }); verify(db, before);
  const done = snapshot(db); guardDatabase(db, counted); guardDatabase(db, counted);
  assert.equal(calls, 1); assert.deepEqual(snapshot(db), done);
});
test('DM-10 DDL or version publish failure rolls back both new columns, rows and version', t => {
  for (const phase of ['ddl', 'version']) {
    const db = seed(t, 'scheduler-v0.9.0-v1.sql'), before = snapshot(db);
    let failed;
    if (phase === 'ddl') failed = { ...owner, MIGRATIONS: { ...owner.MIGRATIONS, 1: { ...owner.MIGRATIONS[1], migrate(connection) { owner.MIGRATIONS[1].migrate(connection); throw new Error('after DDL'); } } } };
    else {
      const pragma = db.pragma.bind(db);
      db.pragma = (statement, ...args) => { if (statement === 'user_version = 2') throw new Error('before version'); return pragma(statement, ...args); };
      failed = owner;
    }
    assert.throws(() => migrateDatabase(db, failed), /after DDL|before version/);
    assert.deepEqual(snapshot(db), before);
    if (phase === 'version') delete db.pragma;
    migrateDatabase(db, owner); verify(db, before);
  }
});
test('DM-10 retention assertion catches forbidden reply-route backfill and repeated ALTER', t => {
  const db = seed(t, 'scheduler-v0.9.0-v1.sql'), before = snapshot(db);
  const mutant = { ...owner, MIGRATIONS: { ...owner.MIGRATIONS, 1: { ...owner.MIGRATIONS[1], migrate(connection) {
    owner.MIGRATIONS[1].migrate(connection); connection.exec('UPDATE tasks SET session_component=reply_channel');
  } } } };
  migrateDatabase(db, mutant);
  assert.throws(() => verify(db, before), assert.AssertionError);
  assert.throws(() => owner.MIGRATIONS[1].migrate(db), /duplicate column/);
});
