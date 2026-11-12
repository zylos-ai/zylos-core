import { getNextRun } from './cron-utils.js';

/** Adopt the delivery-completion rule for executions already running at upgrade. */
export function migrateToV3(db) {
  const timestamp = Math.floor(Date.now() / 1000);
  const running = db.prepare("SELECT id, type, cron_expression, interval_seconds, timezone, next_run_at FROM tasks WHERE status='running'").all();
  const finishHistory = db.prepare(`UPDATE task_history
    SET status='success', completed_at=?, duration_ms=(? - executed_at) * 1000
    WHERE task_id=? AND status='started'`);
  const finishTask = db.prepare(`UPDATE tasks
    SET status=?, next_run_at=?, last_run_at=?, updated_at=?, last_error=NULL, failed_at=NULL
    WHERE id=?`);
  for (const task of running) {
    let nextRun = task.next_run_at;
    if (task.type === 'recurring') {
      nextRun = getNextRun(task.cron_expression, task.timezone, new Date(timestamp * 1000));
    } else if (task.type === 'interval') {
      if (!Number.isInteger(task.interval_seconds) || task.interval_seconds <= 0) {
        throw new Error(`Cannot migrate running interval task ${task.id}: invalid interval`);
      }
      nextRun = timestamp + task.interval_seconds;
    }
    finishHistory.run(timestamp, timestamp, task.id);
    finishTask.run(task.type === 'one-time' ? 'completed' : 'pending', nextRun, timestamp, timestamp, task.id);
  }
}
