/**
 * Daemon task processing logic
 * Extracted from daemon.js for testability
 */

import { now } from './database.js';
import { getNextRun } from './cron-utils.js';
import { formatTime } from './time-utils.js';

/**
 * Update next_run_at for recurring/interval tasks after delivery.
 * Calculation failures mark only this task failed and return false; database
 * errors still propagate so the caller can roll back incomplete accounting.
 */
export function updateNextRunTime(db, task) {
  let nextRun;

  try {
    if (task.type === 'recurring' && task.cron_expression) {
      nextRun = getNextRun(task.cron_expression, task.timezone);
    } else if (task.type === 'interval' && task.interval_seconds) {
      nextRun = now() + task.interval_seconds;
    } else {
      return; // One-time task, no update needed
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Failed to reschedule task ${task.id}: ${error.message}`);
    db.prepare("UPDATE tasks SET status='failed',last_error=?,updated_at=? WHERE id=?")
      .run(error.message, now(), task.id);
    return false;
  }

  db.prepare(`
    UPDATE tasks
    SET next_run_at = ?, status = 'pending', last_run_at = ?, updated_at = ?
    WHERE id = ?
  `).run(nextRun, now(), now(), task.id);

  console.log(`[${new Date().toISOString()}] Updated next run for ${task.id}: ${formatTime(nextRun)}`);
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
      db.prepare(`
        UPDATE tasks SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?
      `).run(error.message, now(), task.id);
    }
  }
}

// Four times the 45-second receive bound allows result readback/accounting to finish.
export const DELIVERY_RESULT_TIMEOUT_SECONDS = 180;

/** Close an abandoned/unknown receipt without sending the same occurrence again. */
export function settleStaleDeliveries(db) {
  const cutoff = now() - DELIVERY_RESULT_TIMEOUT_SECONDS;
  const stale = db.prepare(`SELECT t.*, h.id AS history_id, h.executed_at AS delivery_started_at
    FROM tasks t LEFT JOIN task_history h ON h.id=(
      SELECT id FROM task_history WHERE task_id=t.id AND status='started'
      ORDER BY executed_at DESC,id DESC LIMIT 1)
    WHERE t.status='running' AND COALESCE(h.executed_at,t.updated_at) < ?`).all(cutoff);
  for (const task of stale) {
    db.transaction(() => {
      const live = db.prepare(`SELECT status,updated_at,(
        SELECT id FROM task_history WHERE task_id=tasks.id AND status='started'
        ORDER BY executed_at DESC,id DESC LIMIT 1) AS history_id FROM tasks WHERE id=?`).get(task.id);
      if (!live || live.status !== 'running' || live.updated_at !== task.updated_at || live.history_id !== task.history_id) return;
      const timestamp = now();
      if (task.history_id != null) {
        db.prepare(`UPDATE task_history SET status='failed',error='DELIVERY_RESULT_UNKNOWN',
          completed_at=?,duration_ms=(?-executed_at)*1000 WHERE id=? AND status='started'`)
          .run(timestamp,timestamp,task.history_id);
      }
      if (task.type === 'one-time') {
        db.prepare(`UPDATE tasks SET status='failed',last_error='DELIVERY_RESULT_UNKNOWN',
          failed_at=?,updated_at=? WHERE id=?`).run(timestamp,timestamp,task.id);
      } else {
        if (updateNextRunTime(db,task)) {
          db.prepare("UPDATE tasks SET last_error='DELIVERY_RESULT_UNKNOWN' WHERE id=?").run(task.id);
        }
      }
    }).immediate();
  }
}
