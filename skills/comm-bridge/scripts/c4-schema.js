import { migrateSchema } from './c4-migrations.js';
import { migrateToV2 } from './c4-migrations-v2.js';
import { inspectLayout } from './sqlite-schema.js';
import { rejectLegacySchemaProbe } from './upgrade-admission.js';

rejectLegacySchemaProbe();

export const SUPPORTED_SCHEMA_VERSION = 2;
export const supportsNewDatabase = true;

export const COLUMN_DEFINITIONS = {
  checkpoints: {
    id: { type: 'INTEGER', pk: true },
    timestamp: { type: 'DATETIME', pk: false },
    summary: { type: 'TEXT', pk: false },
    start_conversation_id: { type: 'INTEGER', pk: false },
    end_conversation_id: { type: 'INTEGER', pk: false },
    session_group: { type: 'TEXT', pk: false },
    no_content: { type: 'INTEGER', pk: false }
  },
  conversations: {
    id: { type: 'INTEGER', pk: true },
    timestamp: { type: 'DATETIME', pk: false },
    direction: { type: 'TEXT', pk: false },
    channel: { type: 'TEXT', pk: false },
    endpoint_id: { type: 'TEXT', pk: false },
    content: { type: 'TEXT', pk: false },
    status: { type: 'TEXT', pk: false },
    delivery_action: { type: 'TEXT', pk: false },
    priority: { type: 'INTEGER', pk: false },
    require_idle: { type: 'INTEGER', pk: false },
    retry_count: { type: 'INTEGER', pk: false },
    session_group: { type: 'TEXT', pk: false },
    session_id: { type: 'TEXT', pk: false }
  },
  control_queue: {
    id: { type: 'INTEGER', pk: true },
    raw_content: { type: 'TEXT', pk: false },
    content: { type: 'TEXT', pk: false },
    priority: { type: 'INTEGER', pk: false },
    require_idle: { type: 'INTEGER', pk: false },
    bypass_state: { type: 'INTEGER', pk: false },
    ack_deadline_at: { type: 'INTEGER', pk: false },
    status: { type: 'TEXT', pk: false },
    retry_count: { type: 'INTEGER', pk: false },
    available_at: { type: 'INTEGER', pk: false },
    last_error: { type: 'TEXT', pk: false },
    created_at: { type: 'INTEGER', pk: false },
    updated_at: { type: 'INTEGER', pk: false },
    session_group: { type: 'TEXT', pk: false },
    target_binding: { type: 'TEXT', pk: false }
  },
  status_notice_cooldowns: {
    cooldown_key: { type: 'TEXT', pk: true },
    channel: { type: 'TEXT', pk: false },
    endpoint: { type: 'TEXT', pk: false },
    status_type: { type: 'TEXT', pk: false },
    reason: { type: 'TEXT', pk: false },
    last_notified_at: { type: 'INTEGER', pk: false },
    expires_at: { type: 'INTEGER', pk: false },
    updated_at: { type: 'INTEGER', pk: false }
  },
  channel_namespaces: {
    namespace: { type: 'TEXT', pk: true },
    component_name: { type: 'TEXT', pk: false }
  },
  group_heads: {
    session_group: { type: 'TEXT', pk: true },
    head_id: { type: 'INTEGER', pk: false }
  },
  origin_sync_cursors: {
    session_group: { type: 'TEXT', pk: true },
    synced_id: { type: 'INTEGER', pk: false },
    checkpoint_id: { type: 'INTEGER', pk: false },
    updated_at: { type: 'INTEGER', pk: false }
  },
  drain_fences: {
    session_group: { type: 'TEXT', pk: true },
    reason: { type: 'TEXT', pk: false },
    run_id: { type: 'TEXT', pk: false },
    created_at: { type: 'INTEGER', pk: false }
  },
  mode_transitions: {
    run_id: { type: 'TEXT', pk: true },
    source_mode: { type: 'TEXT', pk: false },
    target_mode: { type: 'TEXT', pk: false },
    phase: { type: 'TEXT', pk: false },
    cutoff: { type: 'INTEGER', pk: false },
    coverage_snapshot: { type: 'TEXT', pk: false },
    absorbed_ids: { type: 'TEXT', pk: false },
    reason: { type: 'TEXT', pk: false },
    created_at: { type: 'INTEGER', pk: false },
    updated_at: { type: 'INTEGER', pk: false }
  },
  group_runtime_overrides: {
    session_group: { type: 'TEXT', pk: true },
    runtime: { type: 'TEXT', pk: false }
  },
  group_model_overrides: {
    session_group: { type: 'TEXT', pk: true },
    runtime: { type: 'TEXT', pk: true },
    model: { type: 'TEXT', pk: false },
    effort: { type: 'TEXT', pk: false }
  }
};
export const TABLES = Object.fromEntries(
  Object.entries(COLUMN_DEFINITIONS).map(([table, columns]) => [table, Object.keys(columns)]),
);

export const MIGRATIONS = Object.freeze({
  0: Object.freeze({ to: 1, migrate: migrateSchema }),
  1: Object.freeze({
    to: 2,
    migrate: migrateToV2,
    changes: {
      addColumns: {
        conversations: {
          session_group: { type: 'TEXT', pk: false },
          session_id: { type: 'TEXT', pk: false }
        },
        checkpoints: {
          session_group: { type: 'TEXT', pk: false },
          no_content: { type: 'INTEGER', pk: false }
        },
        control_queue: {
          session_group: { type: 'TEXT', pk: false },
          target_binding: { type: 'TEXT', pk: false }
        }
      },
      addTables: Object.fromEntries(
        [
          'channel_namespaces', 'group_heads', 'origin_sync_cursors', 'drain_fences',
          'mode_transitions', 'group_runtime_overrides', 'group_model_overrides',
        ]
          .map(table => [table, COLUMN_DEFINITIONS[table]]),
      ),
    },
  }),
});

export function inspectSchema(db, { allowNew = false, strict = true, allowExtraTables, allowExtraColumns, rejectUnsafeExtensions = strict } = {}) {
  return inspectLayout(db, 'c4', SUPPORTED_SCHEMA_VERSION, TABLES, { allowNew, strict, allowExtraTables, allowExtraColumns, rejectUnsafeExtensions, definitions: COLUMN_DEFINITIONS, migrateFromOlder: true });
}
