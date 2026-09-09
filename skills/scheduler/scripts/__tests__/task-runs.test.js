import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { completeTaskRun, startTaskRun, timeoutTaskRun } from '../task-runs.js';

async function withDb(fn) {
  const originalZylosDir = process.env.ZYLOS_DIR;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-runs-'));
  try {
    process.env.ZYLOS_DIR = tmpDir;
    const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { getDb, now } = await import(new URL(`../database.js?${cacheBuster}`, import.meta.url));
    const db = getDb();
    try {
      await fn(db, now());
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalZylosDir === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = originalZylosDir;
  }
}

function insertPendingTask(db, taskId, currentTime) {
  db.prepare(`
    INSERT INTO tasks (id, name, prompt, type, next_run_at, status, created_at, updated_at)
    VALUES (?, 'claim me', 'test prompt', 'one-time', ?, 'pending', ?, ?)
  `).run(taskId, currentTime, currentTime, currentTime);
}

describe('startTaskRun', () => {
  it('atomically claims a pending task and creates its run identity', async () => {
    await withDb((db, currentTime) => {
      insertPendingTask(db, 'task-claim', currentTime);

      const started = startTaskRun(db, { taskId: 'task-claim', startedAt: currentTime });
      const { runId, task } = started;

      assert.ok(Number.isSafeInteger(runId));
      assert.equal(task.id, 'task-claim');
      assert.equal(task.status, 'running');
      assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 'task-claim'").get().status, 'running');
      assert.deepEqual(
        db.prepare('SELECT id, task_id, executed_at, status FROM task_history').get(),
        { id: runId, task_id: 'task-claim', executed_at: currentTime, status: 'started' }
      );

      assert.equal(startTaskRun(db, { taskId: 'task-claim', startedAt: currentTime + 1 }), null);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_history').get().count, 1);
    });
  });

  it('fails closed before an unsafe run ID can be dispatched', async () => {
    await withDb((db, currentTime) => {
      insertPendingTask(db, 'task-unsafe-run-id', currentTime);
      db.prepare(`
        INSERT INTO sqlite_sequence (name, seq)
        VALUES ('task_history', ?)
      `).run(Number.MAX_SAFE_INTEGER);

      assert.throws(
        () => startTaskRun(db, { taskId: 'task-unsafe-run-id', startedAt: currentTime }),
        /safe-integer range/
      );
      assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 'task-unsafe-run-id'").get().status, 'pending');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_history').get().count, 0);
    });
  });
});

describe('completeTaskRun', () => {
  it('rejects an older still-started run when a newer run is active', async () => {
    await withDb((db, currentTime) => {
      insertPendingTask(db, 'task-complete', currentTime - 10);
      db.prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = 'task-complete'")
        .run(currentTime);
      const olderRun = db.prepare(`
        INSERT INTO task_history (task_id, executed_at, status)
        VALUES ('task-complete', ?, 'started')
      `).run(currentTime - 10);
      const activeRun = db.prepare(`
        INSERT INTO task_history (task_id, executed_at, status)
        VALUES ('task-complete', ?, 'started')
      `).run(currentTime);

      assert.equal(completeTaskRun(db, {
        taskId: 'task-complete',
        runId: Number(olderRun.lastInsertRowid),
        completedAt: currentTime + 1
      }), false);
      assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 'task-complete'").get().status, 'running');
      assert.equal(db.prepare('SELECT status FROM task_history WHERE id = ?').get(olderRun.lastInsertRowid).status, 'started');
      assert.equal(db.prepare('SELECT status FROM task_history WHERE id = ?').get(activeRun.lastInsertRowid).status, 'started');
    });
  });
});

describe('timeoutTaskRun', () => {
  it('rejects a timeout without an exact active run identity', async () => {
    await withDb((db, currentTime) => {
      insertPendingTask(db, 'task-timeout-without-run', currentTime - 7200);
      db.prepare(`
        UPDATE tasks
        SET status = 'running', updated_at = ?
        WHERE id = 'task-timeout-without-run'
      `).run(currentTime - 7200);

      assert.equal(timeoutTaskRun(db, {
        taskId: 'task-timeout-without-run',
        runId: null,
        staleBefore: currentTime - 3600,
        timedOutAt: currentTime
      }), false);
      assert.deepEqual(
        db.prepare(`
          SELECT status, failed_at, last_error
          FROM tasks WHERE id = 'task-timeout-without-run'
        `).get(),
        { status: 'running', failed_at: null, last_error: null }
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_history').get().count, 0);
    });
  });

  it('times out only the latest active run and changes task outcome in the same transaction', async () => {
    await withDb((db, currentTime) => {
      insertPendingTask(db, 'task-timeout', currentTime - 7200);
      db.prepare("UPDATE tasks SET type = 'recurring', status = 'running', updated_at = ? WHERE id = 'task-timeout'")
        .run(currentTime - 7200);
      const olderRun = db.prepare(`
        INSERT INTO task_history (task_id, executed_at, status)
        VALUES ('task-timeout', ?, 'started')
      `).run(currentTime - 7200);
      const activeRun = db.prepare(`
        INSERT INTO task_history (task_id, executed_at, status)
        VALUES ('task-timeout', ?, 'started')
      `).run(currentTime - 7100);

      assert.equal(timeoutTaskRun(db, {
        taskId: 'task-timeout',
        runId: Number(olderRun.lastInsertRowid),
        staleBefore: currentTime - 3600,
        timedOutAt: currentTime
      }), false);
      assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 'task-timeout'").get().status, 'running');

      assert.equal(timeoutTaskRun(db, {
        taskId: 'task-timeout',
        runId: Number(activeRun.lastInsertRowid),
        staleBefore: currentTime - 3600,
        timedOutAt: currentTime
      }), true);
      assert.deepEqual(
        db.prepare("SELECT status, failed_at, last_error FROM tasks WHERE id = 'task-timeout'").get(),
        { status: 'completed', failed_at: currentTime, last_error: 'Task timed out' }
      );
      assert.equal(db.prepare('SELECT status FROM task_history WHERE id = ?').get(olderRun.lastInsertRowid).status, 'started');
      assert.equal(db.prepare('SELECT status FROM task_history WHERE id = ?').get(activeRun.lastInsertRowid).status, 'timeout');
    });
  });
});
