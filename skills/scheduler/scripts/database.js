/**
 * Database Layer
 * SQLite-based persistence for tasks and execution history
 */

import Database from 'better-sqlite3';
import * as schema from './schema.js';
import { guardDatabase, assertCoreDatabaseAvailable } from '../../comm-bridge/scripts/sqlite-schema.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Data goes to ~/zylos/scheduler/, code stays in skills directory
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const DATA_DIR = path.join(ZYLOS_DIR, 'scheduler');
const DB_PATH = path.join(DATA_DIR, 'scheduler.db');
const HISTORY_RETENTION_DAYS = 30;

let db = null;

export function getDb() {
  assertCoreDatabaseAvailable(ZYLOS_DIR);
  if (!db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const connection = new Database(DB_PATH);
    try {
      guardDatabase(connection, schema);
      connection.pragma('journal_mode = WAL');
      db = connection;
    } catch (error) { connection.close(); throw error; }
  }
  return db;
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
