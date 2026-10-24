#!/usr/bin/env node
/**
 * C4 Communication Bridge - Database Module
 * Provides database operations for message logging and checkpoint management
 */

import Database from 'better-sqlite3';
import * as schema from './c4-schema.js';
import { guardDatabase, assertCoreDatabaseAvailable } from './sqlite-schema.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DATA_DIR, DB_PATH, CONTROL_MAX_RETRIES } from './c4-config.js';
import { normalizeStatusEndpoint } from './status-endpoint.js';
import { buildReplyViaSuffix, hasLegacyReplyViaSuffix, truncateForDelivery } from './c4-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export { migrateSchema, stripTrailingAckSuffix } from './c4-migrations.js';

let db = null;

import { createStore } from './c4-v2-store.js';
import { validateChannel } from './c4-validate.js';
import { loadCoreConfig, resolveCoreConfigModule } from './core-config-loader.js';
import { pathToFileURL } from 'node:url';
import { observeCoreTarget } from './c4-runtime-observer.js';
const coreConfig = await loadCoreConfig();
const runtimeCommand = await import(pathToFileURL(path.join(path.dirname(resolveCoreConfigModule()), 'runtime/session-command.js')).href);
export { composeSessionGroup, parseSessionGroup } from './c4-session-group.js';

const store = createStore(getDb, {
  validateComponent: name => validateChannel(name, true),
  readConfig: coreConfig.readZylosConfigStrict,
  resolveTarget: observeCoreTarget,
  validateModel: (runtime, pair) => {
    try {
      const command = runtimeCommand.runtimeExecutable(runtime);
      const help = runtimeCommand.runtimeHelp(command);
      return runtimeCommand.validateLaunchConfig(runtime, { runtime, mode: 'override', ...pair }, help);
    } catch (cause) {
      const error = new Error('Runtime rejected model/effort configuration');
      error.code = 'MODEL_CONFIG_INVALID'; error.cause = cause;
      throw error;
    }
  },
});


/**
 * Get database connection, initializing if needed
 */
export function getDb() {
  assertCoreDatabaseAvailable(path.dirname(DATA_DIR));
  if (!db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const connection = new Database(DB_PATH);
    try {
      guardDatabase(connection, schema);
      connection.pragma('journal_mode = WAL');
      connection.pragma('busy_timeout = 5000');
      connection.pragma('foreign_keys = ON');
      db = connection;
    } catch (error) { connection.close(); throw error; }
  }
  return db;
}

function nowSeconds() { return Math.floor(Date.now() / 1000); }

/**
 * Reserve or suppress an unhealthy/status notice cooldown.
 * Uses SQLite as the comm-bridge persistence/concurrency boundary so
 * concurrent c4-receive processes cannot both reserve the same cooldown key.
 */
export function reserveStatusNoticeCooldown({
  cooldownKey,
  channel,
  endpoint,
  statusType,
  reason,
  ttl,
  now = nowSeconds()
}) {
  const database = getDb();
  const expiresAt = now + ttl;

  const tx = database.transaction(() => {
    database.prepare('DELETE FROM status_notice_cooldowns WHERE expires_at <= ?').run(now);

    const insertResult = database.prepare(`
      INSERT OR IGNORE INTO status_notice_cooldowns (
        cooldown_key, channel, endpoint, status_type, reason,
        last_notified_at, expires_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(cooldownKey, channel, endpoint, statusType, reason, now, expiresAt, now);

    if (insertResult.changes === 1) {
      return { suppressed: false, key: cooldownKey, ttl, reservedAt: now, expiresAt };
    }

    const previous = database.prepare(`
      SELECT cooldown_key, channel, endpoint, status_type, reason,
             last_notified_at, expires_at, updated_at
      FROM status_notice_cooldowns
      WHERE cooldown_key = ?
    `).get(cooldownKey);

    return { suppressed: true, key: cooldownKey, ttl, previous };
  });

  return tx();
}

export function clearStatusNoticeCooldownReservation(cooldownKey, reservedAt) {
  const database = getDb();
  database.prepare(`
    DELETE FROM status_notice_cooldowns
    WHERE cooldown_key = ? AND last_notified_at = ?
  `).run(cooldownKey, reservedAt);
}

export function getStatusNoticeCooldowns() {
  const database = getDb();
  return database.prepare(`
    SELECT cooldown_key, channel, endpoint, status_type, reason,
           last_notified_at, expires_at, updated_at
    FROM status_notice_cooldowns
    ORDER BY cooldown_key ASC
  `).all();
}

// Reservation is the only resend authority. Unknown outcomes keep it until expiry.
export function claimStatusNotice({ key, channel, endpoint, normalizedEndpoint,
  health = 'unavailable', reason = 'unavailable', now = nowSeconds(), ttl = 600 }, database = getDb()) {
  return database.transaction(() => {
    database.prepare('DELETE FROM status_notice_cooldowns WHERE expires_at <= ?').run(now);
    const previous = database.prepare('SELECT * FROM status_notice_cooldowns WHERE channel=? AND status_type=? AND reason=? AND expires_at>?')
      .all(channel, health, reason, now).find(row => normalizeStatusEndpoint(row.endpoint) === normalizedEndpoint);
    if (previous) return { suppressed: true, reason: 'cooldown', previous };
    // Fractional timestamp distinguishes replacement reservations created in the same second.
    const reservedAt = now + Math.random() / 1000;
    database.prepare(`INSERT INTO status_notice_cooldowns
      (cooldown_key,channel,endpoint,status_type,reason,last_notified_at,expires_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(key, channel, normalizedEndpoint, health, reason, reservedAt, now + ttl, now);
    return { suppressed: false, key, channel, endpoint, normalizedEndpoint, health, reason,
      reservedAt, expiresAt: now + ttl };
  }).immediate();
}

export function startStatusNotice(claim, now = nowSeconds(), database = getDb()) {
  return Boolean(database.prepare(`SELECT 1 FROM status_notice_cooldowns
    WHERE cooldown_key=? AND last_notified_at=? AND expires_at>?`).get(claim.key, claim.reservedAt, now));
}

export function finishStatusNotice(claim, outcome, { now = nowSeconds(), ttl = 600 } = {}, database = getDb()) {
  if (!['sent', 'failed', 'uncertain'].includes(outcome)) throw new Error('Invalid notice outcome');
  if (outcome === 'failed') return database.prepare(`DELETE FROM status_notice_cooldowns
    WHERE cooldown_key=? AND last_notified_at=?`).run(claim.key, claim.reservedAt).changes === 1;
  if (outcome === 'uncertain') return database.prepare(`UPDATE status_notice_cooldowns SET updated_at=?
    WHERE cooldown_key=? AND last_notified_at=?`).run(now, claim.key, claim.reservedAt).changes === 1;
  return database.prepare(`UPDATE status_notice_cooldowns SET expires_at=MAX(expires_at,?),updated_at=?
    WHERE cooldown_key=? AND last_notified_at=?`).run(now + ttl, now, claim.key, claim.reservedAt).changes === 1;
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
 * Get one control record by id
 * @param {number} id - control id
 * @returns {object|null}
 */
export function getControlById(id) {
  const database = getDb();
  return database.prepare(`
    SELECT id, raw_content, content, priority, require_idle, bypass_state, ack_deadline_at,
           status, retry_count, available_at, last_error, created_at, updated_at,
           session_group, target_binding
    FROM control_queue
    WHERE id = ?
  `).get(id) || null;
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

    if (row.status === 'done' || row.status === 'failed' || row.status === 'timeout' || row.status === 'superseded') {
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
    WHERE status IN ('done', 'failed', 'timeout', 'superseded')
      AND updated_at < ?
  `).run(cutoff);
  return result.changes || 0;
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
 * @returns {array} - latest N conversation records in chronological order
 */
export function getRecentConversations(limit = 20) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM (SELECT * FROM conversations ORDER BY timestamp DESC, id DESC LIMIT ?) ORDER BY timestamp ASC, id ASC'
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
 * Format conversation records for agent-facing context. Unlike
 * formatConversations(), this adds reply routing only while each original
 * record is still available, never by post-processing the flattened output.
 * @param {array} conversations - array of conversation records
 * @param {object} [options]
 * @param {boolean} [options.spill=true] - when true, messages over the
 *   per-message delivery threshold are replaced by a preview + attachment
 *   pointer (dispatch-style). Pass false when a caller has its own size
 *   control (e.g. the session-start shard's whole-message budget packer)
 *   and wants original content inline (#724).
 * @returns {string} - formatted text for agent delivery/session init
 */
export function formatConversationsForAgent(conversations, { spill = true } = {}) {
  if (!conversations || conversations.length === 0) {
    return '';
  }

  const lines = [];
  for (const conv of conversations) {
    const dir = conv.direction === 'in' ? 'IN' : 'OUT';
    const endpoint = conv.endpoint_id ? `:${conv.endpoint_id}` : '';
    const content = conv.content || '';
    const replyViaSuffix = (
      conv.direction === 'in' &&
      conv.endpoint_id &&
      !hasLegacyReplyViaSuffix(content)
    ) ? buildReplyViaSuffix(conv.channel, conv.endpoint_id) : '';
    lines.push(`[${conv.timestamp}] ${dir} (${conv.channel}${endpoint}):`);
    lines.push(spill
      ? truncateForDelivery(content, replyViaSuffix, conv.id)
      : content + replyViaSuffix);
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

export const getChannelNamespace = (...args) => store.getChannelNamespace(...args);
export const getComponentByNamespace = (...args) => store.getComponentByNamespace(...args);
export const ensureChannelNamespace = (...args) => store.ensureChannelNamespace(...args);
export const registerChannelNamespace = (...args) => store.registerChannelNamespace(...args);
export const resolveSessionGroup = (...args) => store.resolveSessionGroup(...args);
export const insertConversation = (...args) => store.insertConversation(...args);
export const insertInternalMessage = (...args) => store.insertInternalMessage(...args);
export const buildTargetBinding = async (...args) => await store.buildTargetBinding(...args);
export const getNextPending = (...args) => store.getNextPending(...args);
export const claimConversation = (...args) => store.claimConversation(...args);
export const requeueConversation = (...args) => store.requeueConversation(...args);
export const markDelivered = (...args) => store.markDelivered(...args);
export const expirePending = (...args) => store.expirePending(...args);
export const failDelivery = (...args) => store.failDelivery(...args);
export const recoverOrphanRunning = (...args) => store.recoverOrphanRunning(...args);
export const listPendingSessionGroups = (...args) => store.listPendingSessionGroups(...args);
export const countRunningConversations = (...args) => store.countRunningConversations(...args);
export const countGlobalRunningConversations = (...args) => store.countGlobalRunningConversations(...args);
export const hasOutboundAfter = (...args) => store.hasOutboundAfter(...args);
export const getLastActivity = (...args) => store.getLastActivity(...args);
export const markStatusNoticeSuppressed = (...args) => store.markStatusNoticeSuppressed(...args);
export const getSessionModelConfig = (...args) => store.getSessionModelConfig(...args);
export const setSessionModelConfig = (...args) => store.setSessionModelConfig(...args);
export const resetSessionModelConfig = (...args) => store.resetSessionModelConfig(...args);
export const getSessionRuntimeConfig = (...args) => store.getSessionRuntimeConfig(...args);
export const setSessionRuntimeConfig = (...args) => store.setSessionRuntimeConfig(...args);
export const resetSessionRuntimeConfig = (...args) => store.resetSessionRuntimeConfig(...args);
export const resolveSessionLaunchConfig = (...args) => store.resolveSessionLaunchConfig(...args);
export const listGroupRuntimeOverrides = (...args) => store.listGroupRuntimeOverrides(...args);
export const legacyBaselineEnd = (...args) => store.legacyBaselineEnd(...args);
export const getCoverageEnd = (...args) => store.getCoverageEnd(...args);
export const getGlobalCoverageEnd = (...args) => store.getGlobalCoverageEnd(...args);
export const getDeliveredFrontier = (...args) => store.getDeliveredFrontier(...args);
export const getGlobalDeliveredFrontier = (...args) => store.getGlobalDeliveredFrontier(...args);
export const createCheckpoint = (...args) => store.createCheckpoint(...args);
export const getLatestContentCheckpoint = (...args) => store.getLatestContentCheckpoint(...args);
export const getDeliveredSince = (...args) => store.getDeliveredSince(...args);
export const getGlobalDeliveredSince = (...args) => store.getGlobalDeliveredSince(...args);
export const getUnsummarizedRange = (...args) => store.getUnsummarizedRange(...args);
export const getGlobalUnsummarizedRange = (...args) => store.getGlobalUnsummarizedRange(...args);
export const getUnsummarizedConversations = (...args) => store.getUnsummarizedConversations(...args);
export const getGlobalUnsummarizedConversations = (...args) => store.getGlobalUnsummarizedConversations(...args);
export const getContentCheckpointsSince = (...args) => store.getContentCheckpointsSince(...args);
export const getOriginSyncConversations = (...args) => store.getOriginSyncConversations(...args);
export const advanceOriginSyncCursor = (...args) => store.advanceOriginSyncCursor(...args);
export const getOriginSyncBacklog = (...args) => store.getOriginSyncBacklog(...args);
export const insertControl = (...args) => store.insertControl(...args);
export const getNextPendingControl = (...args) => store.getNextPendingControl(...args);
export const claimControl = (...args) => store.claimControl(...args);
export const expirePendingControls = (...args) => store.expirePendingControls(...args);
export const expireStaleRunningControls = (...args) => store.expireStaleRunningControls(...args);
export const countNonTerminalControls = (...args) => store.countNonTerminalControls(...args);
export const expireControlById = (...args) => store.expireControlById(...args);
export const setDrainFence = (...args) => store.setDrainFence(...args);
export const getDrainFence = (...args) => store.getDrainFence(...args);
export const listDrainFences = (...args) => store.listDrainFences(...args);
export const clearDrainFence = (...args) => store.clearDrainFence(...args);
export const beginModeTransition = (...args) => store.beginModeTransition(...args);
export const getLastCompletedModeTransition = (...args) => store.getLastCompletedModeTransition(...args);
export const listGroupHeads = (...args) => store.listGroupHeads(...args);
export const absorbForTransition = (...args) => store.absorbForTransition(...args);
export const setModeTransitionPhase = (...args) => store.setModeTransitionPhase(...args);
export const getAbsorbedConversations = (...args) => store.getAbsorbedConversations(...args);
export const getModeTransition = (options = {}) => store.getModeTransition(options);
export const auditCheckpoints = () => store.auditCheckpoints();

// CLI mode: import after the facade has initialized to avoid a module cycle.
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  import('./c4-public-cli.js').then(({ runCli }) => runCli('database', process.argv.slice(2)));
}
