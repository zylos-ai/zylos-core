import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { updateNextRunTime, processCompletedTasks, settleStaleDeliveries } from '../daemon-tasks.js';
import { now } from '../database.js';

async function withDb(fn) {
  const originalZylosDir = process.env.ZYLOS_DIR;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-daemon-'));
  try {
    process.env.ZYLOS_DIR = tmpDir;
    const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { getDb } = await import(new URL(`../database.js?${cacheBuster}`, import.meta.url));
    const db = getDb();
    try {
      await fn(db);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalZylosDir === undefined) {
      delete process.env.ZYLOS_DIR;
    } else {
      process.env.ZYLOS_DIR = originalZylosDir;
    }
  }
}

function insertTask(db, overrides = {}) {
  const currentTime = now();
  const defaults = {
    id: `task-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: 'test task',
    prompt: 'test prompt',
    type: 'recurring',
    cron_expression: '0 9 * * *',
    interval_seconds: null,
    timezone: 'UTC',
    next_run_at: currentTime + 3600,
    priority: 3,
    status: 'pending',
    require_idle: 0,
    miss_threshold: 300,
    reply_channel: null,
    reply_endpoint: null,
    created_at: currentTime,
    updated_at: currentTime,
    last_error: null,
  };
  const task = { ...defaults, ...overrides };
  db.prepare(`
    INSERT INTO tasks (id, name, prompt, type, cron_expression, interval_seconds, timezone,
      next_run_at, priority, status, require_idle, miss_threshold,
      reply_channel, reply_endpoint, created_at, updated_at, last_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id, task.name, task.prompt, task.type, task.cron_expression, task.interval_seconds,
    task.timezone, task.next_run_at, task.priority, task.status, task.require_idle,
    task.miss_threshold, task.reply_channel, task.reply_endpoint,
    task.created_at, task.updated_at, task.last_error
  );
  return task;
}

// ---- updateNextRunTime ----

describe('updateNextRunTime', () => {
  it('schedules next cron run for recurring task', async () => {
    await withDb((db) => {
      const task = insertTask(db, { type: 'recurring', cron_expression: '0 9 * * *', timezone: 'UTC', status: 'completed' });
      updateNextRunTime(db, task);

      const updated = db.prepare('SELECT status, next_run_at FROM tasks WHERE id = ?').get(task.id);
      assert.equal(updated.status, 'pending');
      assert.ok(updated.next_run_at > now(), 'next_run_at should be in the future');
    });
  });

  it('schedules next interval run for interval task', async () => {
    await withDb((db) => {
      const task = insertTask(db, { type: 'interval', cron_expression: null, interval_seconds: 7200, status: 'completed' });
      updateNextRunTime(db, task);

      const updated = db.prepare('SELECT status, next_run_at FROM tasks WHERE id = ?').get(task.id);
      assert.equal(updated.status, 'pending');
      const expectedMin = now() + 7200 - 2;
      const expectedMax = now() + 7200 + 2;
      assert.ok(updated.next_run_at >= expectedMin && updated.next_run_at <= expectedMax,
        `expected next_run_at ~${now() + 7200}, got ${updated.next_run_at}`);
    });
  });

  it('does nothing for one-time task', async () => {
    await withDb((db) => {
      const originalNextRun = now() + 1000;
      const task = insertTask(db, { type: 'one-time', cron_expression: null, next_run_at: originalNextRun, status: 'completed' });
      updateNextRunTime(db, task);

      const updated = db.prepare('SELECT status, next_run_at FROM tasks WHERE id = ?').get(task.id);
      // Should remain unchanged
      assert.equal(updated.status, 'completed');
      assert.equal(updated.next_run_at, originalNextRun);
    });
  });

  it('uses task timezone for cron calculation', async (t) => {
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      // Pin the clock: which daily 09:00 comes next depends on the current time.
      const cases = [
        // 05:00 UTC = 13:00 Shanghai: today's Shanghai 09:00 has passed, UTC 09:00 has not.
        { at: '2026-01-15T05:00:00Z', utc: '2026-01-15T09:00:00Z', shanghai: '2026-01-16T01:00:00Z' },
        // 20:00 UTC = 04:00 Shanghai next day: both 09:00s are still ahead.
        { at: '2026-01-15T20:00:00Z', utc: '2026-01-16T09:00:00Z', shanghai: '2026-01-16T01:00:00Z' },
      ];
      for (const c of cases) {
        t.mock.timers.enable({ apis: ['Date'], now: Date.parse(c.at) });
        try {
          await withDb((db) => {
            const task1 = insertTask(db, { id: 'task-utc', type: 'recurring', cron_expression: '0 9 * * *', timezone: 'UTC', status: 'completed' });
            const task2 = insertTask(db, { id: 'task-sh', type: 'recurring', cron_expression: '0 9 * * *', timezone: 'Asia/Shanghai', status: 'completed' });

            updateNextRunTime(db, task1);
            updateNextRunTime(db, task2);

            const utcRow = db.prepare('SELECT next_run_at FROM tasks WHERE id = ?').get('task-utc');
            const shRow = db.prepare('SELECT next_run_at FROM tasks WHERE id = ?').get('task-sh');

            assert.equal(utcRow.next_run_at, Date.parse(c.utc) / 1000, `UTC 09:00 after ${c.at}`);
            assert.equal(shRow.next_run_at, Date.parse(c.shanghai) / 1000, `Shanghai 09:00 after ${c.at}`);
          });
        } finally {
          t.mock.timers.reset();
        }
      }
    } finally {
      if (originalTz === undefined) { delete process.env.TZ; } else { process.env.TZ = originalTz; }
    }
  });
});

// ---- processCompletedTasks ----

describe('processCompletedTasks', () => {
  it('reschedules completed recurring task', async () => {
    await withDb((db) => {
      insertTask(db, { type: 'recurring', cron_expression: '0 9 * * *', status: 'completed' });
      processCompletedTasks(db);

      const task = db.prepare('SELECT status FROM tasks LIMIT 1').get();
      assert.equal(task.status, 'pending');
    });
  });

  it('reschedules completed interval task', async () => {
    await withDb((db) => {
      insertTask(db, { type: 'interval', cron_expression: null, interval_seconds: 3600, status: 'completed' });
      processCompletedTasks(db);

      const task = db.prepare('SELECT status, next_run_at FROM tasks LIMIT 1').get();
      assert.equal(task.status, 'pending');
      assert.ok(task.next_run_at > now());
    });
  });

  it('leaves completed one-time task unchanged', async () => {
    await withDb((db) => {
      insertTask(db, { type: 'one-time', cron_expression: null, status: 'completed' });
      processCompletedTasks(db);

      const task = db.prepare('SELECT status FROM tasks LIMIT 1').get();
      assert.equal(task.status, 'completed');
    });
  });

  it('marks task as failed if rescheduling throws', async () => {
    await withDb((db) => {
      insertTask(db, { type: 'recurring', cron_expression: 'invalid cron expr', status: 'completed' });
      processCompletedTasks(db);

      const task = db.prepare('SELECT status, last_error FROM tasks LIMIT 1').get();
      assert.equal(task.status, 'failed');
      assert.ok(task.last_error.includes('Invalid cron'));
    });
  });

  it('handles multiple completed tasks', async () => {
    await withDb((db) => {
      insertTask(db, { id: 'task-a', type: 'recurring', cron_expression: '0 9 * * *', status: 'completed' });
      insertTask(db, { id: 'task-b', type: 'one-time', cron_expression: null, status: 'completed' });
      insertTask(db, { id: 'task-c', type: 'interval', cron_expression: null, interval_seconds: 1800, status: 'completed' });

      processCompletedTasks(db);

      const a = db.prepare('SELECT status FROM tasks WHERE id = ?').get('task-a');
      const b = db.prepare('SELECT status FROM tasks WHERE id = ?').get('task-b');
      const c = db.prepare('SELECT status FROM tasks WHERE id = ?').get('task-c');

      assert.equal(a.status, 'pending');
      assert.equal(b.status, 'completed');  // one-time stays completed
      assert.equal(c.status, 'pending');
    });
  });
});

// Actual recovery/SQLite boundary. Run for interrupted delivery handling changes;
// unrelated UI changes may skip. The official runner isolates all instance paths,
// withDb creates a private scheduler DB and closes/removes it in finally. There
// is no sender, external network, PM2 or tmux; recovery cannot send a notification.
describe('settleStaleDeliveries', () => {
  for (const type of ['one-time', 'recurring', 'interval']) for (const started of [true, false]) {
    it(`${type} abandoned claim ${started ? 'with' : 'without'} started history respects the exact receipt limit`, async t => {
      const initial = Date.parse('2030-01-01T00:00:00Z');
      t.mock.timers.enable({ apis: ['Date'], now: initial });
      await withDb(db => {
        const task = insertTask(db, { type, status: 'running', updated_at: initial / 1000,
          cron_expression: type === 'recurring' ? '*/30 * * * *' : null,
          interval_seconds: type === 'interval' ? 1800 : null, timezone: 'UTC' });
        db.prepare("INSERT INTO task_history(task_id,executed_at,completed_at,status,error,duration_ms) VALUES(?,1,2,'failed','OLD_FAILURE',1000)").run(task.id);
        let historyId;
        if (started) {
          // Only the latest started occurrence belongs to this claim.
          db.prepare("INSERT INTO task_history(task_id,executed_at,status,error) VALUES(?,?,'started','OLDER_UNFINISHED')").run(task.id, initial / 1000 - 500);
          historyId = Number(db.prepare("INSERT INTO task_history(task_id,executed_at,status,error) VALUES(?,?,'started','RECEIVE_RESULT_UNKNOWN')").run(task.id, initial / 1000).lastInsertRowid);
        }
        const read = () => ({ task: db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id),
          history: db.prepare('SELECT * FROM task_history WHERE task_id=? ORDER BY id').all(task.id) });
        const before = read();
        for (const age of [179, 180]) {
          t.mock.timers.setTime(initial + age * 1000); settleStaleDeliveries(db);
          assert.deepEqual(read(), before);
        }
        if (started) {
          // An unrelated task update must not extend the receipt's age.
          db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(initial / 1000 + 170, task.id);
        }
        t.mock.timers.setTime(initial + 181000); settleStaleDeliveries(db);
        const after = read();
        assert.equal(after.task.status, type === 'one-time' ? 'failed' : 'pending');
        assert.equal(after.task.last_error, 'DELIVERY_RESULT_UNKNOWN');
        assert.equal(after.task.failed_at, type === 'one-time' ? initial / 1000 + 181 : null);
        assert.equal(after.task.updated_at, initial / 1000 + 181);
        if (type !== 'one-time') assert.equal(after.task.next_run_at,
          initial / 1000 + (type === 'recurring' ? 1800 : 1981));
        assert.deepEqual(after.history.slice(0, started ? -1 : undefined), before.history.slice(0, started ? -1 : undefined));
        if (started) {
          const latest = after.history.at(-1);
          assert.equal(latest.id, historyId); assert.equal(latest.status, 'failed');
          assert.equal(latest.error, 'DELIVERY_RESULT_UNKNOWN');
          assert.equal(latest.completed_at, initial / 1000 + 181); assert.equal(latest.duration_ms, 181000);
        }
        settleStaleDeliveries(db); assert.deepEqual(read(), after);
      });
    });
  }

  for (const winner of ['completed delivery', 'new claim', 'refreshed task']) {
    it(`stale enumeration cannot overwrite a concurrent ${winner}`, async t => {
      const current = Date.parse('2030-01-01T01:00:00Z');
      t.mock.timers.enable({ apis: ['Date'], now: current });
      await withDb(db => {
        const old = current / 1000 - 181;
        const task = insertTask(db, { type: 'one-time', status: 'running', updated_at: old, cron_expression: null });
        const historyId = Number(db.prepare("INSERT INTO task_history(task_id,executed_at,status) VALUES(?,?,'started')").run(task.id, old).lastInsertRowid);
        const prepare = db.prepare.bind(db); let raced = false;
        const read = () => ({ task: prepare('SELECT * FROM tasks WHERE id=?').get(task.id),
          history: prepare('SELECT * FROM task_history WHERE task_id=? ORDER BY id').all(task.id) });
        let concurrent;
        t.mock.method(db, 'prepare', sql => {
          const statement = prepare(sql);
          if (sql.includes('COALESCE(h.executed_at,t.updated_at)')) {
            const all = statement.all.bind(statement);
            t.mock.method(statement, 'all', (...args) => {
              const rows = all(...args); assert.equal(rows.length, 1);
              db.transaction(() => {
                if (winner !== 'refreshed task') {
                  prepare("UPDATE task_history SET status='success',completed_at=?,duration_ms=? WHERE id=?").run(current / 1000, 181000, historyId);
                }
                // Keep the old timestamp for replacement/closed rows to exercise
                // status and exact-history guards independently of updated_at.
                prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run(
                  winner === 'completed delivery' ? 'completed' : 'running',
                  winner === 'refreshed task' ? current / 1000 : old, task.id);
                if (winner === 'new claim') prepare("INSERT INTO task_history(task_id,executed_at,status) VALUES(?,?,'started')").run(task.id, current / 1000);
              }).immediate();
              raced = true; concurrent = read(); return rows;
            });
          }
          return statement;
        });
        settleStaleDeliveries(db); assert.equal(raced, true); assert.deepEqual(read(), concurrent);
      });
    });
  }

  for (const type of ['one-time', 'interval']) {
    it(`${type} unknown-result accounting rolls back history and task together`, async t => {
      const current = Date.parse('2030-01-01T01:00:00Z');
      t.mock.timers.enable({ apis: ['Date'], now: current });
      await withDb(db => {
        const task = insertTask(db, { type, status: 'running', updated_at: current / 1000 - 181,
          cron_expression: null, interval_seconds: type === 'interval' ? 1800 : null });
        db.prepare("INSERT INTO task_history(task_id,executed_at,status) VALUES(?,?,'started')").run(task.id, current / 1000 - 181);
        const read = () => ({ task: db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id),
          history: db.prepare('SELECT * FROM task_history WHERE task_id=? ORDER BY id').all(task.id) });
        const before = read();
        db.exec(`CREATE TRIGGER fail_unknown_settlement BEFORE UPDATE ON tasks WHEN NEW.status='${type === 'one-time' ? 'failed' : 'pending'}' BEGIN SELECT RAISE(ABORT,'settlement fail'); END`);
        assert.throws(() => settleStaleDeliveries(db), /settlement fail/);
        assert.deepEqual(read(), before);
      });
    });
  }
});
