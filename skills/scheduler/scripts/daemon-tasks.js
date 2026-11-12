/**
 * Daemon task processing logic
 * Extracted from daemon.js for testability
 */

import { now } from './database.js';
import { getNextRun } from './cron-utils.js';
import { formatTime } from './time-utils.js';

/**
 * Update next_run_at for recurring/interval tasks after delivery
 */
export function updateNextRunTime(db, task) {
  let nextRun;

  if (task.type === 'recurring' && task.cron_expression) {
    nextRun = getNextRun(task.cron_expression, task.timezone);
  } else if (task.type === 'interval' && task.interval_seconds) {
    nextRun = now() + task.interval_seconds;
  } else {
    return; // One-time task, no update needed
  }

  db.prepare(`
    UPDATE tasks
    SET next_run_at = ?, status = 'pending', last_run_at = ?, updated_at = ?
    WHERE id = ?
  `).run(nextRun, now(), now(), task.id);

  console.log(`[${new Date().toISOString()}] Updated next run for ${task.id}: ${formatTime(nextRun)}`);
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
      db.prepare(`
        UPDATE tasks SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?
      `).run(error.message, now(), task.id);
    }
  }
}
