/**
 * Database Layer
 * SQLite-based persistence for tasks and execution history
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Data goes to ~/zylos/scheduler/, code stays in skills directory
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const DATA_DIR = path.join(ZYLOS_DIR, 'scheduler');
const DB_PATH = path.join(DATA_DIR, 'scheduler.db');
const HISTORY_RETENTION_DAYS = 30;
const RUN_OUTCOME_MIGRATION_KEY = 'scheduler_run_outcome_v1';

let db = null;

export function getDb() {
  if (!db) {
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');  // Better concurrent access
    initSchema();
  }
  return db;
}

function initSchema() {
  // Create table if not exists
  db.exec(`
    -- Main tasks table
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      prompt TEXT NOT NULL,

      -- Scheduling
      type TEXT NOT NULL CHECK(type IN ('one-time', 'recurring', 'interval')),
      cron_expression TEXT,
      interval_seconds INTEGER,
      timezone TEXT DEFAULT 'UTC',

      -- Timing
      next_run_at INTEGER NOT NULL,
      last_run_at INTEGER,

      -- Priority & Status
      priority INTEGER DEFAULT 3 CHECK(priority BETWEEN 1 AND 3),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'paused')),

      -- Execution Control
      require_idle INTEGER DEFAULT 0,           -- 0/1: whether task requires idle state
      miss_threshold INTEGER DEFAULT 300,       -- seconds: skip if overdue by more than this

      -- Reply Configuration
      reply_channel TEXT DEFAULT NULL,          -- reply channel (e.g., 'telegram')
      reply_endpoint TEXT DEFAULT NULL,         -- reply endpoint (e.g., user ID)

      -- Retry Logic (reserved, not currently used)
      -- Implicit retry is handled via miss_threshold: tasks stay pending
      -- until dispatched or overdue beyond miss_threshold window (default 300s).
      -- See daemon.js mainLoop + handleMissedTasks for details.
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 3,

      -- Metadata
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,

      -- Error Tracking
      last_error TEXT,
      failed_at INTEGER
    );

    -- Critical indexes for performance
    CREATE INDEX IF NOT EXISTS idx_next_run ON tasks(next_run_at) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_status_priority ON tasks(status, priority);
    CREATE INDEX IF NOT EXISTS idx_type ON tasks(type);

    -- Execution history
    CREATE TABLE IF NOT EXISTS task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      executed_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT NOT NULL CHECK(status IN ('started', 'success', 'failed', 'timeout')),
      duration_ms INTEGER,
      error TEXT,

      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_history_task ON task_history(task_id);
    CREATE INDEX IF NOT EXISTS idx_history_time ON task_history(executed_at);

    -- System state (for tracking scheduler status, etc.)
    CREATE TABLE IF NOT EXISTS system_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER
    );
  `);

  migrateRunOutcomeState();
}

function historyAggregates() {
  return db.prepare(`
    SELECT status, COUNT(*) AS count,
           COALESCE(SUM(id), 0) AS id_sum,
           COALESCE(SUM(executed_at), 0) AS executed_sum,
           COALESCE(SUM(completed_at), 0) AS completed_sum
    FROM task_history
    GROUP BY status
    ORDER BY status
  `).all();
}

/**
 * Classify legacy task outcome fields from immutable run history.
 * This migration is transactional, idempotent, and never rewrites history.
 */
function migrateRunOutcomeState() {
  const applied = db.prepare('SELECT 1 FROM system_state WHERE key = ?').get(RUN_OUTCOME_MIGRATION_KEY);
  if (applied) return;

  const migrate = db.transaction(() => {
    if (db.prepare('SELECT 1 FROM system_state WHERE key = ?').get(RUN_OUTCOME_MIGRATION_KEY)) return;

    const beforeTaskCount = db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count;
    const beforeHistory = historyAggregates();
    const tasks = db.prepare(`
      SELECT id, status, last_error, failed_at, updated_at
      FROM tasks
    `).all();
    const latestHistory = db.prepare(`
      SELECT status, executed_at, completed_at, error
      FROM task_history
      WHERE task_id = ?
      ORDER BY id DESC
      LIMIT 1
    `);
    const updateOutcome = db.prepare(`
      UPDATE tasks SET failed_at = ?, last_error = ? WHERE id = ?
    `);

    let recovered = 0;
    let failed = 0;
    let uncertain = 0;

    for (const task of tasks) {
      const latest = latestHistory.get(task.id);
      let failedAt = task.failed_at;
      let lastError = task.last_error;

      const terminalFailed = latest?.status === 'failed' || latest?.status === 'timeout';
      const terminalFailedAt = terminalFailed
        ? (latest.completed_at ?? latest.executed_at)
        : null;
      const terminalError = terminalFailed
        ? (latest.error || (latest.status === 'timeout' ? 'Task timed out' : 'Task failed'))
        : null;
      const taskFailureAt = task.failed_at ?? task.updated_at;
      const taskFailureIsNewer = task.status === 'failed' && (
        !terminalFailed ||
        taskFailureAt > terminalFailedAt ||
        (task.last_error && task.last_error !== terminalError)
      );

      if (taskFailureIsNewer) {
        failedAt = taskFailureAt;
        lastError = task.last_error || 'Task failed';
        failed++;
      } else if (latest?.status === 'failed' || latest?.status === 'timeout') {
        failedAt = latest.completed_at ?? latest.executed_at;
        lastError = latest.error || task.last_error ||
          (latest.status === 'timeout' ? 'Task timed out' : 'Task failed');
        failed++;
      } else if (latest?.status === 'success') {
        failedAt = null;
        lastError = null;
        recovered++;
      } else if (task.last_error != null) {
        failedAt = task.failed_at ?? task.updated_at;
        if (task.status === 'failed' && !latest) failed++;
        else uncertain++;
      }

      if (failedAt !== task.failed_at || lastError !== task.last_error) {
        updateOutcome.run(failedAt, lastError, task.id);
      }
    }

    const afterTaskCount = db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count;
    const afterHistory = historyAggregates();
    if (afterTaskCount !== beforeTaskCount || JSON.stringify(afterHistory) !== JSON.stringify(beforeHistory)) {
      throw new Error('Run outcome migration changed task/history aggregates');
    }

    const unresolvedErrors = db.prepare(`
      SELECT COUNT(*) AS count FROM tasks
      WHERE last_error IS NOT NULL AND failed_at IS NULL
    `).get().count;
    const staleRecoverySignals = db.prepare(`
      SELECT COUNT(*) AS count
      FROM tasks
      WHERE status != 'failed'
        AND (failed_at IS NOT NULL OR last_error IS NOT NULL)
        AND id IN (
          SELECT h.task_id FROM task_history h
          WHERE h.id = (
            SELECT h2.id FROM task_history h2
            WHERE h2.task_id = h.task_id
            ORDER BY h2.id DESC LIMIT 1
          )
          AND h.status = 'success'
        )
    `).get().count;
    if (unresolvedErrors !== 0 || staleRecoverySignals !== 0) {
      throw new Error('Run outcome migration postcondition failed');
    }

    db.prepare(`
      INSERT INTO system_state (key, value, updated_at)
      VALUES (?, ?, ?)
    `).run(
      RUN_OUTCOME_MIGRATION_KEY,
      JSON.stringify({ tasks: beforeTaskCount, recovered, failed, uncertain }),
      now()
    );
  });

  migrate.immediate();
}

// Clean up old history entries (older than HISTORY_RETENTION_DAYS)
export function cleanupHistory() {
  const cutoff = Math.floor(Date.now() / 1000) - (HISTORY_RETENTION_DAYS * 24 * 60 * 60);
  const result = db.prepare('DELETE FROM task_history WHERE executed_at < ?').run(cutoff);
  return result.changes;
}

// Generate a unique task ID
export function generateId() {
  return 'task-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
}

// Get current Unix timestamp
export function now() {
  return Math.floor(Date.now() / 1000);
}
