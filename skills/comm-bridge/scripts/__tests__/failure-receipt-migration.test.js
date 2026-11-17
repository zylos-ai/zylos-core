import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import * as owner from '../c4-schema.js';
import { migrateDatabase, guardDatabase } from '../sqlite-schema.js';

const historical = ['c4-v0.1.0.sql', 'c4-v0.4.11.sql', 'c4-v0.5.2.sql', 'c4-v0.9.0-v1.sql'];
for (const name of historical) test(`failure receipt migration preserves historical ${name}`, t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec(fs.readFileSync(new URL(`./fixtures/migration-history/${name}`, import.meta.url), 'utf8'));
  const count = db.prepare('SELECT count(*) AS n FROM conversations').get().n;
  migrateDatabase(db, owner);
  assert.equal(db.pragma('user_version', { simple: true }), 5);
  assert.equal(db.prepare('SELECT count(*) AS n FROM failure_receipts').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM conversations').get().n, count);
  assert.equal(db.prepare('SELECT count(*) AS n FROM conversations WHERE core_source IS NOT NULL OR task_name IS NOT NULL').get().n, 0);
  guardDatabase(db, owner);
});

test('receipt migration preserves v1 deployment extensions and creates no historical receipts', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec(fs.readFileSync(new URL('./fixtures/migration-history/c4-v0.9.0-v1.sql', import.meta.url), 'utf8'));
  db.exec("ALTER TABLE conversations ADD COLUMN deployment_value TEXT; CREATE TABLE deployment_notes(value TEXT); INSERT INTO deployment_notes VALUES('retained')");
  db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status,deployment_value) VALUES('in','telegram','chat','retained','failed','extension')").run();
  migrateDatabase(db, owner, { strict: false });
  assert.equal(db.prepare('SELECT deployment_value FROM conversations WHERE deployment_value IS NOT NULL').get().deployment_value, 'extension');
  assert.equal(db.prepare('SELECT value FROM deployment_notes').get().value, 'retained');
  assert.equal(db.prepare('SELECT count(*) AS n FROM failure_receipts').get().n, 0);
  const legacy = db.prepare('SELECT core_source,task_name FROM conversations WHERE deployment_value IS NOT NULL').get();
  assert.equal(legacy.core_source, null); assert.equal(legacy.task_name, null);
});

test('fresh schema executes receipt migration through the full chain', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  guardDatabase(db, owner);
  assert.equal(db.pragma('user_version', { simple: true }), 5);
  assert.equal(db.prepare('SELECT count(*) AS n FROM failure_receipts').get().n, 0);
});
