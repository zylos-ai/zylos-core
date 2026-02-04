#!/usr/bin/env node
/**
 * Scheduler V2 - Main Daemon
 * Production-ready time-based task scheduler for Zylos
 */

import { getDb, cleanupHistory, now } from './db.js';
import { getNextRun } from './cron.js';
import { getIdleSeconds, isIdle, isAtPrompt, sendToTmux, sendViaC4, sessionExists } from './activity.js';
import { formatTime, getRelativeTime } from './time-parser.js';

const CHECK_INTERVAL = 10000;  // 10 seconds
const CLEANUP_INTERVAL = 3600000;  // 1 hour
const TASK_TIMEOUT = 3600;  // 1 hour - max time a task can be 'running'

let db;
let running = true;

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
 * Get idle threshold for a priority level
 */
function getIdleThreshold(priority) {
  const thresholds = { 1: 15, 2: 30, 3: 45, 4: 60 };
  return thresholds[priority] || 45;
}

/**
 * Check if task should be dispatched
 */
function shouldDispatch(task, idleSeconds) {
  if (!task) return false;

  // If idleSeconds is null (status file missing), assume idle to avoid wedging
  // Same fallback as c4-dispatcher to prevent permanent stall
  if (idleSeconds === null) {
    console.log(`[${new Date().toISOString()}] Warning: idle status unavailable, assuming idle for dispatch`);
    idleSeconds = 999;  // Assume very idle
  }

  const threshold = getIdleThreshold(task.priority);
  const currentTime = now();

  return (
    task.status === 'pending' &&
    task.next_run_at <= currentTime &&
    idleSeconds >= threshold
  );
}

/**
 * Dispatch a task to Claude via tmux
 */
function dispatchTask(task) {
  console.log(`[${new Date().toISOString()}] Dispatching task: ${task.id} (${task.name})`);

  // Mark as running
  db.prepare(`
    UPDATE tasks
    SET status = 'running', updated_at = ?
    WHERE id = ?
  `).run(now(), task.id);

  // Create history entry
  db.prepare(`
    INSERT INTO task_history (task_id, executed_at, status)
    VALUES (?, ?, 'started')
  `).run(task.id, now());

  let prompt;
  let success;

  // Special handling for auto-compact tasks: send /compact directly via tmux
  if (task.name === 'auto-compact') {
    prompt = '/compact';
    console.log(`[${new Date().toISOString()}] Sending /compact command for auto-compact task`);

    // Use tmux for /compact (slash command)
    success = sendToTmux(prompt);

    if (success) {
      // Auto-complete this task after sending
      db.prepare(`
        UPDATE tasks
        SET status = 'completed', last_run_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now(), now(), task.id);

      // Mark task_history as success (latest entry only)
      const historyEntry = db.prepare(`
        SELECT id FROM task_history
        WHERE task_id = ? AND status = 'started'
        ORDER BY executed_at DESC LIMIT 1
      `).get(task.id);

      if (historyEntry) {
        db.prepare(`
          UPDATE task_history
          SET status = 'success', completed_at = ?
          WHERE id = ?
        `).run(now(), historyEntry.id);
      }
    }
  } else {
    // Regular task: build prompt with completion instruction
    prompt = `[Scheduled Task: ${task.id}] ${task.prompt}

---- After completing this task, run: ~/.claude/skills/scheduler/task-cli.js done ${task.id}`;

    // Send via C4 Communication Bridge with task priority
    // Map scheduler priority (1-4) to C4 priority (1-3)
    const c4Priority = Math.min(task.priority, 3);
    success = sendViaC4(prompt, 'scheduler', c4Priority);
  }

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
    updateNextRunTime(task);
  }
}

/**
 * Check for missed tasks (past due but still pending)
 * - Tasks 5-60 min overdue: try to dispatch if Claude is idle
 * - Tasks >60 min overdue: skip to next scheduled time
 */
function handleMissedTasks() {
  const currentTime = now();
  const recentMissedThreshold = currentTime - 300;   // 5 minutes
  const oldMissedThreshold = currentTime - 3600;     // 1 hour

  // Find recurring/interval tasks that are past due (>5 min)
  const missedTasks = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'pending'
    AND type IN ('recurring', 'interval')
    AND next_run_at < ?
  `).all(recentMissedThreshold);

  for (const task of missedTasks) {
    const overdueSeconds = currentTime - task.next_run_at;

    if (task.next_run_at < oldMissedThreshold) {
      // Very old (>1 hour): skip to next schedule
      console.log(`[${new Date().toISOString()}] Task ${task.id} (${task.name}) is >1 hour overdue, skipping to next schedule`);
      updateNextRunTime({
        ...task,
        status: 'completed'
      });
    } else {
      // Recent miss (5-60 min): try to dispatch if idle
      let idleSeconds = getIdleSeconds();
      const threshold = getIdleThreshold(task.priority);

      // Treat null as idle to avoid stall (status file missing)
      if (idleSeconds === null) {
        console.log(`[${new Date().toISOString()}] Warning: idle status unavailable for missed task ${task.id}, assuming idle`);
        idleSeconds = 999;
      }

      if (idleSeconds >= threshold) {
        console.log(`[${new Date().toISOString()}] Late-dispatching missed task ${task.id} (${task.name}), ${Math.round(overdueSeconds/60)}min overdue`);
        dispatchTask(task);
      }
      // If not idle enough, leave it pending - will try again next check
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
  console.log(`[${new Date().toISOString()}] Scheduler V2 started`);
  console.log(`Check interval: ${CHECK_INTERVAL}ms`);

  let lastCleanup = Date.now();

  while (running) {
    try {
      // Check if tmux session exists
      if (!sessionExists()) {
        console.log(`[${new Date().toISOString()}] Waiting for tmux session...`);
        await sleep(CHECK_INTERVAL);
        continue;
      }

      // Get Claude's idle time
      const idleSeconds = getIdleSeconds();

      // Get next pending task
      const task = getNextPendingTask();

      // Debug: log when a task is due but not dispatched
      if (task && !shouldDispatch(task, idleSeconds)) {
        const threshold = getIdleThreshold(task.priority);
        if (idleSeconds === null) {
          console.log(`[${new Date().toISOString()}] Task ${task.name} due but idle=null (status file issue?)`);
        } else if (idleSeconds < threshold) {
          // Only log occasionally to avoid spam
          if (Math.random() < 0.1) {
            console.log(`[${new Date().toISOString()}] Task ${task.name} due but waiting for idle (${idleSeconds}s < ${threshold}s)`);
          }
        }
      }

      // Dispatch if conditions are met
      if (task && shouldDispatch(task, idleSeconds)) {
        // For auto-compact, also verify Claude is at prompt (ready for slash commands)
        if (task.name === 'auto-compact') {
          if (!isAtPrompt()) {
            console.log(`[${new Date().toISOString()}] auto-compact waiting for prompt...`);
            await sleep(CHECK_INTERVAL);
            continue;
          }
        }
        dispatchTask(task);
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
  process.exit(0);
});
