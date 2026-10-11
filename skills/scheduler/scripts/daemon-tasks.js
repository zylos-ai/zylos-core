/**
 * Daemon task processing logic
 * Extracted from daemon.js for testability
 */

import { now } from './database.js';
import { getNextRun } from './cron-utils.js';
import { formatTime } from './time-utils.js';
import { timeoutTaskRun } from './task-runs.js';

export const TASK_TIMEOUT = 3600;  // 1 hour

/**
 * Fail one currently overdue one-time task without trusting a stale daemon row.
 */
export function failMissedOneTimeTask(db, { taskId, currentTime = now() }) {
  const failure = db.prepare(`
    UPDATE tasks
    SET status = 'failed', failed_at = ?,
        last_error = 'Missed execution window', updated_at = ?
    WHERE id = ? AND status = 'pending' AND type = 'one-time'
      AND next_run_at + COALESCE(miss_threshold, 300) < ?
  `).run(currentTime, currentTime, taskId, currentTime);
  return failure.changes === 1;
}

/**
 * Update next_run_at for recurring/interval tasks after completion
 */
export function updateNextRunTime(db, task) {
  const transition = db.transaction(() => {
    const current = db.prepare(`
      SELECT * FROM tasks WHERE id = ? AND status = ?
    `).get(task.id, task.status);
    if (!current) return { kind: 'unchanged' };
    const transitionTime = now();
    if (
      current.status === 'pending' &&
      current.next_run_at + (current.miss_threshold ?? 300) >= transitionTime
    ) {
      return { kind: 'unchanged' };
    }

    let nextRun;
    try {
      if (current.type === 'recurring' && current.cron_expression) {
        nextRun = getNextRun(current.cron_expression, current.timezone);
      } else if (current.type === 'interval' && current.interval_seconds) {
        nextRun = transitionTime + current.interval_seconds;
      } else {
        return { kind: 'unchanged' }; // One-time task, no update needed
      }
    } catch (error) {
      const failedAt = transitionTime;
      const failure = db.prepare(`
        UPDATE tasks
        SET status = 'failed', last_error = ?, failed_at = ?, updated_at = ?
        WHERE id = ? AND status = ?
      `).run(error.message, failedAt, failedAt, current.id, current.status);
      if (failure.changes !== 1) {
        throw new Error(`Task ${current.id} changed during reschedule failure handling`);
      }
      return { kind: 'failed', error };
    }

    const updatedAt = transitionTime;
    const update = db.prepare(`
      UPDATE tasks
      SET next_run_at = ?, status = 'pending', last_run_at = ?, updated_at = ?
      WHERE id = ? AND status = ?
    `).run(nextRun, updatedAt, updatedAt, current.id, current.status);
    if (update.changes !== 1) {
      throw new Error(`Task ${current.id} changed during rescheduling`);
    }
    return { kind: 'updated', nextRun };
  });

  const outcome = transition.immediate();
  if (outcome.kind === 'failed') throw outcome.error;
  if (outcome.kind !== 'updated') return false;

  console.log(`[${new Date().toISOString()}] Updated next run for ${task.id}: ${formatTime(outcome.nextRun)}`);
  return true;
}

/**
 * Handle completed tasks - update recurring ones, finalize one-time
 */
export function processCompletedTasks(db) {
  const completedTasks = db.prepare(`
    SELECT * FROM tasks WHERE status = 'completed'
  `).all();

  for (const task of completedTasks) {
    if (task.type === 'one-time') {
      continue;
    }

    try {
      updateNextRunTime(db, task);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Failed to reschedule task ${task.id}: ${error.message}`);
    }
  }
}

/**
 * Handle stale running tasks (orphaned due to compaction/crash)
 * Tasks running for more than TASK_TIMEOUT seconds are considered stale
 */
export function handleStaleRunningTasks(db) {
  const currentTime = now();
  const staleThreshold = currentTime - TASK_TIMEOUT;

  const staleTasks = db.prepare(`
    SELECT tasks.*,
      (
        SELECT id FROM task_history
        WHERE task_id = tasks.id AND status = 'started'
        ORDER BY id DESC LIMIT 1
      ) AS active_run_id
    FROM tasks
    WHERE status = 'running'
    AND updated_at < ?
  `).all(staleThreshold);

  for (const task of staleTasks) {
    const timedOut = timeoutTaskRun(db, {
      taskId: task.id,
      runId: task.active_run_id,
      staleBefore: staleThreshold,
      timedOutAt: currentTime
    });
    if (timedOut) {
      console.log(`[${new Date().toISOString()}] Task ${task.id} (${task.name}) timed out after ${TASK_TIMEOUT}s`);
    }
  }
}
