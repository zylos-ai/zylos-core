/** Complete an execution while the caller holds the task's write transaction. */
export function completeTaskExecution(db, task, timestamp) {
  const changed = db.prepare(`
    UPDATE tasks SET status='completed', last_run_at=?, updated_at=?
    WHERE id=? AND status=? AND updated_at=?
  `).run(timestamp, timestamp, task.id, task.status, task.updated_at);
  if (!changed.changes) return false;
  const history = db.prepare(`
    SELECT id, executed_at FROM task_history
    WHERE task_id=? AND status='started' ORDER BY executed_at DESC, id DESC LIMIT 1
  `).get(task.id);
  if (history) {
    db.prepare(`UPDATE task_history SET status='success', completed_at=?, duration_ms=?
      WHERE id=? AND status='started'`)
      .run(timestamp, (timestamp - history.executed_at) * 1000, history.id);
  }
  return true;
}
