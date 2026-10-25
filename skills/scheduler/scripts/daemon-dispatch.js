/** One Scheduler execution: claim, receive once, and account for that history id. */
import { now, cleanupHistory } from './database.js';
import { updateNextRunTime, processCompletedTasks, handleStaleRunningTasks } from './daemon-tasks.js';
import { sendViaC4 } from './runtime.js';
import { getRecentConversations, getConversationsByRange } from '../../comm-bridge/scripts/c4-db.js';

export const executionMarker = (taskId, historyId) => `[Scheduled Task: ${taskId} #${historyId}]`;

export function dispatchTask(db, candidate, dependencies = {}) {
  const recent = dependencies.getRecentConversations || getRecentConversations;
  const range = dependencies.getConversationsByRange || getConversationsByRange;
  const send = dependencies.sendViaC4 || sendViaC4;
  const claim = db.transaction(() => {
    const changed = db.prepare("UPDATE tasks SET status='running', updated_at=? WHERE id=? AND status='pending'")
      .run(now(), candidate.id);
    if (!changed.changes) return null;
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(candidate.id);
    const historyId = Number(db.prepare("INSERT INTO task_history(task_id,executed_at,status) VALUES(?,?,'started')")
      .run(task.id, now()).lastInsertRowid);
    return { task, historyId };
  }).immediate();
  if (!claim) {
    console.log(`[Scheduler] Task ${candidate.id} already claimed/modified, skipping`);
    return { claimed: false };
  }
  const { task, historyId } = claim;
  console.log(`[Scheduler] Dispatching task ${task.id} (${task.name}) #${historyId}`);
  const marker = executionMarker(task.id, historyId);
  const prompt = `${marker}\n${task.prompt}\n\n---- After completing this task, run: ~/zylos/.claude/skills/scheduler/scripts/cli.js done ${task.id}`;
  let result;
  let lowerId;
  try {
    lowerId = recent(1)[0]?.id ?? 0;
  } catch {
    result = { category: 'T', code: 'CONVERSATION_BOUND_UNAVAILABLE' };
  }
  if (!result) {
    result = send(prompt, { priority: task.priority, requireIdle: task.require_idle === 1,
      sessionComponent: task.session_component, sessionGroupName: task.session_group_name,
      replyChannel: task.reply_channel, replyEndpoint: task.reply_endpoint });
    if (result.category === 'U') {
      try {
        const rows = range(lowerId + 1, Number.MAX_SAFE_INTEGER);
        const committed = rows.some(row => row.direction === 'in' && row.content.split('\n', 1)[0] === marker);
        result = { ...result, category: committed ? 'success' : 'T', code: committed ? undefined : 'RECEIVE_NOT_COMMITTED', readback: committed ? 'found' : 'absent' };
      } catch {
        result = { ...result, category: 'U', code: 'RECEIVE_RESULT_UNKNOWN', readback: 'failed' };
      }
    }
  }
  // done may run in another process while receive is in flight. Both task and
  // this exact history row must still be live before changing either of them.
  db.transaction(() => {
    const live = db.prepare("SELECT 1 FROM tasks t JOIN task_history h ON h.task_id=t.id WHERE t.id=? AND t.status='running' AND h.id=? AND h.status='started'")
      .get(task.id, historyId);
    if (!live || result.category === 'success') return;
    const timestamp = now();
    if (result.category === 'C' || result.category === 'U') {
      db.prepare('UPDATE tasks SET last_error=? WHERE id=?').run(result.code, task.id);
      return;
    }
    db.prepare("UPDATE task_history SET status='failed',completed_at=?,error=? WHERE id=? AND status='started'")
      .run(timestamp, result.code, historyId);
    if (result.category === 'T') {
      db.prepare("UPDATE tasks SET status='pending',last_error=?,updated_at=? WHERE id=?")
        .run(result.code, timestamp, task.id);
    } else if (task.type === 'one-time') {
      db.prepare("UPDATE tasks SET status='failed',last_error=?,failed_at=?,updated_at=? WHERE id=?")
        .run(result.code, timestamp, timestamp, task.id);
    } else {
      updateNextRunTime(db, task);
      db.prepare('UPDATE tasks SET last_error=? WHERE id=?').run(result.code, task.id);
    }
  }).immediate();
  if (result.category !== 'success') {
    console.error(`[Scheduler] Dispatch ${task.id} #${historyId}: ${result.code} (${result.category})`);
  }
  return { claimed: true, historyId, ...result };
}

const CHECK_INTERVAL = 5000;
const CLEANUP_INTERVAL = 3600000;

function dispatchDueTask(db, task, dependencies) {
  const timestamp = now();
  const overdue = timestamp - task.next_run_at;
  const threshold = task.miss_threshold || 300;
  if (overdue > threshold) {
    console.log(`[Scheduler] Task ${task.id} (${task.name}) missed execution window by ${overdue}s (threshold: ${threshold}s), skipping`);
    if (task.type === 'one-time') {
      db.prepare("UPDATE tasks SET status='failed',last_error='Missed execution window',updated_at=? WHERE id=? AND status='pending'")
        .run(timestamp, task.id);
    } else {
      updateNextRunTime(db, task);
    }
    return;
  }
  return dispatchTask(db, task, dependencies);
}

export function handleMissedTasks(db, dependencies = {}, alreadyHandled = new Set()) {
  const tasks = db.prepare("SELECT * FROM tasks WHERE status='pending' AND type IN ('recurring','interval') AND next_run_at < ?")
    .all(now() - 300);
  for (const task of tasks) {
    if (!alreadyHandled.has(task.id)) dispatchDueTask(db, task, dependencies);
  }
}

export function runSchedulerIteration(db, dependencies = {}) {
  const task = db.prepare("SELECT * FROM tasks WHERE status='pending' AND next_run_at<=? ORDER BY priority ASC,next_run_at ASC LIMIT 1").get(now());
  if (task) dispatchDueTask(db, task, dependencies);
  processCompletedTasks(db);
  handleMissedTasks(db, dependencies, new Set(task ? [task.id] : []));
  handleStaleRunningTasks(db);
}

export async function mainLoop(db, { shouldRun, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), dependencies = {} }) {
  handleStaleRunningTasks(db);
  let lastCleanup = Date.now();
  while (shouldRun()) {
    try {
      runSchedulerIteration(db, dependencies);
      if (Date.now() - lastCleanup > CLEANUP_INTERVAL) {
        cleanupHistory();
        lastCleanup = Date.now();
      }
    } catch (error) {
      // An accounting failure never causes a second receive in this attempt.
      console.error(`[${new Date().toISOString()}] Scheduler error: ${error.message}`);
    }
    await sleep(CHECK_INTERVAL);
  }
}
