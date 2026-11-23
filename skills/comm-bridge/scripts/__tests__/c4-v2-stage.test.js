import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { migrateDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { seedV1 } from './helpers/c4-v2-fixtures.js';
const moduleURL = new URL('../c4-db.js', import.meta.url).href;
function root(t) { const dir = mkdtempSync(join(tmpdir(), 'c4-stage-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function child(dir, code, env = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ZYLOS_DIR: dir, ...env }, encoding: 'utf8' });
}
test('public getDb refuses historical v1 unchanged, then checks the layout the explicit migration produced', t => {
  const dir = root(t); mkdirSync(join(dir, 'comm-bridge')); const filename = join(dir, 'comm-bridge/c4.db');
  const db = new Database(filename); seedV1(db); db.close(); const before = readFileSync(filename);
  const refused = child(dir, `import assert from 'node:assert/strict'; import {getDb} from ${JSON.stringify(moduleURL)};
assert.throws(getDb, { code: 'SCHEMA_UPGRADE_REQUIRED' });`);
  assert.equal(refused.status, 0, refused.stderr); assert.ok(readFileSync(filename).equals(before), `${filename} changed`);
  const upgrade = new Database(filename); migrateDatabase(upgrade, owner, { strict: false }); upgrade.close();
  const result = child(dir, `import assert from 'node:assert/strict'; import {getDb,close} from ${JSON.stringify(moduleURL)};
const db=getDb(); assert.equal(db.pragma('user_version',{simple:true}),${owner.SUPPORTED_SCHEMA_VERSION});
for(const name of ['group_heads','drain_fences','mode_transitions','origin_sync_cursors']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); close();`);
  assert.equal(result.status, 0, result.stderr);
  const read = new Database(filename, { readonly: true }); t.after(() => read.close()); assert.equal(read.pragma('user_version', { simple: true }), owner.SUPPORTED_SCHEMA_VERSION);
});
