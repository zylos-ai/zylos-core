/**
 * Atomic lifecycle changes for individual scheduler runs.
 */

import { now } from './database.js';

/**
 * Claim one pending task and create the immutable identity for that run.
 *
 * Returns the claimed task and history row ID, or null when the task is no
 * longer dispatchable.
 */
export function startTaskRun(db, { taskId, startedAt = now() }) {
  const startRun = db.transaction(() => {
    const claimedTask = db.prepare(`
      UPDATE tasks
      SET status = 'running', updated_at = ?
      WHERE id = ? AND status = 'pending'
        AND next_run_at <= ?
        AND next_run_at + COALESCE(miss_threshold, 300) >= ?
      RETURNING *
    `).get(startedAt, taskId, startedAt, startedAt);

    if (!claimedTask) return null;

    const history = db.prepare(`
      INSERT INTO task_history (task_id, executed_at, status)
      VALUES (?, ?, 'started')
    `).safeIntegers(true).run(taskId, startedAt);

    const runId = Number(history.lastInsertRowid);
    if (!Number.isSafeInteger(runId) || runId <= 0) {
      throw new Error('Scheduler run ID exceeds the supported safe-integer range');
    }

    return { runId, task: claimedTask };
  });

  return startRun();
}

/**
 * Record a timeout for the exact latest active run.
 *
 * Returns false without mutation when either the run identity or stale-task
 * compare-and-set no longer matches.
 */
export function timeoutTaskRun(db, { taskId, runId, staleBefore, timedOutAt = now() }) {
  if (!Number.isSafeInteger(runId) || runId <= 0) return false;

  const timeoutRun = db.transaction(() => {
    const active = db.prepare(`
      SELECT type FROM tasks
      WHERE id = ? AND status = 'running' AND updated_at < ?
        AND ? = (
          SELECT id FROM task_history
          WHERE task_id = ? AND status = 'started'
          ORDER BY id DESC LIMIT 1
        )
    `).get(taskId, staleBefore, runId, taskId);

    if (!active) return false;

    const nextStatus = active.type === 'one-time' ? 'failed' : 'completed';
    const taskUpdate = db.prepare(`
      UPDATE tasks
      SET status = ?, failed_at = ?, last_error = 'Task timed out', updated_at = ?
      WHERE id = ? AND status = 'running' AND updated_at < ?
        AND ? = (
          SELECT id FROM task_history
          WHERE task_id = ? AND status = 'started'
          ORDER BY id DESC LIMIT 1
        )
    `).run(
      nextStatus, timedOutAt, timedOutAt, taskId, staleBefore,
      runId, taskId
    );

    if (taskUpdate.changes !== 1) return false;

    const historyUpdate = db.prepare(`
      UPDATE task_history
      SET status = 'timeout', completed_at = ?, error = 'Task timed out'
      WHERE id = ? AND task_id = ? AND status = 'started'
    `).run(timedOutAt, runId, taskId);

    if (historyUpdate.changes !== 1) {
      throw new Error(`Run ${runId} changed during timeout handling`);
    }

    return true;
  });

  return timeoutRun();
}

/**
 * Complete one exact active run.
 *
 * Returns false without mutation when the task/run pair is no longer active.
 */
export function completeTaskRun(db, { taskId, runId, completedAt = now() }) {
  const completeRun = db.transaction(() => {
    const historyEntry = db.prepare(`
      SELECT executed_at FROM task_history
      WHERE id = ? AND task_id = ? AND status = 'started'
        AND id = (
          SELECT id FROM task_history
          WHERE task_id = ? AND status = 'started'
          ORDER BY id DESC LIMIT 1
        )
    `).get(runId, taskId, taskId);

    if (!historyEntry) return false;

    const taskUpdate = db.prepare(`
      UPDATE tasks
      SET status = 'completed', last_run_at = ?, updated_at = ?,
          failed_at = NULL, last_error = NULL
      WHERE id = ? AND status = 'running'
        AND EXISTS (
          SELECT 1 FROM task_history
          WHERE id = ? AND task_id = ? AND status = 'started'
        )
        AND ? = (
          SELECT id FROM task_history
          WHERE task_id = ? AND status = 'started'
          ORDER BY id DESC LIMIT 1
        )
    `).run(completedAt, completedAt, taskId, runId, taskId, runId, taskId);

    if (taskUpdate.changes !== 1) return false;

    const durationMs = Math.max(0, completedAt - historyEntry.executed_at) * 1000;
    const historyUpdate = db.prepare(`
      UPDATE task_history
      SET status = 'success', completed_at = ?, duration_ms = ?
      WHERE id = ? AND task_id = ? AND status = 'started'
    `).run(completedAt, durationMs, runId, taskId);

    if (historyUpdate.changes !== 1) {
      throw new Error(`Run ${runId} changed during completion`);
    }

    return true;
  });

  return completeRun();
}
