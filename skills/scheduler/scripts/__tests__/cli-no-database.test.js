import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from '../../../comm-bridge/scripts/sqlite-driver.js';
import * as owner from '../schema.js';

const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));
const v1Layout = fileURLToPath(new URL('../../../comm-bridge/scripts/__tests__/fixtures/migration-history/scheduler-v0.9.0-v1.sql', import.meta.url));

// Every child gets a private HOME and ZYLOS_DIR; the paths are read back below
// before any command runs, so a missing variable cannot fall back to ~/zylos.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-no-db-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), zylosDir = path.join(root, 'zylos');
  fs.mkdirSync(home); fs.mkdirSync(zylosDir);
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylosDir, TZ: 'UTC' };
  delete env.ZYLOS_SESSION_GROUP;
  assert.ok(env.ZYLOS_DIR.startsWith(root) && env.HOME.startsWith(root));
  const run = args => spawnSync(process.execPath, [cliPath, ...args], { env, encoding: 'utf8', timeout: 20000 });
  return { zylosDir, dbFile: path.join(zylosDir, 'scheduler', 'scheduler.db'), run };
}
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function seedV1(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(fs.readFileSync(v1Layout, 'utf8'));
  db.exec("INSERT INTO tasks(id,name,prompt,type,next_run_at,created_at,updated_at) VALUES('task-kept','kept','content','one-time',2,1,1)");
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  db.close();
}

test('a data command on an older database reports the required upgrade and changes nothing', t => {
  const f = fixture(t);
  seedV1(f.dbFile);
  const before = sha(f.dbFile);
  const text = f.run(['list']);
  assert.notEqual(text.status, 0);
  assert.match(text.stderr, /SCHEMA_UPGRADE_REQUIRED/);
  assert.match(text.stderr, new RegExp(`scheduler\\.db: schema version 1 is older than supported ${owner.SUPPORTED_SCHEMA_VERSION}`));
  assert.match(text.stderr, /and was not migrated; run "zylos upgrade --self" to migrate it\./);
  const json = f.run(['list', '--json']);
  assert.notEqual(json.status, 0);
  assert.equal(JSON.parse(json.stdout).error.code, 'SCHEMA_UPGRADE_REQUIRED');
  assert.equal(sha(f.dbFile), before);
  const db = new Database(f.dbFile, { readonly: true });
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  assert.equal(db.prepare("SELECT name FROM tasks WHERE id='task-kept'").get().name, 'kept');
  db.close();
});
