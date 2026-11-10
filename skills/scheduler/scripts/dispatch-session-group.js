/** Resolve a claimed execution's saved destination without changing its snapshot. */
export function resolveDispatchSessionGroup(db, task, historyId, { query, isOrigin, diagnostic = console.error }) {
  const target = { component: task.reply_channel, endpoint: task.reply_endpoint };
  if (isOrigin(target)) return { ...task, session_component: null, session_group_name: null };
  if (task.session_component != null || task.session_group_name != null || !target.component || !target.endpoint) return task;

  let groupName;
  try {
    ({ groupName } = query(target));
  } catch (error) {
    if (error.code !== 'SESSION_GROUP_QUERY_FAILED') throw error;
    diagnostic(`[Scheduler] Task ${task.id}: SESSION_GROUP_QUERY_FAILED; using component overall group (${String(error.reason ?? error.message).slice(0, 400)})`);
    db.prepare("UPDATE task_history SET error=? WHERE id=? AND task_id=? AND status='started'")
      .run('SESSION_GROUP_QUERY_FAILED', historyId, task.id);
    return { ...task, session_component: target.component, session_group_name: null };
  }

  try {
    db.prepare(`UPDATE tasks SET session_component=?,session_group_name=?
      WHERE id=? AND session_component IS NULL AND session_group_name IS NULL
      AND reply_channel IS ? AND reply_endpoint IS ?`)
      .run(target.component, groupName, task.id, target.component, target.endpoint);
  } catch (error) {
    diagnostic(`[Scheduler] Task ${task.id}: could not save queried session group (${String(error.message).slice(0, 200)})`);
  }
  // A concurrent edit belongs to the next execution. CAS misses do not retarget
  // this already claimed execution, retry, or produce a warning.
  return { ...task, session_component: target.component, session_group_name: groupName };
}
