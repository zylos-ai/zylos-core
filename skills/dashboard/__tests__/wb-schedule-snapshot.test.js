import test from 'node:test';
import assert from 'node:assert/strict';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { scheduleEnv } from './fixtures/schedule-env.js';

// Integration: the real schedule reader and SQLite WAL database, with a second
// real connection committing between SELECTs. The driver wrapper only observes
// SQL through better-sqlite3's verbose callback; it never changes SQL or results.
// Run for changes to schedule snapshot/query boundaries; skip rendering-only
// edits. scheduleEnv asserts/prints isolated HOME, ZYLOS_DIR, PM2_HOME, short
// TMPDIR, private tmux directory and database paths before creating the schema.
// No PM2, tmux, network or live installation access. All connections and fixture
// directories are removed by teardown, including failed reads.
const NOW = 1800000000;
let importCase = 0;

async function fixture(t) {
  const f = scheduleEnv(t);
  f.agent(['list']);
  const writer = f.open();
  assert.equal(writer.pragma('journal_mode = WAL', { simple: true }), 'wal');
  const insert = writer.prepare(`INSERT INTO tasks
    (id, name, prompt, type, status, next_run_at, created_at, updated_at)
    VALUES (?, ?, ?, 'one-time', ?, ?, ?, ?)`);
  const task = (id, status = 'pending') => insert.run(id, id, `Prompt ${id}`, status, NOW + 60, NOW, NOW);
  let beforeQuery = null;
  t.mock.module('../../comm-bridge/scripts/sqlite-driver.js', {
    defaultExport: function ObservedDatabase(file, options) {
      assert.equal(file, f.dbPath);
      assert.equal(options.readonly, true);
      return new Database(file, { ...options, verbose: sql => beforeQuery?.(sql) });
    },
  });
  const { createScheduleRead } = await import(`../src/lib/workbench/schedule-read.js?snapshot=${++importCase}`);
  const reader = createScheduleRead({ zylosDir: f.zylosDir, now: () => NOW * 1000, scheduleTz: async () => ({ tz: 'UTC' }) });
  return { ...f, writer, task, reader, onQuery: fn => { beforeQuery = fn; } };
}

test('a completion between list SELECTs cannot split counts, rows and timeline across snapshots', async t => {
  const f = await fixture(t);
  f.task('finishing');
  f.task('previous', 'completed');
  let writes = 0;
  f.onQuery(sql => {
    if (!sql.startsWith('SELECT status, count(*)')) return;
    f.onQuery(null);
    f.writer.prepare("UPDATE tasks SET status = 'completed', updated_at = ? WHERE id = 'finishing'").run(NOW + 1);
    writes++;
  });
  const page = await f.reader.read(undefined, { status: 'completed' });
  assert.equal(writes, 1);
  assert.equal(page.counts.enabled, 1);
  assert.equal(page.counts.completed, 1);
  assert.equal(page.tasks.length, 1);
  assert.equal(page.tasks[0].id, 'previous');
  assert.equal(page.tasks[0].status, 'completed');
  assert.equal(page.timelineTasks.length, 1);
  assert.equal(page.timelineTasks[0].id, 'finishing');
  assert.equal(page.timelineTasks[0].status, 'pending');
  assert.equal(page.kpi.enabled, 1);
  const next = await f.reader.read(undefined, { status: 'completed' });
  assert.equal(next.counts.enabled, 0);
  assert.equal(next.counts.completed, 2);
  assert.equal(next.tasks.length, 2);
  assert.ok(next.tasks.every(task => task.status === 'completed'));
  assert.equal(next.timelineTasks.length, 0);
});

test('task detail and its recent history share one snapshot during a concurrent completion', async t => {
  const f = await fixture(t);
  f.task('finishing');
  let writes = 0;
  f.onQuery(sql => {
    if (!sql.includes('FROM task_history')) return;
    f.onQuery(null);
    f.writer.transaction(() => {
      f.writer.prepare("UPDATE tasks SET status = 'completed', prompt = 'New prompt' WHERE id = 'finishing'").run();
      f.writer.prepare("INSERT INTO task_history (task_id, executed_at, completed_at, status) VALUES ('finishing', ?, ?, 'success')").run(NOW, NOW + 1);
    })();
    writes++;
  });
  const old = (await f.reader.detail('finishing')).task;
  assert.equal(writes, 1);
  assert.equal(old.status, 'pending');
  assert.equal(old.prompt, 'Prompt finishing');
  assert.equal(old.recent.length, 0);
  const current = (await f.reader.detail('finishing')).task;
  assert.equal(current.status, 'completed');
  assert.equal(current.prompt, 'New prompt');
  assert.equal(current.recent.length, 1);
  assert.equal(current.recent[0].status, 'success');
});

test('a failed snapshot read releases its transaction and connection', async t => {
  const f = await fixture(t);
  f.task('pending');
  f.onQuery(sql => {
    if (!sql.startsWith('SELECT status, count(*)')) return;
    f.onQuery(null);
    throw Error('read interrupted');
  });
  await assert.rejects(f.reader.read(), error => error.statusCode === 503 && error.code === 'scheduler_unreadable');
  const checkpoint = f.writer.pragma('wal_checkpoint(TRUNCATE)');
  assert.equal(checkpoint[0].busy, 0);
  f.writer.prepare("UPDATE tasks SET status = 'completed' WHERE id = 'pending'").run();
  const page = await f.reader.read(undefined, { status: 'completed' });
  assert.equal(page.counts.completed, 1);
  assert.equal(page.tasks[0].status, 'completed');
});
