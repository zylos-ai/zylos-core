#!/usr/bin/env node
/**
 * C4 Communication Bridge - Database Module
 * Provides database operations for message logging and checkpoint management
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DATA_DIR, DB_PATH } from './c4-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INIT_SQL_PATH = path.join(__dirname, '..', 'init-db.sql');

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
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');

    if (isNew) {
      initSchema();
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
 * Insert a conversation record
 * @param {string} direction - 'in' or 'out'
 * @param {string} channel - 'telegram', 'lark', 'scheduler', 'system', etc.
 * @param {string|null} endpointId - chat_id or null
 * @param {string} content - message content
 * @param {string} status - 'pending' or 'delivered' (default: 'pending' for in, 'delivered' for out)
 * @param {number} priority - 1=urgent, 2=high, 3=normal (default: 3)
 * @param {boolean} requireIdle - whether to wait for Claude idle state (default: false)
 * @returns {object} - inserted record with id
 */
export function insertConversation(direction, channel, endpointId, content, status = null, priority = 3, requireIdle = false) {
  const db = getDb();

  // Default status: 'pending' for incoming, 'delivered' for outgoing
  const finalStatus = status || (direction === 'in' ? 'pending' : 'delivered');

  const requireIdleVal = requireIdle ? 1 : 0;

  const stmt = db.prepare(`
    INSERT INTO conversations (direction, channel, endpoint_id, content, status, priority, require_idle)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(direction, channel, endpointId, content, finalStatus, priority, requireIdleVal);

  return {
    id: result.lastInsertRowid,
    direction,
    channel,
    endpoint_id: endpointId,
    content,
    status: finalStatus,
    priority,
    require_idle: requireIdleVal,
    retry_count: 0
  };
}

/**
 * Get next pending message from queue (priority-based, then FIFO)
 * @returns {object|null} - highest priority pending message or null
 */
export function getNextPending() {
  const db = getDb();
  return db.prepare(`
    SELECT id, direction, channel, endpoint_id, content, timestamp, priority, require_idle, retry_count
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
 * Increment retry count for a message
 * @param {number} id - message id
 * @returns {number} - new retry count
 */
export function incrementRetryCount(id) {
  const db = getDb();
  db.prepare('UPDATE conversations SET retry_count = COALESCE(retry_count, 0) + 1 WHERE id = ?').run(id);
  const row = db.prepare('SELECT retry_count FROM conversations WHERE id = ?').get(id);
  return row?.retry_count || 0;
}

/**
 * Mark a message as failed
 * @param {number} id - message id
 */
export function markFailed(id) {
  const db = getDb();
  db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run('failed', id);
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
 * @param {number} endConversationId - last conversation id covered by this checkpoint (caller determines the boundary)
 * @param {string|null} summary - checkpoint summary
 * @returns {object} - checkpoint record with id, start/end conversation ids
 */
export function createCheckpoint(endConversationId, summary = null) {
  const db = getDb();

  // start = previous checkpoint's end + 1 (or 1 if first checkpoint)
  const prevCheckpoint = db.prepare(
    'SELECT end_conversation_id FROM checkpoints ORDER BY id DESC LIMIT 1'
  ).get();

  const startId = prevCheckpoint ? (prevCheckpoint.end_conversation_id || 0) + 1 : 1;

  const stmt = db.prepare('INSERT INTO checkpoints (summary, start_conversation_id, end_conversation_id) VALUES (?, ?, ?)');
  const result = stmt.run(summary, startId, endConversationId);

  return {
    id: result.lastInsertRowid,
    start_conversation_id: startId,
    end_conversation_id: endConversationId,
    timestamp: new Date().toISOString()
  };
}

/**
 * Get the most recent checkpoint
 * @returns {object|null} - checkpoint record or null
 */
export function getLastCheckpoint() {
  const db = getDb();
  return db.prepare(
    'SELECT id, timestamp, summary, start_conversation_id, end_conversation_id FROM checkpoints ORDER BY id DESC LIMIT 1'
  ).get() || null;
}

/**
 * Get range and count of unsummarized conversations (after last checkpoint)
 * @returns {object} - { begin_id, end_id, count }
 */
export function getUnsummarizedRange() {
  const db = getDb();
  const lastCheckpoint = db.prepare(
    'SELECT end_conversation_id FROM checkpoints ORDER BY id DESC LIMIT 1'
  ).get();
  const afterId = lastCheckpoint?.end_conversation_id || 0;
  const result = db.prepare(
    'SELECT MIN(id) as begin_id, MAX(id) as end_id, COUNT(*) as count FROM conversations WHERE id > ?'
  ).get(afterId);
  return {
    begin_id: result?.begin_id || null,
    end_id: result?.end_id || null,
    count: result?.count || 0
  };
}

/**
 * Get unsummarized conversations (after last checkpoint)
 * @param {number|null} limit - if set, return only the most recent N records
 * @returns {array} - conversation records in chronological order
 */
export function getUnsummarizedConversations(limit = null) {
  const db = getDb();
  const lastCheckpoint = db.prepare(
    'SELECT end_conversation_id FROM checkpoints ORDER BY id DESC LIMIT 1'
  ).get();
  const afterId = lastCheckpoint?.end_conversation_id || 0;

  if (limit) {
    return db.prepare(
      'SELECT * FROM (SELECT * FROM conversations WHERE id > ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC'
    ).all(afterId, limit);
  }

  return db.prepare(
    'SELECT * FROM conversations WHERE id > ? ORDER BY id ASC'
  ).all(afterId);
}

/**
 * Get conversations by id range (inclusive)
 * @param {number} beginId - start conversation id
 * @param {number} endId - end conversation id
 * @returns {array} - conversation records in chronological order
 */
export function getConversationsByRange(beginId, endId) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM conversations WHERE id >= ? AND id <= ? ORDER BY id ASC'
  ).all(beginId, endId);
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
 * Format conversation records into readable text
 * @param {array} conversations - array of conversation records
 * @returns {string} - formatted text
 */
export function formatConversations(conversations) {
  if (!conversations || conversations.length === 0) {
    return '';
  }

  const lines = [];
  for (const conv of conversations) {
    const dir = conv.direction === 'in' ? 'IN' : 'OUT';
    const endpoint = conv.endpoint_id ? `:${conv.endpoint_id}` : '';
    lines.push(`[${conv.timestamp}] ${dir} (${conv.channel}${endpoint}):`);
    lines.push(conv.content);
    lines.push('');
  }

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
      // insert <direction> <channel> <endpoint_id> <content>
      if (args.length < 5) {
        console.error('Usage: c4-db.js insert <direction> <channel> <endpoint_id> <content>');
        process.exit(1);
      }
      const record = insertConversation(args[1], args[2], args[3] === 'null' ? null : args[3], args[4]);
      console.log('Inserted:', JSON.stringify(record));
      break;

    case 'checkpoint':
      // checkpoint <end_conversation_id> [summary]
      if (args.length < 2) {
        console.error('Usage: c4-db.js checkpoint <end_conversation_id> [summary]');
        process.exit(1);
      }
      const cpEndId = parseInt(args[1]);
      if (isNaN(cpEndId)) {
        console.error('end_conversation_id must be a number');
        process.exit(1);
      }
      const cpSummary = args[2] || null;
      const cp = createCheckpoint(cpEndId, cpSummary);
      console.log('Checkpoint created:', JSON.stringify(cp));
      break;

    case 'unsummarized':
      const range = getUnsummarizedRange();
      console.log(JSON.stringify(range, null, 2));
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
  insert <dir> <channel> <endpoint> <content>  Insert conversation
  checkpoint <end_id> [summary]          Create checkpoint up to conversation id
  unsummarized                          Show unsummarized conversation range and count
  recent [limit]                        Get recent conversations
  checkpoints                           List all checkpoints
`);
  }

  close();
}
