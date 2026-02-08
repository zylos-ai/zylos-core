#!/usr/bin/env node
/**
 * Scheduler Daemon
 * Main orchestrator for autonomous task execution
 */

import { getDb, cleanupHistory, now } from './database.js';
import { getNextRun } from './cron-utils.js';
import { sendViaC4, readStatusFile } from './runtime.js';
import { formatTime } from './time-utils.js';
import { loadTimezone } from './tz.js';

const CHECK_INTERVAL = 10000;  // 10 seconds
const CLEANUP_INTERVAL = 3600000;  // 1 hour
const TASK_TIMEOUT = 3600;  // 1 hour - max time a task can be 'running'

let db;
let running = true;

try {
  process.env.TZ = loadTimezone();
} catch (error) {
  const code = error.code || 'UNKNOWN_TZ_ERROR';
  console.error(`[${new Date().toISOString()}] Fatal timezone config error [${code}]: ${error.message}`);
  process.exit(1);
}

/**
 * Get the next pending task that's due
 */
function getNextPendingTask() {
  const currentTime = now();

  return db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'pending'
    AND next_run_at <= ?
    ORDER BY priority ASC, next_run_at ASC
    LIMIT 1
  `).get(currentTime);
}

/**
 * Check if Claude runtime is alive
 * @returns {boolean} True if runtime is running (busy or idle state)
 */
function isRuntimeAlive() {
  const status = readStatusFile();
  if (!status) return false;
  return status.state === 'busy' || status.state === 'idle';
}

/**
 * Dispatch a task to Claude via C4 comm-bridge
 */
function dispatchTask(task) {
  console.log(`[${new Date().toISOString()}] Dispatching task: ${task.id} (${task.name})`);

  // Atomically claim the task (only if still pending)
  const claim = db.prepare(`
    UPDATE tasks
    SET status = 'running', updated_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(now(), task.id);

  if (claim.changes === 0) {
    console.log(`[${new Date().toISOString()}] Task ${task.id} already claimed/modified, skipping`);
    return false;
  }

  // Create history entry
  db.prepare(`
    INSERT INTO task_history (task_id, executed_at, status)
    VALUES (?, ?, 'started')
  `).run(task.id, now());

  // Build prompt with completion instruction
  const prompt = `[Scheduled Task: ${task.id}] ${task.prompt}

---- After completing this task, run: ~/zylos/.claude/skills/scheduler/scripts/cli.js done ${task.id}`;

  // Send via C4 Communication Bridge
  const success = sendViaC4(prompt, {
    priority: task.priority,
    requireIdle: task.require_idle === 1,
    replyChannel: task.reply_channel,
    replyEndpoint: task.reply_endpoint
  });

  if (!success) {
    console.error(`Failed to dispatch task ${task.id}`);

    // Revert to pending
    db.prepare(`
      UPDATE tasks
      SET status = 'pending', last_error = 'Failed to dispatch message', updated_at = ?
      WHERE id = ?
    `).run(now(), task.id);

    // Mark task_history as failed (latest entry only)
    const historyEntry = db.prepare(`
      SELECT id FROM task_history
      WHERE task_id = ? AND status = 'started'
      ORDER BY executed_at DESC LIMIT 1
    `).get(task.id);

    if (historyEntry) {
      db.prepare(`
        UPDATE task_history
        SET status = 'failed', completed_at = ?
        WHERE id = ?
      `).run(now(), historyEntry.id);
    }
  }

  return success;
}

/**
 * Update next_run_at for recurring/interval tasks after completion
 */
function updateNextRunTime(task) {
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
function processCompletedTasks() {
  const completedTasks = db.prepare(`
    SELECT * FROM tasks WHERE status = 'completed'
  `).all();

  for (const task of completedTasks) {
    if (task.type === 'one-time') {
      // One-time tasks stay completed
      continue;
    }

    // Update recurring/interval tasks with next run time
    try {
      updateNextRunTime(task);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Failed to reschedule task ${task.id}: ${error.message}`);
      db.prepare(`
        UPDATE tasks SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?
      `).run(error.message, now(), task.id);
    }
  }
}

/**
 * Check for missed tasks (past due but still pending)
 * - Tasks overdue < miss_threshold: try to dispatch if runtime alive
 * - Tasks overdue > miss_threshold: skip to next scheduled time
 */
function handleMissedTasks() {
  const currentTime = now();
  const recentMissedThreshold = currentTime - 300;   // 5 minutes

  // Find recurring/interval tasks that are past due (>5 min)
  const missedTasks = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'pending'
    AND type IN ('recurring', 'interval')
    AND next_run_at < ?
  `).all(recentMissedThreshold);

  for (const task of missedTasks) {
    const overdueSeconds = currentTime - task.next_run_at;
    const threshold = task.miss_threshold || 300;  // Default 5 minutes

    if (overdueSeconds > threshold) {
      // Overdue beyond threshold: skip to next schedule
      console.log(`[${new Date().toISOString()}] Task ${task.id} (${task.name}) missed by ${overdueSeconds}s (threshold: ${threshold}s), skipping to next schedule`);
      updateNextRunTime({
        ...task,
        status: 'completed'
      });
    } else {
      // Within threshold: try to dispatch if runtime is alive
      if (isRuntimeAlive()) {
        console.log(`[${new Date().toISOString()}] Late-dispatching missed task ${task.id} (${task.name}), ${Math.round(overdueSeconds/60)}min overdue`);
        dispatchTask(task);
      }
      // If runtime not alive, leave it pending - will try again next check
    }
  }
}

/**
 * Handle stale running tasks (orphaned due to compaction/crash)
 * Tasks running for more than TASK_TIMEOUT seconds are considered stale
 */
function handleStaleRunningTasks() {
  const currentTime = now();
  const staleThreshold = currentTime - TASK_TIMEOUT;

  // Find tasks that have been 'running' for too long
  const staleTasks = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'running'
    AND updated_at < ?
  `).all(staleThreshold);

  for (const task of staleTasks) {
    console.log(`[${new Date().toISOString()}] Task ${task.id} (${task.name}) timed out after ${TASK_TIMEOUT}s`);

    // Update history to show timeout
    db.prepare(`
      UPDATE task_history
      SET status = 'timeout', completed_at = ?
      WHERE task_id = ? AND status = 'started'
    `).run(now(), task.id);

    if (task.type === 'one-time') {
      // One-time tasks: mark as failed
      db.prepare(`
        UPDATE tasks
        SET status = 'failed', last_error = 'Task timed out', updated_at = ?
        WHERE id = ?
      `).run(now(), task.id);
    } else {
      // Recurring/interval tasks: schedule next run
      db.prepare(`
        UPDATE tasks
        SET status = 'completed', last_error = 'Task timed out', updated_at = ?
        WHERE id = ?
      `).run(now(), task.id);

      // This will be picked up by processCompletedTasks and rescheduled
    }
  }
}

/**
 * Main scheduler loop
 */
async function mainLoop() {
  console.log(`[${new Date().toISOString()}] Scheduler V2 started (TZ: ${process.env.TZ})`);
  console.log(`Check interval: ${CHECK_INTERVAL}ms`);

  // Clean up stale running tasks on startup
  console.log(`[${new Date().toISOString()}] Checking for stale running tasks...`);
  handleStaleRunningTasks();

  let lastCleanup = Date.now();

  while (running) {
    try {
      // Check if runtime is alive
      if (!isRuntimeAlive()) {
        console.log(`[${new Date().toISOString()}] Waiting for Claude runtime (offline or stopped)...`);
        await sleep(CHECK_INTERVAL);
        continue;
      }

      // Get next pending task
      const task = getNextPendingTask();

      // Dispatch if task is due and runtime is alive
      if (task) {
        const currentTime = now();
        const overdueSeconds = currentTime - task.next_run_at;
        const threshold = task.miss_threshold || 300;

        // Check if task is overdue beyond its miss_threshold
        if (overdueSeconds > threshold) {
          // Skip this task
          console.log(`[${new Date().toISOString()}] Task ${task.id} (${task.name}) overdue by ${overdueSeconds}s (threshold: ${threshold}s), skipping`);

          if (task.type === 'one-time') {
            // One-time tasks: mark as failed
            db.prepare(`
              UPDATE tasks
              SET status = 'failed', last_error = 'Missed execution window', updated_at = ?
              WHERE id = ?
            `).run(currentTime, task.id);
          } else {
            // Recurring/interval tasks: schedule next run
            updateNextRunTime(task);
          }
        } else {
          // Within threshold: dispatch normally
          dispatchTask(task);
        }
      }

      // Process completed tasks (update recurring schedules)
      processCompletedTasks();

      // Handle missed tasks
      handleMissedTasks();

      // Handle stale running tasks (orphaned due to compaction/crash)
      handleStaleRunningTasks();

      // Periodic cleanup of old history
      if (Date.now() - lastCleanup > CLEANUP_INTERVAL) {
        const deleted = cleanupHistory();
        if (deleted > 0) {
          console.log(`[${new Date().toISOString()}] Cleaned up ${deleted} old history entries`);
        }
        lastCleanup = Date.now();
      }

    } catch (error) {
      console.error(`[${new Date().toISOString()}] Scheduler error:`, error.message);
    }

    await sleep(CHECK_INTERVAL);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down scheduler...');
  running = false;
});

process.on('SIGTERM', () => {
  console.log('\nShutting down scheduler...');
  running = false;
});

// Start the scheduler
db = getDb();
mainLoop().then(() => {
  console.log('Scheduler stopped');
  if (db) db.close();
  process.exit(0);
});
