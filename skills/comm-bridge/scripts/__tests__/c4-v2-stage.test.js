import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { guardDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';
import { seedV1, NEW_TABLES } from './helpers/c4-v2-fixtures.js';
const moduleURL = new URL('../c4-db.js', import.meta.url).href;
// – frozen public function list, independent of implementation.
const exportsRequired = `getChannelNamespace getComponentByNamespace ensureChannelNamespace registerChannelNamespace composeSessionGroup parseSessionGroup resolveSessionGroup insertConversation insertInternalMessage
markStatusNoticeSuppressed getNextPending expirePending claimConversation recoverOrphanRunning markDelivered requeueConversation failDelivery hasOutboundAfter listPendingSessionGroups countRunningConversations countGlobalRunningConversations
legacyBaselineEnd getCoverageEnd getGlobalCoverageEnd getDeliveredFrontier getGlobalDeliveredFrontier getLatestContentCheckpoint getDeliveredSince getGlobalDeliveredSince createCheckpoint
getUnsummarizedRange getGlobalUnsummarizedRange getUnsummarizedConversations getGlobalUnsummarizedConversations getOriginSyncBacklog getContentCheckpointsSince getOriginSyncConversations advanceOriginSyncCursor
insertControl getNextPendingControl claimControl expirePendingControls countNonTerminalControls expireStaleRunningControls expireControlById buildTargetBinding
setDrainFence getDrainFence listDrainFences clearDrainFence getLastActivity
beginModeTransition getModeTransition getLastCompletedModeTransition setModeTransitionPhase absorbForTransition getAbsorbedConversations listGroupHeads
getSessionModelConfig setSessionModelConfig resetSessionModelConfig getSessionRuntimeConfig setSessionRuntimeConfig resetSessionRuntimeConfig resolveSessionLaunchConfig listGroupRuntimeOverrides
auditCheckpoints getDb close`.split(/\s+/);
function root(t) { const dir = mkdtempSync(join(tmpdir(), 'c4-stage-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function child(dir, code, env = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ZYLOS_DIR: dir, ...env }, encoding: 'utf8' });
}
test('PR-B every frozen named export imports and pure parsers run without opening a database', t => {
  const dir = root(t);
  const result = child(dir, `import assert from 'node:assert/strict';
import {${exportsRequired.join(',')}} from ${JSON.stringify(moduleURL)};
for (const value of [${exportsRequired.join(',')}]) assert.equal(typeof value,'function');
assert.deepEqual(parseSessionGroup('foo:A:b'),{namespace:'foo',groupName:'A:b'});
assert.equal(composeSessionGroup('foo','A:b'),'foo:A:b');
const api=await import(${JSON.stringify(moduleURL)});
for(const key of ['getLastCheckpoint','incrementRetryCount','markFailed']) assert.equal(key in api,false,key);
close();`);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ''); assert.deepEqual(readdirSync(dir), []);
});
test('PR-B injectable factory does not touch its connection until a database operation', t => {
  const db = new Database(':memory:'); t.after(() => db.close()); guardDatabase(db, owner); let opens = 0;
  const store = createStore(() => { opens++; return db; }); assert.equal(opens, 0);
  assert.equal(store.getChannelNamespace('missing'), null); assert.equal(opens, 1);
});
test('PR-B public getDb runs real owner migration from historical v1 then checks v2 layout', t => {
  const dir = root(t); mkdirSync(join(dir, 'comm-bridge')); const filename = join(dir, 'comm-bridge/c4.db');
  const db = new Database(filename); seedV1(db); db.close();
  const result = child(dir, `import assert from 'node:assert/strict'; import {getDb,close} from ${JSON.stringify(moduleURL)};
const db=getDb(); assert.equal(db.pragma('user_version',{simple:true}),2);
for(const name of ['group_heads','drain_fences','mode_transitions','origin_sync_cursors']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); close();`);
  assert.equal(result.status, 0, result.stderr);
  const read = new Database(filename, { readonly: true }); t.after(() => read.close()); assert.equal(read.pragma('user_version', { simple: true }), 2);
});
for (const corruption of ['future-version', 'missing-required-column']) test(`PR-B public getDb rejects ${corruption} through owner guard before accepting connection`, t => {
  const dir = root(t); mkdirSync(join(dir, 'comm-bridge')); const filename = join(dir, 'comm-bridge/c4.db');
  const db = new Database(filename); guardDatabase(db, owner);
  if (corruption === 'future-version') db.pragma('user_version = 999');
  else db.exec('ALTER TABLE conversations DROP COLUMN session_id');
  db.close(); const before = readFileSync(filename);
  const result = child(dir, `import assert from 'node:assert/strict'; import {getDb,close} from ${JSON.stringify(moduleURL)};
for(let i=0;i<2;i++) assert.throws(()=>getDb(),/schema|supported/); close();`);
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(readFileSync(filename), before);
});

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

test('copied skill refuses import when its explicit Core dependency is absent, without opening a database', t => {
  const dir = root(t), skill = join(dir, '.claude/skills/comm-bridge');
  mkdirSync(skill, { recursive: true });
  cpSync(new URL('../', import.meta.url), join(skill, 'scripts'), { recursive: true, filter: source => !source.includes('__tests__') });
  cpSync(new URL('../../package.json', import.meta.url), join(skill, 'package.json'));
  symlinkSync(new URL('../../node_modules', import.meta.url).pathname, join(skill, 'node_modules'));
  const copied = new URL(`file://${join(skill, 'scripts/c4-db.js')}`).href;
  const result = child(dir, `import assert from 'node:assert/strict';
await assert.rejects(import(${JSON.stringify(copied)}), /Cannot locate the installed zylos-core cli\\/lib\\/config\\.js/);`,
  { ZYLOS_PACKAGE_ROOT: join(dir, 'absent-core-package') });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(dir), ['.claude']);
});
