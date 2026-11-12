import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from '../../../comm-bridge/scripts/sqlite-driver.js';
import { guardDatabase, migrateDatabase, planDatabaseMigration } from '../../../comm-bridge/scripts/sqlite-schema.js';
import * as owner from '../schema.js';
import { migrateToV3 } from '../migrations-v3.js';
import { processCompletedTasks } from '../daemon-tasks.js';

const fixtures = new URL('../../../comm-bridge/scripts/__tests__/fixtures/migration-history/', import.meta.url);
const timestamp = Date.parse('2030-01-01T00:02:00Z') / 1000;
function legacy(t, name) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(fs.readFileSync(new URL(name, fixtures), 'utf8'));
  return db;
}
function addTasks(db) {
  const insert = db.prepare(`INSERT INTO tasks
    (id,name,prompt,type,cron_expression,interval_seconds,timezone,next_run_at,status,created_at,updated_at,last_error,failed_at)
    VALUES(?,?,'legacy scheduled prompt',?,?,?,'Asia/Shanghai',? ,?,1,?,'previous warning',?)`);
  for (const [id, type, cron, seconds, status] of [
    ['legacy-once', 'one-time', null, null, 'running'],
    ['legacy-cron', 'recurring', '0 9 * * *', null, 'running'],
    ['legacy-interval', 'interval', null, 1800, 'running'],
    ['legacy-without-history', 'one-time', null, null, 'running'],
    ['untouched-pending', 'interval', null, 1800, 'pending'],
    ['untouched-failed', 'one-time', null, null, 'failed'],
    ['untouched-paused', 'recurring', '0 9 * * *', null, 'paused'],
    ['untouched-completed', 'one-time', null, null, 'completed'],
  ]) insert.run(id, id, type, cron, seconds, timestamp - 300, status, timestamp - 60, timestamp - 60);
  const history = db.prepare('INSERT INTO task_history(task_id,executed_at,status,error) VALUES(?,?,?,?)');
  for (const id of ['legacy-once', 'legacy-cron', 'legacy-interval']) {
    history.run(id, timestamp - 60, 'started', 'SESSION_GROUP_QUERY_FAILED');
    history.run(id, timestamp - 120, 'timeout', 'TASK_TIMEOUT');
  }
  history.run('untouched-pending', timestamp - 60, 'started', 'retained pending history');
}
const snapshot = db => ({
  tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
  history: db.prepare('SELECT * FROM task_history ORDER BY id').all(),
  layout: db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),
  version: db.pragma('user_version', { simple: true }),
});
function verify(db, before) {
  assert.equal(db.pragma('user_version', { simple: true }), 3);
  assert.equal(owner.inspectSchema(db, { strict: false }).version, 3);
  for (const id of ['legacy-once', 'legacy-cron', 'legacy-interval', 'legacy-without-history']) {
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    const original = before.tasks.find(row => row.id === id);
    assert.equal(task.status, 'completed');
    assert.equal(task.last_run_at, timestamp);
    assert.equal(task.updated_at, timestamp);
    assert.equal(task.last_error, null);
    assert.equal(task.failed_at, null);
    assert.equal(task.timezone, original.timezone);
    assert.equal(task.cron_expression, original.cron_expression);
    assert.equal(task.interval_seconds, original.interval_seconds);
    assert.equal(task.next_run_at, original.next_run_at);
    const started = db.prepare("SELECT * FROM task_history WHERE task_id=? AND executed_at=?").get(id, timestamp - 60);
    if (started) {
      assert.equal(started.status, 'success');
      assert.equal(started.completed_at, timestamp);
      assert.equal(started.duration_ms, 60000);
      assert.equal(started.error, 'SESSION_GROUP_QUERY_FAILED');
    }
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status='running'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, before.tasks.length);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_history').get().n, before.history.length);
  for (const row of before.tasks.filter(row => row.id.startsWith('untouched-'))) {
    const actual = db.prepare('SELECT * FROM tasks WHERE id=?').get(row.id);
    // Source-v1 rows gain only the already-released routing columns.
    assert.deepEqual(Object.fromEntries(Object.keys(row).map(key => [key, actual[key]])), row);
  }
  for (const row of before.history.filter(row => row.status !== 'started' || row.task_id.startsWith('untouched-'))) {
    assert.deepEqual(db.prepare('SELECT * FROM task_history WHERE id=?').get(row.id), row);
  }
}

// Migration contract: actual historical SQLite layouts -> current schema with
// row conversion; no processes, sockets, tmux, C4 or network. Run after migration
// changes; skip unrelated scheduling/UI edits. Official runner isolates HOME,
// ZYLOS_DIR, PM2_HOME, short TMPDIR and private TMUX_TMPDIR; databases are in-memory
// and closed in teardown. The outer harness reads back all argv/environment paths.
for (const name of ['scheduler-v0.1.0.sql', 'scheduler-v0.9.0-v1.sql']) {
  test(`${name} adopts delivered legacy runs and preserves user extensions`, t => {
    t.mock.timers.enable({ apis: ['Date'], now: timestamp * 1000 });
    const db = legacy(t, name);
    addTasks(db);
    db.exec("CREATE TABLE user_notes(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO user_notes VALUES(1,'retained'); ALTER TABLE tasks ADD COLUMN user_extra TEXT; UPDATE tasks SET user_extra='kept'");
    const before = snapshot(db);
    const result = migrateDatabase(db, owner, { strict: false });
    assert.equal(result.version, 3);
    verify(db, before);
    assert.equal(db.prepare('SELECT value FROM user_notes').get().value, 'retained');
    assert.ok(db.prepare('SELECT user_extra FROM tasks').all().every(row => row.user_extra === 'kept'));
    const after = snapshot(db);
    guardDatabase(db, owner); guardDatabase(db, owner);
    migrateToV3(db);
    assert.deepEqual(snapshot(db), after);
  });
}

test('tagged routing schema upgrades only delivery rows and is repeatable', t => {
  t.mock.timers.enable({ apis: ['Date'], now: timestamp * 1000 });
  const db = legacy(t, 'scheduler-v0.9.0-v1.sql');
  owner.MIGRATIONS[1].migrate(db);
  db.pragma('user_version = 2');
  addTasks(db);
  const before = snapshot(db);
  assert.deepEqual(planDatabaseMigration(db, owner).steps.map(({ from, to }) => [from, to]), [[2, 3]]);
  migrateDatabase(db, owner);
  verify(db, before);
  const after = snapshot(db);
  t.mock.timers.tick(3600000);
  guardDatabase(db, owner); migrateToV3(db);
  assert.deepEqual(snapshot(db), after);
});

test('new scheduler database traverses the full migration chain without runs to convert', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  assert.equal(migrateDatabase(db, owner, { allowNew: true }).version, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_history').get().n, 0);
  assert.deepEqual(planDatabaseMigration(db, owner).steps, []);
});

test('installed daemon schedules migrated periodic rows once without replaying the delivered occurrence', t => {
  t.mock.timers.enable({ apis: ['Date'], now: timestamp * 1000 });
  const db = legacy(t, 'scheduler-v0.9.0-v1.sql');
  addTasks(db); migrateDatabase(db, owner);
  const before = db.prepare('SELECT * FROM task_history ORDER BY id').all();
  // Resumption can be later than migration; the interval starts from this pass.
  t.mock.timers.tick(5000);
  processCompletedTasks(db);
  const cron = db.prepare("SELECT * FROM tasks WHERE id='legacy-cron'").get();
  const interval = db.prepare("SELECT * FROM tasks WHERE id='legacy-interval'").get();
  assert.equal(cron.status, 'pending');
  assert.equal(cron.next_run_at, Date.parse('2030-01-01T01:00:00Z') / 1000);
  assert.equal(cron.timezone, 'Asia/Shanghai');
  assert.equal(interval.status, 'pending');
  assert.equal(interval.next_run_at, timestamp + 5 + 1800);
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id='legacy-once'").get().status, 'completed');
  assert.deepEqual(db.prepare('SELECT * FROM task_history ORDER BY id').all(), before);
  const scheduled = snapshot(db);
  t.mock.timers.tick(5000); processCompletedTasks(db);
  assert.deepEqual(snapshot(db), scheduled);
});

test('delivery row conversion and schema version roll back together on migration failure', t => {
  t.mock.timers.enable({ apis: ['Date'], now: timestamp * 1000 });
  const db = legacy(t, 'scheduler-v0.9.0-v1.sql');
  owner.MIGRATIONS[1].migrate(db); db.pragma('user_version = 2');
  addTasks(db);
  const before = snapshot(db);
  const failing = { ...owner, MIGRATIONS: { ...owner.MIGRATIONS, 2: {
    ...owner.MIGRATIONS[2], migrate(connection) { migrateToV3(connection); throw new Error('after delivery conversion'); },
  } } };
  assert.throws(() => migrateDatabase(db, failing), /after delivery conversion/);
  assert.deepEqual(snapshot(db), before);
});
