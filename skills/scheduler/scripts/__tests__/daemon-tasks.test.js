import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  failMissedOneTimeTask,
  updateNextRunTime,
  processCompletedTasks,
  handleStaleRunningTasks,
  TASK_TIMEOUT
} from '../daemon-tasks.js';
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

        const wallClock = (timestamp, timeZone) => {
          const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
          }).formatToParts(new Date(timestamp * 1000));
          const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
          return `${value.hour}:${value.minute}`;
        };

        assert.equal(wallClock(utcRow.next_run_at, 'UTC'), '09:00');
        assert.equal(wallClock(shRow.next_run_at, 'Asia/Shanghai'), '09:00');
        assert.ok(utcRow.next_run_at > now());
        assert.ok(shRow.next_run_at > now());
      });
    } finally {
      if (originalTz === undefined) { delete process.env.TZ; } else { process.env.TZ = originalTz; }
    }
  });

  it('uses the current schedule when a completed task was edited after selection', async () => {
    await withDb((db) => {
      insertTask(db, {
        id: 'task-edited',
        type: 'recurring',
        cron_expression: '0 9 * * *',
        timezone: 'UTC',
        status: 'completed'
      });
      const staleTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-edited');
      db.prepare(`
        UPDATE tasks SET cron_expression = '0 10 * * *', updated_at = updated_at + 1
        WHERE id = ?
      `).run('task-edited');

      updateNextRunTime(db, staleTask);

      const updated = db.prepare('SELECT status, cron_expression, next_run_at FROM tasks WHERE id = ?')
        .get('task-edited');
      const utcHour = new Date(updated.next_run_at * 1000).getUTCHours();
      assert.equal(updated.status, 'pending');
      assert.equal(updated.cron_expression, '0 10 * * *');
      assert.equal(utcHour, 10);
    });
  });

  it('does not advance a pending task that is no longer overdue', async () => {
    await withDb((db) => {
      const futureRun = now() + 7200;
      const staleTask = insertTask(db, {
        id: 'task-no-longer-overdue',
        type: 'interval',
        cron_expression: null,
        interval_seconds: 3600,
        next_run_at: futureRun,
        status: 'pending'
      });

      assert.equal(updateNextRunTime(db, staleTask), false);
      assert.deepEqual(
        db.prepare('SELECT status, next_run_at FROM tasks WHERE id = ?').get(staleTask.id),
        { status: 'pending', next_run_at: futureRun }
      );
    });
  });

  it('advances the same overdue pending task only once', async () => {
    await withDb((db) => {
      const currentTime = now();
      const staleTask = insertTask(db, {
        id: 'task-repeated-missed-run',
        type: 'interval',
        cron_expression: null,
        interval_seconds: 3600,
        next_run_at: currentTime - 600,
        status: 'pending'
      });

      assert.equal(updateNextRunTime(db, staleTask), true);
      const firstTransition = db.prepare('SELECT status, next_run_at FROM tasks WHERE id = ?')
        .get(staleTask.id);

      assert.equal(updateNextRunTime(db, staleTask), false);
      assert.deepEqual(
        db.prepare('SELECT status, next_run_at FROM tasks WHERE id = ?').get(staleTask.id),
        firstTransition
      );
    });
  });
});

describe('failMissedOneTimeTask', () => {
  it('does not fail a one-time task that was postponed after selection', async () => {
    await withDb((db) => {
      const currentTime = now();
      const task = insertTask(db, {
        type: 'one-time',
        cron_expression: null,
        next_run_at: currentTime - 600,
        status: 'pending'
      });
      db.prepare('UPDATE tasks SET next_run_at = ?, updated_at = ? WHERE id = ?')
        .run(currentTime + 3600, currentTime, task.id);

      assert.equal(failMissedOneTimeTask(db, { taskId: task.id, currentTime }), false);
      assert.deepEqual(
        db.prepare('SELECT status, failed_at, last_error FROM tasks WHERE id = ?').get(task.id),
        { status: 'pending', failed_at: null, last_error: null }
      );
    });
  });

  it('fails only a currently overdue one-time task', async () => {
    await withDb((db) => {
      const currentTime = now();
      const task = insertTask(db, {
        type: 'one-time',
        cron_expression: null,
        next_run_at: currentTime - 1,
        miss_threshold: 0,
        status: 'pending'
      });

      assert.equal(failMissedOneTimeTask(db, { taskId: task.id, currentTime }), true);
      assert.deepEqual(
        db.prepare('SELECT status, failed_at, last_error FROM tasks WHERE id = ?').get(task.id),
        { status: 'failed', failed_at: currentTime, last_error: 'Missed execution window' }
      );
    });
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

      const task = db.prepare('SELECT status, last_error, failed_at FROM tasks LIMIT 1').get();
      assert.equal(task.status, 'failed');
      assert.ok(task.last_error.includes('Invalid cron'));
      assert.ok(Number.isSafeInteger(task.failed_at));
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
  it('leaves a stale task unchanged when its run identity is missing', async () => {
    await withDb((db) => {
      const staleTime = now() - TASK_TIMEOUT - 60;
      insertTask(db, { type: 'one-time', cron_expression: null, status: 'running', updated_at: staleTime });

      handleStaleRunningTasks(db);

      assert.deepEqual(
        db.prepare('SELECT status, failed_at, last_error FROM tasks LIMIT 1').get(),
        { status: 'running', failed_at: null, last_error: null }
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_history').get().count, 0);
    });
  });

  it('marks stale one-time task as failed', async () => {
    await withDb((db) => {
      const staleTime = now() - TASK_TIMEOUT - 60;
      insertTask(db, { type: 'one-time', cron_expression: null, status: 'running', updated_at: staleTime });

      // Insert a history entry
      const task = db.prepare('SELECT id FROM tasks LIMIT 1').get();
      db.prepare('INSERT INTO task_history (task_id, executed_at, status) VALUES (?, ?, ?)')
        .run(task.id, staleTime, 'started');

      handleStaleRunningTasks(db);

      const updated = db.prepare('SELECT status, last_error, failed_at FROM tasks WHERE id = ?').get(task.id);
      assert.equal(updated.status, 'failed');
      assert.equal(updated.last_error, 'Task timed out');
      assert.ok(updated.failed_at >= staleTime);

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

      const updated = db.prepare('SELECT status, last_error, failed_at FROM tasks WHERE id = ?').get(task.id);
      assert.equal(updated.status, 'completed');
      assert.equal(updated.last_error, 'Task timed out');
      assert.ok(updated.failed_at >= staleTime, 'timeout must remain machine-visible while the task is retryable');
      assert.equal(db.prepare('SELECT status FROM task_history WHERE task_id = ?').get(task.id).status, 'timeout');

      processCompletedTasks(db);
      const rescheduled = db.prepare(`
        SELECT status, failed_at, last_error, next_run_at FROM tasks WHERE id = ?
      `).get(task.id);
      assert.equal(rescheduled.status, 'pending');
      assert.equal(rescheduled.failed_at, updated.failed_at);
      assert.equal(rescheduled.last_error, 'Task timed out');
      assert.ok(rescheduled.next_run_at > now());
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
      for (const taskId of ['task-ot', 'task-rc', 'task-iv']) {
        db.prepare(`
          INSERT INTO task_history (task_id, executed_at, status)
          VALUES (?, ?, 'started')
        `).run(taskId, staleTime);
      }

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
