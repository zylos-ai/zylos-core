import { inspectLayout } from '../../comm-bridge/scripts/sqlite-schema.js';
export const SUPPORTED_SCHEMA_VERSION = 1;
export const supportsNewDatabase = true;
export const TABLES = {
  "tasks": [
    "id",
    "name",
    "description",
    "prompt",
    "type",
    "cron_expression",
    "interval_seconds",
    "timezone",
    "next_run_at",
    "last_run_at",
    "priority",
    "status",
    "require_idle",
    "miss_threshold",
    "reply_channel",
    "reply_endpoint",
    "retry_count",
    "max_retries",
    "created_at",
    "updated_at",
    "last_error",
    "failed_at"
  ],
  "task_history": [
    "id",
    "task_id",
    "executed_at",
    "completed_at",
    "status",
    "duration_ms",
    "error"
  ],
  "system_state": [
    "key",
    "value",
    "updated_at"
  ]
};
export const COLUMN_DEFINITIONS = {"tasks": {"id": {"type": "TEXT", "pk": true}, "name": {"type": "TEXT", "pk": false}, "description": {"type": "TEXT", "pk": false}, "prompt": {"type": "TEXT", "pk": false}, "type": {"type": "TEXT", "pk": false}, "cron_expression": {"type": "TEXT", "pk": false}, "interval_seconds": {"type": "INTEGER", "pk": false}, "timezone": {"type": "TEXT", "pk": false}, "next_run_at": {"type": "INTEGER", "pk": false}, "last_run_at": {"type": "INTEGER", "pk": false}, "priority": {"type": "INTEGER", "pk": false}, "status": {"type": "TEXT", "pk": false}, "require_idle": {"type": "INTEGER", "pk": false}, "miss_threshold": {"type": "INTEGER", "pk": false}, "reply_channel": {"type": "TEXT", "pk": false}, "reply_endpoint": {"type": "TEXT", "pk": false}, "retry_count": {"type": "INTEGER", "pk": false}, "max_retries": {"type": "INTEGER", "pk": false}, "created_at": {"type": "INTEGER", "pk": false}, "updated_at": {"type": "INTEGER", "pk": false}, "last_error": {"type": "TEXT", "pk": false}, "failed_at": {"type": "INTEGER", "pk": false}}, "task_history": {"id": {"type": "INTEGER", "pk": true}, "task_id": {"type": "TEXT", "pk": false}, "executed_at": {"type": "INTEGER", "pk": false}, "completed_at": {"type": "INTEGER", "pk": false}, "status": {"type": "TEXT", "pk": false}, "duration_ms": {"type": "INTEGER", "pk": false}, "error": {"type": "TEXT", "pk": false}}, "system_state": {"key": {"type": "TEXT", "pk": true}, "value": {"type": "TEXT", "pk": false}, "updated_at": {"type": "INTEGER", "pk": false}}};
export function inspectSchema(db, { allowNew = false } = {}) {
  return inspectLayout(db, 'scheduler', SUPPORTED_SCHEMA_VERSION, TABLES, { allowNew, definitions: COLUMN_DEFINITIONS, legacyOptional: {} });
}
