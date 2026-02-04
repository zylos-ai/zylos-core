#!/usr/bin/env node
/**
 * C4 Communication Bridge - Database Module
 * Provides database operations for message logging and checkpoint management
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Data goes to ~/zylos/comm-bridge/, code stays in skills directory
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const DATA_DIR = path.join(ZYLOS_DIR, 'comm-bridge');
const DB_PATH = path.join(DATA_DIR, 'c4.db');
const INIT_SQL_PATH = path.join(__dirname, 'init-db.sql');

let db = null;

/**
 * Get database connection, initializing if needed
 */
export function getDb() {
  if (!db) {
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const isNew = !fs.existsSync(DB_PATH);
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');  // Better concurrent access

    if (isNew) {
      initSchema();
    } else {
      // Run migrations for existing databases
      runMigrations();
    }
  }
  return db;
}

/**
 * Initialize database schema from init-db.sql
 */
function initSchema() {
  const initSql = fs.readFileSync(INIT_SQL_PATH, 'utf8');
  db.exec(initSql);
  console.log('[C4-DB] Database initialized');
}

/**
 * Run migrations for existing databases
 */
function runMigrations() {
  // Check if conversations table exists
  const tableInfo = db.prepare("PRAGMA table_info(conversations)").all();

  // If table doesn't exist, initialize schema
  if (tableInfo.length === 0) {
    console.log('[C4-DB] Conversations table missing, initializing schema');
    initSchema();
    return;
  }

  // Migration 1: Add status column
  const hasStatus = tableInfo.some(col => col.name === 'status');
  if (!hasStatus) {
    console.log('[C4-DB] Running migration: adding status column');
    db.exec(`
      ALTER TABLE conversations ADD COLUMN status TEXT DEFAULT 'delivered';
      CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
    `);
    console.log('[C4-DB] Migration 1 complete');
  }

  // Migration 2: Add priority column
  const hasPriority = tableInfo.some(col => col.name === 'priority');
  if (!hasPriority) {
    console.log('[C4-DB] Running migration: adding priority column');
    db.exec(`
      ALTER TABLE conversations ADD COLUMN priority INTEGER DEFAULT 3;
      UPDATE conversations SET priority = 3 WHERE priority IS NULL;
      CREATE INDEX IF NOT EXISTS idx_conversations_priority ON conversations(priority);
    `);
    console.log('[C4-DB] Migration 2 complete');
  }
}

/**
 * Insert a conversation record
 * @param {string} direction - 'in' or 'out'
 * @param {string} source - 'telegram', 'lark', 'scheduler', 'system', etc.
 * @param {string|null} endpointId - chat_id or null
 * @param {string} content - message content
 * @param {string} status - 'pending' or 'delivered' (default: 'pending' for in, 'delivered' for out)
 * @param {number} priority - 1=system/idle-required, 2=urgent-user, 3=normal-user (default: 3)
 * @returns {object} - inserted record with id
 */
export function insertConversation(direction, source, endpointId, content, status = null, priority = 3) {
  const db = getDb();

  // Get current checkpoint
  const checkpoint = db.prepare(
    'SELECT id FROM checkpoints ORDER BY id DESC LIMIT 1'
  ).get();

  // Default status: 'pending' for incoming, 'delivered' for outgoing
  const finalStatus = status || (direction === 'in' ? 'pending' : 'delivered');

  const stmt = db.prepare(`
    INSERT INTO conversations (direction, source, endpoint_id, content, status, priority, checkpoint_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(direction, source, endpointId, content, finalStatus, priority, checkpoint?.id || null);

  return {
    id: result.lastInsertRowid,
    direction,
    source,
    endpoint_id: endpointId,
    content,
    status: finalStatus,
    priority,
    checkpoint_id: checkpoint?.id || null
  };
}

/**
 * Get next pending message from queue (priority-based, then FIFO)
 * @returns {object|null} - highest priority pending message or null
 */
export function getNextPending() {
  const db = getDb();
  return db.prepare(`
    SELECT id, direction, source, endpoint_id, content, timestamp, priority
    FROM conversations
    WHERE direction = 'in' AND status = 'pending'
    ORDER BY COALESCE(priority, 3) ASC, timestamp ASC
    LIMIT 1
  `).get() || null;
}

/**
 * Mark a message as delivered
 * @param {number} id - message id
 */
export function markDelivered(id) {
  const db = getDb();
  db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('delivered', id);
}

/**
 * Get count of pending messages
 * @returns {number}
 */
export function getPendingCount() {
  const db = getDb();
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM conversations
    WHERE direction = 'in' AND status = 'pending'
  `).get();
  return result?.count || 0;
}

/**
 * Create a checkpoint
 * @param {string} type - 'memory_sync', 'session_start', or 'manual'
 * @returns {object} - checkpoint record with id
 */
export function createCheckpoint(type) {
  const db = getDb();

  const stmt = db.prepare('INSERT INTO checkpoints (type) VALUES (?)');
  const result = stmt.run(type);

  return {
    id: result.lastInsertRowid,
    type,
    timestamp: new Date().toISOString()
  };
}

/**
 * Get conversations since last checkpoint
 * @returns {array} - array of conversation records
 */
export function getConversationsSinceLastCheckpoint() {
  const db = getDb();

  // Get timestamp of the last checkpoint
  const lastCheckpoint = db.prepare(
    'SELECT timestamp FROM checkpoints ORDER BY timestamp DESC LIMIT 1'
  ).get();

  if (!lastCheckpoint) {
    // No checkpoint, return all conversations
    return db.prepare(
      'SELECT * FROM conversations ORDER BY timestamp'
    ).all();
  }

  // Get all conversations after the checkpoint
  const conversations = db.prepare(`
    SELECT * FROM conversations
    WHERE timestamp > ?
    ORDER BY timestamp
  `).all(lastCheckpoint.timestamp);

  return conversations;
}

/**
 * Get recent conversations (for debugging/testing)
 * @param {number} limit - max records to return
 * @returns {array} - array of conversation records
 */
export function getRecentConversations(limit = 20) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM conversations ORDER BY timestamp DESC LIMIT ?'
  ).all(limit);
}

/**
 * Get all checkpoints
 * @returns {array} - array of checkpoint records
 */
export function getCheckpoints() {
  const db = getDb();
  return db.prepare('SELECT * FROM checkpoints ORDER BY timestamp DESC').all();
}

/**
 * Format conversations for session recovery
 * @param {array} conversations - array of conversation records
 * @returns {string} - formatted text for Claude context injection
 */
export function formatForRecovery(conversations) {
  if (!conversations || conversations.length === 0) {
    return '';
  }

  const lines = ['[Session Recovery] The following conversations occurred before the crash:\n'];

  for (const conv of conversations) {
    const dir = conv.direction === 'in' ? 'IN' : 'OUT';
    const endpoint = conv.endpoint_id ? `:${conv.endpoint_id}` : '';
    lines.push(`[${conv.timestamp}] ${dir} (${conv.source}${endpoint}):`);
    lines.push(conv.content);
    lines.push('');
  }

  lines.push('Please continue the previous conversation.');

  return lines.join('\n');
}

/**
 * Close database connection
 */
export function close() {
  if (db) {
    db.close();
    db = null;
  }
}

// CLI mode
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'init':
      getDb();
      console.log('Database initialized at:', DB_PATH);
      break;

    case 'insert':
      // insert <direction> <source> <endpoint_id> <content>
      if (args.length < 5) {
        console.error('Usage: c4-db.js insert <direction> <source> <endpoint_id> <content>');
        process.exit(1);
      }
      const record = insertConversation(args[1], args[2], args[3] === 'null' ? null : args[3], args[4]);
      console.log('Inserted:', JSON.stringify(record));
      break;

    case 'checkpoint':
      // checkpoint <type>
      const type = args[1] || 'manual';
      const cp = createCheckpoint(type);
      console.log('Checkpoint created:', JSON.stringify(cp));
      break;

    case 'recover':
      const convs = getConversationsSinceLastCheckpoint();
      if (convs.length === 0) {
        console.log('No conversations since last checkpoint.');
      } else {
        console.log(formatForRecovery(convs));
      }
      break;

    case 'recent':
      const limit = parseInt(args[1]) || 20;
      const recent = getRecentConversations(limit);
      console.log(JSON.stringify(recent, null, 2));
      break;

    case 'checkpoints':
      const cps = getCheckpoints();
      console.log(JSON.stringify(cps, null, 2));
      break;

    default:
      console.log(`C4 Database CLI

Usage: c4-db.js <command> [args]

Commands:
  init                                  Initialize database
  insert <dir> <source> <endpoint> <content>  Insert conversation
  checkpoint [type]                     Create checkpoint (default: manual)
  recover                               Get conversations since last checkpoint
  recent [limit]                        Get recent conversations
  checkpoints                           List all checkpoints
`);
  }

  close();
}
