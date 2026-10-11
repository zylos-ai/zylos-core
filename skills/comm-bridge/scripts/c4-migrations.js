import fs from 'node:fs';
const INIT_SQL_PATH = new URL('../init-db.sql', import.meta.url);

export function migrateSchema(database, { isNew }) {
  if (isNew) database.exec(fs.readFileSync(INIT_SQL_PATH, 'utf8'));
  ensureConversationsSchema(database);
  ensureControlQueueSchema(database);
  ensureStatusNoticeCooldownSchema(database);
  ensureVoidChannelMigration(database);
}

export function stripTrailingAckSuffix(content) {
  if (typeof content !== 'string') return content;
  return content.replace(/\s---- ack via: node .+ ack --id \d+$/, '');
}

function ensureControlQueueSchema(database) {
  const columns = database.prepare('PRAGMA table_info(control_queue)').all();
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has('raw_content')) {
    database.exec('ALTER TABLE control_queue ADD COLUMN raw_content TEXT');
  }

  const rows = database.prepare(`
    SELECT id, content
    FROM control_queue
    WHERE raw_content IS NULL
  `).all();

  const updateRawContent = database.prepare(`
    UPDATE control_queue
    SET raw_content = ?
    WHERE id = ?
  `);

  const tx = database.transaction((pendingRows) => {
    for (const row of pendingRows) {
      updateRawContent.run(stripTrailingAckSuffix(row.content), row.id);
    }
  });

  tx(rows);
}

function getColumnNames(database, tableName) {
  return new Set(database.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name));
}

function ensureConversationsSchema(database) {
  const columnNames = getColumnNames(database, 'conversations');
  if (!columnNames.has('delivery_action')) {
    database.exec('ALTER TABLE conversations ADD COLUMN delivery_action TEXT');
  }
}

/**
 * #689: session-handoff summaries used to be piggybacked on the web-console
 * channel (channel='web-console', endpoint_id='session-handoff'). They now
 * live on the internal record-only 'void' channel; re-tag existing rows so
 * display surfaces no longer need endpoint-name special cases. Idempotent —
 * once re-tagged, no rows match.
 */
function ensureVoidChannelMigration(database) {
  database.prepare(`
    UPDATE conversations
    SET channel = 'void'
    WHERE channel = 'web-console' AND endpoint_id = 'session-handoff'
  `).run();
}

function ensureStatusNoticeCooldownSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS status_notice_cooldowns (
      cooldown_key TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      status_type TEXT NOT NULL,
      reason TEXT NOT NULL,
      last_notified_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_status_notice_cooldowns_expires_at
      ON status_notice_cooldowns(expires_at);
  `);
}
