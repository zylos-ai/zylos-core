import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import * as owner from '../c4-schema.js';
import { guardDatabase } from '../sqlite-schema.js';
import { NEW_TABLES } from './helpers/c4-v2-fixtures.js';

test('PR-A: complete v2 owner is registered and guards an isolated database', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  guardDatabase(db, owner);
  assert.equal(owner.SUPPORTED_SCHEMA_VERSION, 2);
  assert.equal(owner.MIGRATIONS[1].to, 2);
  assert.deepEqual(Object.keys(owner.MIGRATIONS[1].changes).sort(), ['addColumns', 'addTables']);
  assert.deepEqual(Object.keys(owner.MIGRATIONS[1].changes.addTables).sort(), [...NEW_TABLES].sort());
  const check = (candidate) => {
    assert.deepEqual(Object.keys(candidate.TABLES).sort(), db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name).sort());
    for (const [table, definitions] of Object.entries(candidate.COLUMN_DEFINITIONS)) {
      const columns = db.pragma(`table_info(${table})`);
      assert.deepEqual(columns.map(c => c.name), candidate.TABLES[table]);
      assert.deepEqual(Object.fromEntries(columns.map(c => [c.name, { type: c.type, pk: c.pk > 0 }])), definitions);
    }
  };
  check(owner);
  assert.equal(owner.COLUMN_DEFINITIONS.group_model_overrides.session_group.pk, true);
  assert.equal(owner.COLUMN_DEFINITIONS.group_model_overrides.runtime.pk, true);
  const { origin_sync_cursors, ...incomplete } = owner.TABLES;
  assert.throws(() => check({ ...owner, TABLES: incomplete }), assert.AssertionError);
  db.exec('ALTER TABLE origin_sync_cursors DROP COLUMN checkpoint_id');
  assert.throws(() => guardDatabase(db, owner), /checkpoint_id/);
});
