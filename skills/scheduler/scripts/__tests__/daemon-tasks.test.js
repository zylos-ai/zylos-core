import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { updateNextRunTime, settleStaleDeliveries } from '../daemon-tasks.js';
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

// Actual recovery/SQLite boundary. Run for interrupted delivery handling changes;
// unrelated UI changes may skip. The official runner isolates all instance paths,
// withDb creates a private scheduler DB and closes/removes it in finally. There
// is no sender, external network, PM2 or tmux; recovery cannot send a notification.
describe('settleStaleDeliveries', () => {

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

});
