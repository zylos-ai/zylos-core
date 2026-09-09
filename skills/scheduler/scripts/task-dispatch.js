/**
 * Scheduler run dispatch behind one transactional run-identity interface.
 */

import { now } from './database.js';
import { startTaskRun } from './task-runs.js';

export function dispatchTaskRun(db, task, send, { dispatchedAt = now() } = {}) {
  const started = startTaskRun(db, { taskId: task.id, startedAt: dispatchedAt });
  if (started === null) {
    return { success: false, runId: null, reason: 'not-pending' };
  }
  const { runId, task: claimedTask } = started;

  const prompt = `[Scheduled Task: ${claimedTask.id}] ${claimedTask.prompt}

---- After completing this task, run: ~/zylos/.claude/skills/scheduler/scripts/cli.js done ${claimedTask.id} --run-id ${runId}`;

  let success = false;
  try {
    success = Boolean(send(prompt, {
      priority: claimedTask.priority,
      requireIdle: claimedTask.require_idle === 1,
      replyChannel: claimedTask.reply_channel,
      replyEndpoint: claimedTask.reply_endpoint
    }));
  } catch {
    success = false;
  }

  if (!success) {
    const failDispatch = db.transaction(() => {
      const taskUpdate = db.prepare(`
        UPDATE tasks
        SET status = 'pending', failed_at = ?,
            last_error = 'Failed to dispatch message', updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(dispatchedAt, dispatchedAt, task.id);

      if (taskUpdate.changes !== 1) {
        throw new Error(`Task ${task.id} changed during dispatch failure handling`);
      }

      const historyUpdate = db.prepare(`
        UPDATE task_history
        SET status = 'failed', completed_at = ?, error = 'Failed to dispatch message'
        WHERE id = ? AND task_id = ? AND status = 'started'
      `).run(dispatchedAt, runId, task.id);

      if (historyUpdate.changes !== 1) {
        throw new Error(`Run ${runId} changed during dispatch failure handling`);
      }
    });
    failDispatch();
  }

  return { success, runId, reason: success ? null : 'send-failed' };
}
