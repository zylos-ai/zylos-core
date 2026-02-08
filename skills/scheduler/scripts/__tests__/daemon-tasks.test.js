import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { updateNextRunTime, processCompletedTasks, handleStaleRunningTasks, TASK_TIMEOUT } from '../daemon-tasks.js';
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

  it('uses task timezone for cron calculation', async () => {
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      await withDb((db) => {
        const task1 = insertTask(db, { id: 'task-utc', type: 'recurring', cron_expression: '0 9 * * *', timezone: 'UTC', status: 'completed' });
        const task2 = insertTask(db, { id: 'task-sh', type: 'recurring', cron_expression: '0 9 * * *', timezone: 'Asia/Shanghai', status: 'completed' });

        updateNextRunTime(db, task1);
        updateNextRunTime(db, task2);

        const utcRow = db.prepare('SELECT next_run_at FROM tasks WHERE id = ?').get('task-utc');
        const shRow = db.prepare('SELECT next_run_at FROM tasks WHERE id = ?').get('task-sh');

        // Shanghai 9am is 8 hours earlier in UTC than UTC 9am
        assert.ok(shRow.next_run_at < utcRow.next_run_at,
          `Shanghai 9am (${shRow.next_run_at}) should be before UTC 9am (${utcRow.next_run_at})`);
      });
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

// ---- handleStaleRunningTasks ----

describe('handleStaleRunningTasks', () => {
  it('marks stale one-time task as failed', async () => {
    await withDb((db) => {
      const staleTime = now() - TASK_TIMEOUT - 60;
      insertTask(db, { type: 'one-time', cron_expression: null, status: 'running', updated_at: staleTime });

      // Insert a history entry
      const task = db.prepare('SELECT id FROM tasks LIMIT 1').get();
      db.prepare('INSERT INTO task_history (task_id, executed_at, status) VALUES (?, ?, ?)')
        .run(task.id, staleTime, 'started');

      handleStaleRunningTasks(db);

      const updated = db.prepare('SELECT status, last_error FROM tasks WHERE id = ?').get(task.id);
      assert.equal(updated.status, 'failed');
      assert.equal(updated.last_error, 'Task timed out');

      const history = db.prepare('SELECT status FROM task_history WHERE task_id = ?').get(task.id);
      assert.equal(history.status, 'timeout');
    });
  });

  it('marks stale recurring task as completed (for rescheduling)', async () => {
    await withDb((db) => {
      const staleTime = now() - TASK_TIMEOUT - 60;
      insertTask(db, { type: 'recurring', cron_expression: '0 9 * * *', status: 'running', updated_at: staleTime });

      const task = db.prepare('SELECT id FROM tasks LIMIT 1').get();
      db.prepare('INSERT INTO task_history (task_id, executed_at, status) VALUES (?, ?, ?)')
        .run(task.id, staleTime, 'started');

      handleStaleRunningTasks(db);

      const updated = db.prepare('SELECT status, last_error FROM tasks WHERE id = ?').get(task.id);
      assert.equal(updated.status, 'completed');
      assert.equal(updated.last_error, 'Task timed out');
    });
  });

  it('ignores recently updated running tasks', async () => {
    await withDb((db) => {
      insertTask(db, { type: 'one-time', cron_expression: null, status: 'running', updated_at: now() });

      handleStaleRunningTasks(db);

      const task = db.prepare('SELECT status FROM tasks LIMIT 1').get();
      assert.equal(task.status, 'running');  // should not be touched
    });
  });

  it('ignores non-running tasks', async () => {
    await withDb((db) => {
      const staleTime = now() - TASK_TIMEOUT - 60;
      insertTask(db, { status: 'pending', updated_at: staleTime });

      handleStaleRunningTasks(db);

      const task = db.prepare('SELECT status FROM tasks LIMIT 1').get();
      assert.equal(task.status, 'pending');
    });
  });

  it('handles multiple stale tasks with different types', async () => {
    await withDb((db) => {
      const staleTime = now() - TASK_TIMEOUT - 60;
      insertTask(db, { id: 'task-ot', type: 'one-time', cron_expression: null, status: 'running', updated_at: staleTime });
      insertTask(db, { id: 'task-rc', type: 'recurring', cron_expression: '0 9 * * *', status: 'running', updated_at: staleTime });
      insertTask(db, { id: 'task-iv', type: 'interval', cron_expression: null, interval_seconds: 3600, status: 'running', updated_at: staleTime });

      handleStaleRunningTasks(db);

      const ot = db.prepare('SELECT status FROM tasks WHERE id = ?').get('task-ot');
      const rc = db.prepare('SELECT status FROM tasks WHERE id = ?').get('task-rc');
      const iv = db.prepare('SELECT status FROM tasks WHERE id = ?').get('task-iv');

      assert.equal(ot.status, 'failed');     // one-time → failed
      assert.equal(rc.status, 'completed');  // recurring → completed (will be rescheduled)
      assert.equal(iv.status, 'completed');  // interval → completed (will be rescheduled)
    });
  });
});
