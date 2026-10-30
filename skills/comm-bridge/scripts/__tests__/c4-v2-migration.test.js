import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import * as owner from '../c4-schema.js';
import * as v1 from './helpers/c4-v1-owner.js';
import { migrateToV2 } from '../c4-migrations-v2.js';
import { guardDatabase, migrateDatabase, planDatabaseMigration } from '../sqlite-schema.js';
import { NEW_TABLES, seedV1, oldRows, snapshot } from './helpers/c4-v2-fixtures.js';

function database(t, options) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  seedV1(db, options);
  return db;
}
function changedOwner(migrate) {
  return { ...owner, MIGRATIONS: { ...owner.MIGRATIONS, 1: { ...owner.MIGRATIONS[1], migrate } } };
}
function assertMigrated(db, before) {
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  assert.deepEqual(oldRows(db), before);
  assert.ok(db.prepare('SELECT session_group,session_id FROM conversations').all()
    .every(row => row.session_group === '' && row.session_id === null));
  assert.ok(db.prepare('SELECT session_group,no_content FROM checkpoints').all()
    .every(row => row.session_group === '*' && row.no_content === 0));
  assert.ok(db.prepare('SELECT session_group,target_binding FROM control_queue').all()
    .every(row => row.session_group === null && row.target_binding === null));
  for (const table of NEW_TABLES) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
}

test('v1 rows remain identical, defaults are applied, new tables are empty', t => {
  const db = database(t), before = oldRows(db);
  migrateDatabase(db, owner);
  assertMigrated(db, before);
  // Independent assertion detects both forbidden historical backfill and head insertion.
  db.exec("UPDATE conversations SET session_group='telegram';");
  assert.throws(() => assertMigrated(db, before), assert.AssertionError);
  db.exec("UPDATE conversations SET session_group=''; INSERT INTO group_heads VALUES('telegram',6)");
  assert.throws(() => assertMigrated(db, before), assert.AssertionError);
});

test('empty database executes 0→1→2 with initial checkpoint', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const calls = [];
  const counted = { ...owner, MIGRATIONS: Object.fromEntries(Object.entries(owner.MIGRATIONS).map(([from, step]) =>
    [from, { ...step, migrate(connection, options) { calls.push([Number(from), step.to]); step.migrate(connection, options); } }])) };
  guardDatabase(db, counted);
  assert.deepEqual(calls, [[0, 1], [1, 2]]);
  const check = () => {
    assert.equal(db.pragma('user_version', { simple: true }), 2);
    assert.deepEqual(db.prepare('SELECT summary,session_group,no_content FROM checkpoints').all(),
      [{ summary: 'initial', session_group: '*', no_content: 0 }]);
    assert.deepEqual(Object.keys(owner.TABLES).sort(), db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name).sort());
  };
  check(); db.exec('DELETE FROM checkpoints'); assert.throws(check, assert.AssertionError);
});

const indexSql = {
  idx_conv_group_id: 'CREATE INDEX idx_conv_group_id ON conversations(session_group, id)',
  idx_conv_group_status: 'CREATE INDEX idx_conv_group_status ON conversations(session_group, direction, status)',
  idx_conv_channel_endpoint: 'CREATE INDEX idx_conv_channel_endpoint ON conversations(channel, endpoint_id, id)',
  idx_conv_loadable_id: "CREATE INDEX idx_conv_loadable_id ON conversations(id) WHERE (direction = 'in' AND status = 'delivered') OR direction = 'out'",
  idx_ckpt_group_id: 'CREATE INDEX idx_ckpt_group_id ON checkpoints(session_group, id)',
  idx_mode_transitions_open: "CREATE UNIQUE INDEX idx_mode_transitions_open ON mode_transitions((0)) WHERE phase <> 'complete'",
};
function assertIndexes(db) {
  for (const [name, sql] of Object.entries(indexSql)) {
    assert.equal(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name)?.sql.replace(/\s+/g, ' ').trim(), sql);
  }
  const indexes = db.pragma('index_list(mode_transitions)');
  assert.ok(indexes.some(row => row.name === 'idx_mode_transitions_open' && row.unique === 1 && row.partial === 1));
}
function transition(db, run, source = 'single', target = 'multi', phase = 'gating') {
  return db.prepare('INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,created_at,updated_at) VALUES(?,?,?,?,1,1)').run(run, source, target, phase);
}
test('six exact indexes, binary keys, namespace and transition/config constraints', t => {
  const db = database(t); guardDatabase(db, owner); assertIndexes(db);
  const ns = db.prepare('INSERT INTO channel_namespaces VALUES(?,?)');
  for (const name of ['a', 'a'.repeat(32), 'foo-2_x']) ns.run(name, `component:${name}`);
  for (const name of ['', 'Origin', 'origin', 'void', 'internal', 'a'.repeat(33), 'a\0b', 'a b', '1foo', 'a.b', 'é'])
    assert.throws(() => ns.run(name, `bad:${name}`), /CHECK/);
  assert.throws(() => ns.run('a', 'other'), /UNIQUE/);
  assert.throws(() => ns.run('another', 'component:a'), /UNIQUE/);
  ns.run('upper', 'Component'); ns.run('lower', 'component');
  transition(db, 'done', 'single', 'multi', 'complete');
  transition(db, 'open');
  assert.throws(() => transition(db, 'second'), /UNIQUE/);
  for (const [source, target, phase] of [['single','multi','aborted'],['bad','multi','complete'],['single','bad','complete'],['single','single','complete']])
    assert.throws(() => transition(db, 'invalid', source, target, phase), /CHECK/);
  const model = db.prepare('INSERT INTO group_model_overrides VALUES(?,?,?,?)');
  model.run('ns:A', 'codex', 'model', 'effort'); model.run('ns:a', 'codex', 'model', 'effort');
  model.run('ns:A', 'claude', 'model', 'effort');
  assert.throws(() => model.run('ns:A', 'codex', 'model', 'effort'), /UNIQUE/);
  for (const [m, e] of [['','high'],['   ','high'],['model',''],['model','   ']])
    assert.throws(() => model.run('test', 'codex', m, e), /CHECK/);
  for (const table of ['group_runtime_overrides', 'group_model_overrides'])
    assert.throws(() => db.prepare(`INSERT INTO ${table} VALUES(${table.includes('model') ? 'NULL,?,?,?' : 'NULL,?'})`).run(...(table.includes('model') ? ['codex','m','e'] : ['codex'])), /NOT NULL/);
  db.exec('DROP INDEX idx_conv_group_id'); assert.throws(() => assertIndexes(db), assert.AssertionError);
  // A weakened CHECK must make the same rejection assertion fail.
  db.pragma('ignore_check_constraints=ON');
  assert.throws(() => assert.throws(() => ns.run('Origin', 'weak-check'), /CHECK/), assert.AssertionError);
});

test('repeated guards do not invoke migrations or change live fences/transitions', t => {
  const db = database(t); guardDatabase(db, owner);
  db.exec("INSERT INTO drain_fences VALUES('telegram','upgrade','run',123)"); transition(db, 'run');
  const before = snapshot(db); let calls = 0;
  const counted = changedOwner(() => { calls++; });
  guardDatabase(db, counted); guardDatabase(db, counted);
  const check = () => { assert.equal(calls, 0); assert.deepEqual(snapshot(db), before); };
  check(); db.exec('DELETE FROM drain_fences'); assert.throws(check, assert.AssertionError);
});

test('user tables, columns and values survive v1→2', t => {
  const db = database(t, { extensions: true });
  const before = oldRows(db), tags = db.prepare('SELECT id,user_tag FROM conversations ORDER BY id').all();
  guardDatabase(db, owner); assertMigrated(db, before);
  const check = () => {
    assert.deepEqual(db.prepare('SELECT * FROM user_notes').all(), [{ id: 1, note: 'retained' }]);
    assert.deepEqual(db.prepare('SELECT id,user_tag FROM conversations ORDER BY id').all(), tags);
  };
  check(); db.exec('ALTER TABLE conversations DROP COLUMN user_tag'); assert.throws(check, /user_tag/);
});

for (const name of NEW_TABLES) test(`${name} collision rejected before callback with zero changes`, t => {
  const db = database(t); db.exec(`CREATE TABLE ${name}(x); INSERT INTO ${name} VALUES('user data')`);
  const before = snapshot(db); let calls = 0;
  const candidate = changedOwner(connection => { calls++; migrateToV2(connection); });
  const check = () => {
    assert.throws(() => guardDatabase(db, candidate), /already exists|collid/);
    assert.equal(calls, 0); assert.deepEqual(snapshot(db), before);
  };
  check();
  // A swallowed precondition exception is detected by the same throws assertion.
  assert.throws(() => assert.throws(() => { try { guardDatabase(db, candidate); } catch {} }), assert.AssertionError);
});
for (const [table, column] of [['conversations','session_group'],['conversations','session_id'],['checkpoints','session_group'],['checkpoints','no_content'],['control_queue','session_group'],['control_queue','target_binding']])
  test(`existing ${table}.${column} is not silently adopted`, t => {
    const db = database(t); db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    const before = snapshot(db); let calls = 0;
    assert.throws(() => guardDatabase(db, changedOwner(() => { calls++; })), /already exists|collid/);
    assert.equal(calls, 0); assert.deepEqual(snapshot(db), before);
  });

// Intercept only the SQLite exec boundary, executing the real callback up to its fifth table.
function interrupted(db, { commit = false } = {}) {
  migrateToV2({ exec(sql) {
    const prefix = sql.split('CREATE TABLE group_runtime_overrides')[0];
    db.exec(prefix);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('channel_namespaces','group_heads','origin_sync_cursors','drain_fences','mode_transitions')").get().n, 5);
    if (commit) db.exec('COMMIT');
    throw Error('injected after fifth table');
  } });
}
test('fifth-table exception rolls back and permits clean reentry; premature commit is detected', t => {
  const db = database(t), before = snapshot(db);
  assert.throws(() => guardDatabase(db, changedOwner(interrupted)), /injected after fifth/);
  assert.deepEqual(snapshot(db), before); assert.equal(db.inTransaction, false);
  guardDatabase(db, owner); assertMigrated(db, oldRowsFromSnapshot(before));
  const mutant = database(t), original = snapshot(mutant);
  assert.throws(() => guardDatabase(mutant, changedOwner(connection => interrupted(connection, { commit: true }))), /injected/);
  assert.throws(() => assert.deepEqual(snapshot(mutant), original), assert.AssertionError);
});
function oldRowsFromSnapshot(state) {
  return Object.fromEntries(Object.keys(v1.TABLES).map(table => [table, state.rows[table]]));
}
test('SIGKILL after fifth table recovers on reopen and migration reentry', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-v2-crash-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.db'); let db = new Database(file); seedV1(db); const before = snapshot(db); db.close();
  const code = `import Database from ${JSON.stringify(import.meta.resolve('better-sqlite3'))};
    import * as owner from ${JSON.stringify(new URL('../c4-schema.js', import.meta.url).href)};
    import {guardDatabase} from ${JSON.stringify(new URL('../sqlite-schema.js', import.meta.url).href)};
    import {migrateToV2} from ${JSON.stringify(new URL('../c4-migrations-v2.js', import.meta.url).href)};
    const db=new Database(process.argv[1]);
    guardDatabase(db,{...owner,MIGRATIONS:{...owner.MIGRATIONS,1:{...owner.MIGRATIONS[1],migrate(connection){
      migrateToV2({exec(sql){connection.exec(sql.split('CREATE TABLE group_runtime_overrides')[0]); process.kill(process.pid,'SIGKILL');}});
    }}}});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, file], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  db = new Database(file); t.after(() => db.close()); assert.deepEqual(snapshot(db), before);
  guardDatabase(db, owner); assertMigrated(db, oldRowsFromSnapshot(before));
});

for (const tag of ['v0.1.0', 'v0.4.11', 'v0.5.2']) test(`${tag} retains 0→1 retag before 1→2`, t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec(fs.readFileSync(new URL(`./fixtures/migration-history/c4-${tag}.sql`, import.meta.url), 'utf8'));
  db.exec("INSERT INTO conversations(direction,channel,endpoint_id,content) VALUES('in','web-console','session-handoff','history')");
  assert.deepEqual(planDatabaseMigration(db, owner).steps.map(({ from, to }) => [from, to]), [[0,1],[1,2]]);
  guardDatabase(db, owner);
  const check = () => {
    assert.equal(db.pragma('user_version', { simple: true }), 2);
    assert.deepEqual(db.prepare('SELECT channel,content,session_group FROM conversations').all(), [{ channel: 'void', content: 'history', session_group: '' }]);
  };
  check(); db.exec("UPDATE conversations SET channel='web-console'"); assert.throws(check, assert.AssertionError);
});

test('frozen v1 owner refuses v2 without writes', t => {
  const db = database(t); guardDatabase(db, owner); const before = snapshot(db);
  assert.throws(() => v1.inspectSchema(db), /schema version 2 exceeds supported 1/);
  assert.throws(() => guardDatabase(db, v1), /schema version 2 exceeds supported 1/);
  assert.deepEqual(snapshot(db), before);
  assert.throws(() => assert.throws(() => owner.inspectSchema(db), /exceeds supported/), assert.AssertionError);
});
test('historical out-of-range checkpoint is preserved for subsequent read-only audit', t => {
  const db = database(t); db.exec('UPDATE checkpoints SET end_conversation_id=1006 WHERE id=2');
  const before = oldRows(db); guardDatabase(db, owner); assertMigrated(db, before);
});

test('oracle: maybeTables plus IF NOT EXISTS wrongly accepts a matching user table', t => {
  const db = database(t);
  db.exec('CREATE TABLE drain_fences(session_group TEXT PRIMARY KEY, reason TEXT, run_id TEXT, created_at INTEGER NOT NULL)');
  db.exec("INSERT INTO drain_fences VALUES('user','retained','user-run',1)");
  const changes = owner.MIGRATIONS[1].changes;
  const { drain_fences, ...addTables } = changes.addTables;
  const mutant = { ...owner, MIGRATIONS: { ...owner.MIGRATIONS, 1: {
    ...owner.MIGRATIONS[1], changes: { ...changes, addTables, maybeTables: { drain_fences } },
    migrate(connection) { migrateToV2({ exec(sql) { connection.exec(sql.replace('CREATE TABLE drain_fences', 'CREATE TABLE IF NOT EXISTS drain_fences')); } }); },
  } } };
  assert.throws(() => assert.throws(() => guardDatabase(db, mutant), /collid/), assert.AssertionError);
  assert.equal(db.pragma('user_version', { simple: true }), 2);
});

for (const name of [...Object.keys(indexSql), 'IDX_MODE_TRANSITIONS_OPEN']) {
  test(`existing index ${name} rejects migration and preserves the entire v1 database`, t => {
    const db = database(t);
    db.exec(`CREATE TABLE user_extra(x); INSERT INTO user_extra VALUES('preserved'); CREATE INDEX ${name} ON user_extra(x)`);
    const before = snapshot(db);
    assert.throws(() => guardDatabase(db, owner), /index .* already exists/i);
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.inTransaction, false);
  });
}
test('oracle: IF NOT EXISTS hides user index collision and loses open-transition uniqueness', t => {
  const db = database(t);
  db.exec('CREATE TABLE user_extra(x); CREATE INDEX idx_mode_transitions_open ON user_extra(x)');
  const unsafe = changedOwner(connection => migrateToV2({ exec(sql) {
    connection.exec(sql.replace(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/g, 'CREATE $1INDEX IF NOT EXISTS '));
  } }));
  assert.throws(() => assert.throws(() => guardDatabase(db, unsafe), /already exists/), assert.AssertionError);
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  assert.equal(db.prepare("SELECT tbl_name FROM sqlite_master WHERE name='idx_mode_transitions_open'").get().tbl_name, 'user_extra');
  transition(db, 'first');
  assert.throws(() => assert.throws(() => transition(db, 'second'), /UNIQUE/), assert.AssertionError);
});
