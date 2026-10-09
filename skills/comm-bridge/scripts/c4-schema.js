import { inspectLayout } from './sqlite-schema.js';
export const SUPPORTED_SCHEMA_VERSION = 1;
export const supportsNewDatabase = true;
export const TABLES = {
  "checkpoints": [
    "id",
    "timestamp",
    "summary",
    "start_conversation_id",
    "end_conversation_id"
  ],
  "conversations": [
    "id",
    "timestamp",
    "direction",
    "channel",
    "endpoint_id",
    "content",
    "status",
    "delivery_action",
    "priority",
    "require_idle",
    "retry_count"
  ],
  "control_queue": [
    "id",
    "raw_content",
    "content",
    "priority",
    "require_idle",
    "bypass_state",
    "ack_deadline_at",
    "status",
    "retry_count",
    "available_at",
    "last_error",
    "created_at",
    "updated_at"
  ],
  "status_notice_cooldowns": [
    "cooldown_key",
    "channel",
    "endpoint",
    "status_type",
    "reason",
    "last_notified_at",
    "expires_at",
    "updated_at"
  ]
};
export const COLUMN_DEFINITIONS = {"checkpoints": {"id": {"type": "INTEGER", "pk": true}, "timestamp": {"type": "DATETIME", "pk": false}, "summary": {"type": "TEXT", "pk": false}, "start_conversation_id": {"type": "INTEGER", "pk": false}, "end_conversation_id": {"type": "INTEGER", "pk": false}}, "conversations": {"id": {"type": "INTEGER", "pk": true}, "timestamp": {"type": "DATETIME", "pk": false}, "direction": {"type": "TEXT", "pk": false}, "channel": {"type": "TEXT", "pk": false}, "endpoint_id": {"type": "TEXT", "pk": false}, "content": {"type": "TEXT", "pk": false}, "status": {"type": "TEXT", "pk": false}, "delivery_action": {"type": "TEXT", "pk": false}, "priority": {"type": "INTEGER", "pk": false}, "require_idle": {"type": "INTEGER", "pk": false}, "retry_count": {"type": "INTEGER", "pk": false}}, "control_queue": {"id": {"type": "INTEGER", "pk": true}, "raw_content": {"type": "TEXT", "pk": false}, "content": {"type": "TEXT", "pk": false}, "priority": {"type": "INTEGER", "pk": false}, "require_idle": {"type": "INTEGER", "pk": false}, "bypass_state": {"type": "INTEGER", "pk": false}, "ack_deadline_at": {"type": "INTEGER", "pk": false}, "status": {"type": "TEXT", "pk": false}, "retry_count": {"type": "INTEGER", "pk": false}, "available_at": {"type": "INTEGER", "pk": false}, "last_error": {"type": "TEXT", "pk": false}, "created_at": {"type": "INTEGER", "pk": false}, "updated_at": {"type": "INTEGER", "pk": false}}, "status_notice_cooldowns": {"cooldown_key": {"type": "TEXT", "pk": true}, "channel": {"type": "TEXT", "pk": false}, "endpoint": {"type": "TEXT", "pk": false}, "status_type": {"type": "TEXT", "pk": false}, "reason": {"type": "TEXT", "pk": false}, "last_notified_at": {"type": "INTEGER", "pk": false}, "expires_at": {"type": "INTEGER", "pk": false}, "updated_at": {"type": "INTEGER", "pk": false}}};
export function inspectSchema(db, { allowNew = false } = {}) {
  return inspectLayout(db, 'c4', SUPPORTED_SCHEMA_VERSION, TABLES, { allowNew, definitions: COLUMN_DEFINITIONS, legacyOptional: { conversations: ['delivery_action'], control_queue: ['raw_content'], status_notice_cooldowns: true } });
}
