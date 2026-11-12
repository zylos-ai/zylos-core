/** Adopt the delivery-completion rule for executions already running at upgrade. */
export function migrateToV3(db) {
  const timestamp = Math.floor(Date.now() / 1000);
  // Legacy running rows are explicitly assumed delivered. Periodic rows stay
  // completed until the installed daemon computes their next future occurrence;
  // schema/probe code must also load from an npm-free downloaded package.
  db.prepare(`UPDATE task_history
    SET status='success', completed_at=?, duration_ms=(? - executed_at) * 1000
    WHERE status='started' AND task_id IN (SELECT id FROM tasks WHERE status='running')`)
    .run(timestamp, timestamp);
  db.prepare(`UPDATE tasks SET status='completed', last_run_at=?, updated_at=?,
    last_error=NULL, failed_at=NULL WHERE status='running'`)
    .run(timestamp, timestamp);
}
