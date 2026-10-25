#!/usr/bin/env node
/** Scheduler daemon: due time controls dispatch; runtime state belongs to C4. */
import { pathToFileURL } from 'node:url';
import { getDb, cleanupHistory, now } from './database.js';
import { loadTimezone } from './tz.js';
import { dispatchTask } from './daemon-dispatch.js';
import { updateNextRunTime, processCompletedTasks, handleStaleRunningTasks } from './daemon-tasks.js';

const CHECK_INTERVAL = 5000;
const CLEANUP_INTERVAL = 3600000;

function dispatchDueTask(db, task, dependencies) {
  const timestamp = now();
  if (timestamp - task.next_run_at > (task.miss_threshold ?? 300)) {
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

export async function startScheduler() {
  process.env.TZ = loadTimezone();
  const db = getDb();
  let running = true;
  const stop = () => { running = false; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log(`[${new Date().toISOString()}] Scheduler started (TZ: ${process.env.TZ})`);
  try { await mainLoop(db, { shouldRun: () => running }); }
  finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startScheduler().catch(error => {
    console.error(`Scheduler failed [${error.code || 'INTERNAL_ERROR'}]: ${error.message}`);
    process.exitCode = 1;
  });
}
