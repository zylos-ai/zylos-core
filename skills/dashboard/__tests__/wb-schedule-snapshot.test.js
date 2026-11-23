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
  const { createScheduleRead, scheduleListQuery } = await import(`../src/lib/workbench/schedule-read.js?snapshot=${++importCase}`);
  const reader = createScheduleRead({ zylosDir: f.zylosDir, now: () => NOW * 1000, scheduleTz: async () => ({ tz: 'UTC' }) });
  const query = params => scheduleListQuery(new URLSearchParams(params));
  return { ...f, writer, task, reader, query, onQuery: fn => { beforeQuery = fn; } };
}

test('a failed snapshot read releases its transaction and connection', async t => {
  const f = await fixture(t);
  f.task('pending');
  f.onQuery(sql => {
    if (!sql.startsWith('SELECT status, count(*)')) return;
    f.onQuery(null);
    throw Error('read interrupted');
  });
  await assert.rejects(f.reader.read(), error => error.statusCode === 503 && error.code === 'unavailable');
  const checkpoint = f.writer.pragma('wal_checkpoint(TRUNCATE)');
  assert.equal(checkpoint[0].busy, 0);
  f.writer.prepare("UPDATE tasks SET status = 'completed' WHERE id = 'pending'").run();
  const page = await f.reader.read(undefined, f.query({ status: 'completed' }));
  assert.equal(page.counts.completed, 1);
  assert.equal(page.items[0].status, 'completed');
});
