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

let db = null;

/**
 * Schema version — bump this when adding new migrations.
 */
const SCHEMA_VERSION = 1;

/**
 * Incremental migrations keyed by target version.
 * Each migration receives the db instance.
 */
const MIGRATIONS = {
  // v0 → v1: baseline — no changes needed, just marks existing schema as versioned
  1: (_database) => {
    // No-op: establishes version tracking for future migrations
  }
};

export function getDb() {
  if (!db) {
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');  // Better concurrent access
    initSchema();
    migrateSchema();
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
}

/**
 * Run incremental schema migrations from current user_version to SCHEMA_VERSION.
 */
function migrateSchema() {
  const current = db.pragma('user_version', { simple: true });
  if (current >= SCHEMA_VERSION) return;

  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    const migrate = MIGRATIONS[v];
    if (!migrate) {
      console.error(`[Scheduler-DB] Missing migration for version ${v}`);
      break;
    }
    db.transaction(() => {
      migrate(db);
      db.pragma(`user_version = ${v}`);
    })();
    console.log(`[Scheduler-DB] Migrated to schema version ${v}`);
  }
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
