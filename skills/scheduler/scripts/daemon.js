#!/usr/bin/env node
/**
 * Scheduler Daemon
 * Main orchestrator for autonomous task execution
 */

import { getDb, cleanupHistory, now } from './database.js';
import { sendViaC4, readStatusFile } from './runtime.js';
import { loadTimezone } from './tz.js';
import {
  failMissedOneTimeTask as _failMissedOneTimeTask,
  updateNextRunTime as _updateNextRunTime,
  processCompletedTasks as _processCompletedTasks,
  handleStaleRunningTasks as _handleStaleRunningTasks
} from './daemon-tasks.js';
import { dispatchTaskRun } from './task-dispatch.js';

const CHECK_INTERVAL = 5000;  // 5 seconds
const CLEANUP_INTERVAL = 3600000;  // 1 hour
const OFFLINE_LOG_INTERVAL = 30000;  // 30 seconds

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
 * Check if the active agent runtime is alive.
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

  const result = dispatchTaskRun(db, task, sendViaC4);
  if (result.reason === 'not-pending') {
    console.log(`[${new Date().toISOString()}] Task ${task.id} already claimed/modified, skipping`);
    return false;
  }

  if (!result.success) {
    console.error(`Failed to dispatch task ${task.id}`);
  }

  return result.success;
}

function updateNextRunTime(task) {
  _updateNextRunTime(db, task);
}

function processCompletedTasks() {
  _processCompletedTasks(db);
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
    const threshold = task.miss_threshold ?? 300;  // Default 5 minutes

    if (overdueSeconds > threshold) {
      // Overdue beyond threshold: skip to next schedule
      console.log(`[${new Date().toISOString()}] Task ${task.id} (${task.name}) missed by ${overdueSeconds}s (threshold: ${threshold}s), skipping to next schedule`);
      updateNextRunTime(task);
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

function handleStaleRunningTasks() {
  _handleStaleRunningTasks(db);
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
  let lastOfflineLog = 0;

  while (running) {
    try {
      // Check if runtime is alive
      if (!isRuntimeAlive()) {
        const msNow = Date.now();
        if (msNow - lastOfflineLog >= OFFLINE_LOG_INTERVAL) {
          console.log(`[${new Date().toISOString()}] Waiting for agent runtime (offline or stopped)...`);
          lastOfflineLog = msNow;
        }
        await sleep(CHECK_INTERVAL);
        continue;
      }

      // Log transition from offline to online
      if (lastOfflineLog > 0) {
        console.log(`[${new Date().toISOString()}] Agent runtime detected, scheduler active`);
        lastOfflineLog = 0;
      }

      // Get next pending task
      const task = getNextPendingTask();

      // Dispatch if task is due and runtime is alive
      if (task) {
        const currentTime = now();
        const overdueSeconds = currentTime - task.next_run_at;
        const threshold = task.miss_threshold ?? 300;

        // Check if task is overdue beyond its miss_threshold
        if (overdueSeconds > threshold) {
          // Skip this task
          console.log(`[${new Date().toISOString()}] Task ${task.id} (${task.name}) overdue by ${overdueSeconds}s (threshold: ${threshold}s), skipping`);

          if (task.type === 'one-time') {
            _failMissedOneTimeTask(db, { taskId: task.id, currentTime });
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
