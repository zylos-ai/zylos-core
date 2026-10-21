export const HEALTH_TABLES = {
  runtime_deliveries: {
    id: { type: 'INTEGER', pk: true }, conversation_id: { type: 'INTEGER', pk: false },
    runtime_id: { type: 'TEXT', pk: false }, runtime_generation: { type: 'TEXT', pk: false },
    session_id: { type: 'TEXT', pk: false }, process_start: { type: 'TEXT', pk: false },
    channel: { type: 'TEXT', pk: false }, endpoint: { type: 'TEXT', pk: false },
    status: { type: 'TEXT', pk: false }, started_at: { type: 'INTEGER', pk: false },
    submitted_at: { type: 'INTEGER', pk: false },
  },
  runtime_notice_intents: {
    event_id: { type: 'TEXT', pk: true }, runtime_id: { type: 'TEXT', pk: false },
    runtime_generation: { type: 'TEXT', pk: false }, session_id: { type: 'TEXT', pk: false },
    process_start: { type: 'TEXT', pk: false }, conversation_id: { type: 'INTEGER', pk: false },
    delivery_id: { type: 'INTEGER', pk: false },
    channel: { type: 'TEXT', pk: false }, endpoint: { type: 'TEXT', pk: false },
    health: { type: 'TEXT', pk: false }, reason: { type: 'TEXT', pk: false },
    notice_json: { type: 'TEXT', pk: false },
    health_episode: { type: 'TEXT', pk: false }, status: { type: 'TEXT', pk: false },
    claim_key: { type: 'TEXT', pk: false }, attempt_id: { type: 'TEXT', pk: false },
    created_at: { type: 'INTEGER', pk: false }, updated_at: { type: 'INTEGER', pk: false },
  },
  status_notice_attempts: {
    notice_key: { type: 'TEXT', pk: true }, attempt_id: { type: 'TEXT', pk: false },
    channel: { type: 'TEXT', pk: false }, endpoint: { type: 'TEXT', pk: false },
    normalized_endpoint: { type: 'TEXT', pk: false }, status: { type: 'TEXT', pk: false },
    claimed_at: { type: 'INTEGER', pk: false }, lease_until: { type: 'INTEGER', pk: false },
    updated_at: { type: 'INTEGER', pk: false },
  },
  runtime_health_events: {
    event_id: { type: 'TEXT', pk: true }, source: { type: 'TEXT', pk: false },
    runtime_generation: { type: 'TEXT', pk: false }, session_id: { type: 'TEXT', pk: false },
    prompt_id: { type: 'TEXT', pk: false }, received_at: { type: 'INTEGER', pk: false },
    payload_json: { type: 'TEXT', pk: false }, status: { type: 'TEXT', pk: false },
    reason: { type: 'TEXT', pk: false }, processed_at: { type: 'INTEGER', pk: false },
  },
  runtime_health_state: {
    runtime_id: { type: 'TEXT', pk: true }, revision: { type: 'INTEGER', pk: false },
    state_json: { type: 'TEXT', pk: false }, updated_at: { type: 'INTEGER', pk: false },
  },
};

export function migrateHealthNotices(database) {
  database.exec(`
    CREATE TABLE runtime_deliveries (
      id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL,
      runtime_id TEXT NOT NULL, runtime_generation TEXT NOT NULL, session_id TEXT NOT NULL,
      process_start TEXT NOT NULL, channel TEXT NOT NULL, endpoint TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('submitting','delivered','uncertain')),
      started_at INTEGER NOT NULL, submitted_at INTEGER
    );
    CREATE INDEX idx_runtime_deliveries_scope ON runtime_deliveries(runtime_id,runtime_generation,session_id,id);
    CREATE TABLE runtime_notice_intents (
      event_id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL, runtime_generation TEXT NOT NULL,
      session_id TEXT NOT NULL, process_start TEXT NOT NULL, conversation_id INTEGER NOT NULL, delivery_id INTEGER NOT NULL,
      channel TEXT NOT NULL, endpoint TEXT NOT NULL, health TEXT NOT NULL, reason TEXT NOT NULL, notice_json TEXT,
      health_episode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      claim_key TEXT, attempt_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_runtime_notice_intents_status ON runtime_notice_intents(status,created_at);
    CREATE TABLE status_notice_attempts (
      notice_key TEXT PRIMARY KEY, attempt_id TEXT NOT NULL,
      channel TEXT NOT NULL, endpoint TEXT NOT NULL, normalized_endpoint TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('claimed','sending','sent','failed','uncertain')),
      claimed_at INTEGER NOT NULL, lease_until INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE runtime_health_events (
      event_id TEXT PRIMARY KEY, source TEXT NOT NULL, runtime_generation TEXT,
      session_id TEXT, prompt_id TEXT, received_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reason TEXT, processed_at INTEGER
    );
    CREATE INDEX idx_runtime_health_events_status_received ON runtime_health_events(status, received_at);
    CREATE TABLE runtime_health_state (
      runtime_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0,
      state_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
}
