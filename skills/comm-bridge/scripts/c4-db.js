#!/usr/bin/env node
/**
 * C4 Communication Bridge - Database Module
 * Provides database operations for message logging and checkpoint management
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DATA_DIR, DB_PATH, CONTROL_MAX_RETRIES } from './c4-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INIT_SQL_PATH = path.join(__dirname, '..', 'init-db.sql');

let db = null;

const CONTROL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS control_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  require_idle INTEGER DEFAULT 0,
  bypass_state INTEGER DEFAULT 0,
  ack_deadline_at INTEGER,
  status TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  available_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_control_queue_status_priority_time
  ON control_queue(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_control_queue_available_at
  ON control_queue(available_at);
CREATE INDEX IF NOT EXISTS idx_control_queue_ack_deadline
  ON control_queue(ack_deadline_at);
CREATE INDEX IF NOT EXISTS idx_control_queue_updated_at
  ON control_queue(updated_at);
`;

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
    ensureSchemaMigrations();
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

function ensureSchemaMigrations() {
  db.exec(CONTROL_SCHEMA_SQL);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
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
 * Atomically claim a pending conversation message to running
 * @param {number} id - conversation id
 * @returns {boolean}
 */
export function claimConversation(id) {
  const db = getDb();
  const result = db.prepare(`
    UPDATE conversations
    SET status = 'running'
    WHERE id = ? AND direction = 'in' AND status = 'pending'
  `).run(id);
  return result.changes > 0;
}

/**
 * Return a running message back to pending state
 * @param {number} id - conversation id
 */
export function requeueConversation(id) {
  const db = getDb();
  db.prepare(`
    UPDATE conversations
    SET status = 'pending'
    WHERE id = ? AND direction = 'in' AND status = 'running'
  `).run(id);
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
 * Get count of pending control items
 * @returns {number}
 */
export function getPendingControlCount() {
  const db = getDb();
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM control_queue
    WHERE status = 'pending'
  `).get();
  return result?.count || 0;
}

/**
 * Insert a control queue record
 * @param {string} content - instruction content
 * @param {object} options - queue options
 * @returns {object} inserted control record
 */
export function insertControl(content, options = {}) {
  const database = getDb();
  const {
    priority = 3,
    requireIdle = false,
    bypassState = false,
    ackDeadlineAt = null,
    availableAt = null
  } = options;

  const tx = database.transaction(() => {
    const current = nowSeconds();
    const insertStmt = database.prepare(`
      INSERT INTO control_queue (
        content, priority, require_idle, bypass_state, ack_deadline_at,
        status, retry_count, available_at, last_error, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)
    `);

    const result = insertStmt.run(
      content,
      priority,
      requireIdle ? 1 : 0,
      bypassState ? 1 : 0,
      ackDeadlineAt,
      availableAt,
      current,
      current
    );

    const id = Number(result.lastInsertRowid);
    let finalContent = content;

    if (content.includes('__CONTROL_ID__')) {
      finalContent = content.replaceAll('__CONTROL_ID__', String(id));
      database.prepare(`
        UPDATE control_queue
        SET content = ?, updated_at = ?
        WHERE id = ?
      `).run(finalContent, current, id);
    }

    return {
      id,
      content: finalContent,
      priority,
      require_idle: requireIdle ? 1 : 0,
      bypass_state: bypassState ? 1 : 0,
      ack_deadline_at: ackDeadlineAt,
      status: 'pending',
      retry_count: 0,
      available_at: availableAt,
      created_at: current,
      updated_at: current
    };
  });

  return tx();
}

/**
 * Get one control record by id
 * @param {number} id - control id
 * @returns {object|null}
 */
export function getControlById(id) {
  const database = getDb();
  return database.prepare(`
    SELECT id, content, priority, require_idle, bypass_state, ack_deadline_at,
           status, retry_count, available_at, last_error, created_at, updated_at
    FROM control_queue
    WHERE id = ?
  `).get(id) || null;
}

/**
 * Get next pending control item by priority/FIFO order
 * @param {number} current - unix seconds
 * @returns {object|null}
 */
export function getNextPendingControl(current = nowSeconds()) {
  const database = getDb();
  return database.prepare(`
    SELECT id, content, priority, require_idle, bypass_state, ack_deadline_at,
           status, retry_count, available_at, last_error, created_at, updated_at
    FROM control_queue
    WHERE status = 'pending'
      AND (available_at IS NULL OR available_at <= ?)
    ORDER BY COALESCE(priority, 3) ASC, created_at ASC
    LIMIT 1
  `).get(current) || null;
}

/**
 * Atomically claim a pending control item to running
 * @param {number} id - control id
 * @returns {boolean}
 */
export function claimControl(id) {
  const database = getDb();
  const result = database.prepare(`
    UPDATE control_queue
    SET status = 'running', updated_at = ?, last_error = NULL
    WHERE id = ? AND status = 'pending'
  `).run(nowSeconds(), id);
  return result.changes > 0;
}

/**
 * Return a running control record back to pending
 * @param {number} id - control id
 * @param {string|null} lastError - optional reason
 */
export function requeueControl(id, lastError = null) {
  const database = getDb();
  database.prepare(`
    UPDATE control_queue
    SET status = 'pending', updated_at = ?, last_error = COALESCE(?, last_error)
    WHERE id = ? AND status = 'running'
  `).run(nowSeconds(), lastError, id);
}

/**
 * Mark control as done via ack (idempotent for final states)
 * @param {number} id - control id
 * @returns {object} result
 */
export function ackControl(id) {
  const database = getDb();
  const tx = database.transaction((controlId) => {
    const row = database.prepare('SELECT status, ack_deadline_at FROM control_queue WHERE id = ?').get(controlId);
    if (!row) {
      return { found: false };
    }

    const current = nowSeconds();
    if (
      (row.status === 'pending' || row.status === 'running') &&
      row.ack_deadline_at !== null &&
      row.ack_deadline_at < current
    ) {
      database.prepare(`
        UPDATE control_queue
        SET status = 'timeout', updated_at = ?, last_error = COALESCE(last_error, 'ACK_DEADLINE_EXCEEDED')
        WHERE id = ?
      `).run(current, controlId);
      return { found: true, alreadyFinal: true, status: 'timeout' };
    }

    if (row.status === 'done' || row.status === 'failed' || row.status === 'timeout') {
      return { found: true, alreadyFinal: true, status: row.status };
    }

    database.prepare(`
      UPDATE control_queue
      SET status = 'done', updated_at = ?, last_error = NULL
      WHERE id = ? AND status IN ('pending', 'running')
    `).run(current, controlId);

    return { found: true, alreadyFinal: false, status: 'done' };
  });

  return tx(id);
}

/**
 * Retry control delivery, or mark as failed when retries exceed max
 * @param {number} id - control id
 * @param {string} lastError - failure reason
 * @param {number} maxRetries - max retries before failure
 * @returns {object|null} transition info
 */
export function retryOrFailControl(id, lastError, maxRetries = CONTROL_MAX_RETRIES) {
  const database = getDb();
  const tx = database.transaction((controlId, errorMsg, retries) => {
    const row = database.prepare(`
      SELECT retry_count, status
      FROM control_queue
      WHERE id = ?
    `).get(controlId);

    if (!row) {
      return null;
    }

    const nextRetryCount = (row.retry_count || 0) + 1;
    const current = nowSeconds();

    if (nextRetryCount >= retries) {
      database.prepare(`
        UPDATE control_queue
        SET status = 'failed', retry_count = ?, last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(nextRetryCount, errorMsg, current, controlId);
      return { status: 'failed', retry_count: nextRetryCount };
    }

    database.prepare(`
      UPDATE control_queue
      SET status = 'pending', retry_count = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(nextRetryCount, errorMsg, current, controlId);

    return { status: 'pending', retry_count: nextRetryCount };
  });

  return tx(id, lastError, maxRetries);
}

/**
 * Mark matching control records timeout based on ack deadline
 * @param {number} current - unix seconds
 * @returns {number} updated rows
 */
export function expireTimedOutControls(current = nowSeconds()) {
  const database = getDb();
  const result = database.prepare(`
    UPDATE control_queue
    SET status = 'timeout', updated_at = ?, last_error = COALESCE(last_error, 'ACK_DEADLINE_EXCEEDED')
    WHERE status IN ('pending', 'running')
      AND ack_deadline_at IS NOT NULL
      AND ack_deadline_at < ?
  `).run(current, current);
  return result.changes || 0;
}

/**
 * Cleanup final control records older than cutoff
 * @param {number} cutoff - unix seconds
 * @returns {number} deleted rows
 */
export function cleanupControlQueue(cutoff) {
  const database = getDb();
  const result = database.prepare(`
    DELETE FROM control_queue
    WHERE status IN ('done', 'failed', 'timeout')
      AND updated_at < ?
  `).run(cutoff);
  return result.changes || 0;
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
