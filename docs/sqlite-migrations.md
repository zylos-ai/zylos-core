# Core SQLite schema migrations

Rules for changing the schema of the three core databases: C4
(`skills/comm-bridge`), scheduler (`skills/scheduler`) and web-console
(`skills/web-console`). The self-upgrade path (see
[self-upgrade-recovery.md](self-upgrade-recovery.md)) rehearses, runs and
checks these migrations; this page is the contract a schema change must meet.

## When a migration step is required

Any change to a core table or column requires a new schema version and one
migration step. That covers adding, removing, renaming or rebuilding a table;
adding, removing or renaming a column; changing a column's type, `NOT NULL`,
default or primary-key position; and any one-time change to existing rows
(backfill, delete, re-tag) as part of the upgrade.

Indexes, triggers and views are not checked by the engine (see
[Not checked](#not-checked)), but changing them in an upgrade still belongs in
a migration step.

## Files touched by a schema change

For the owner moving from version N to N+1:

| File | Change |
|---|---|
| `<owner>/scripts/*schema.js` | `SUPPORTED_SCHEMA_VERSION = N+1`; update `TABLES` and `COLUMN_DEFINITIONS` to the N+1 layout; register `MIGRATIONS[N] = { to: N+1, changes, migrate }` |
| migration module | the `migrate(db, { isNew, from, to })` callback |
| tests | a chain test from every supported starting layout to N+1 (see [Tests](#tests)) |

Rules:

- **Steps are adjacent and permanent.** `MIGRATIONS[N].to` must be `N+1`. Never
  edit or remove a released step; a deployment may still start from it. A gap
  in the chain fails planning before services stop.
- **Do not change the 0→1 step or `init-db.sql` to reach the new layout.** A new
  database is created by running the whole chain (0→1 with `isNew: true`, then
  1→2, …). If the 0→1 path already creates an N+1 object, the N→N+1 step will
  collide with it and be rejected.
- **`TABLES` / `COLUMN_DEFINITIONS` describe the latest version only.** Earlier
  layouts are not kept in production code; the declaration of each step is the
  record of what it changed.
- **One step, one SQLite connection.** The callback must use only the `db`
  argument. The engine wraps the whole chain for that database in one
  transaction, so a callback must not `BEGIN`/`COMMIT` itself.

## The change declaration

From 1→2 onward every step must carry `changes`. Only the 11 keys below are
accepted; an unknown key, a wrong type, or a missing `changes` fails planning
(`sqlite-schema.js` `validateChanges`). Omitted keys default to empty.

Column definitions use `{ type, pk }` (SQLite declared type and whether the
column is part of the primary key). `alterColumns` uses the full
`{ type, pk, notnull, default }`, where `default` is the SQLite SQL expression
or `null`.

| Key | Shape | Meaning | Checked before the step | Checked after the step |
|---|---|---|---|---|
| `addTables` | `{ table: { column: {type,pk} } }` | New core table | name not already used (user table collision is rejected) | table exists with these columns and definitions |
| `maybeTables` | same as `addTables` | Core table that may already exist (adopting a table some deployments created out of band) | if present, its declared columns match | table exists with these columns and definitions |
| `dropTables` | `{ table: [every column] }` | Remove a core table | table exists and the list names **every** column it has; a user-added column makes the drop fail | table gone |
| `renameTables` | `[{ from, to }]` | Rename a table | `from` exists, `to` is free | columns carried over under the new name |
| `rebuildTables` | `[table]` | Table is recreated (create-copy-drop-rename), e.g. to change a constraint | table exists | same rules as any table: all columns, including user-added ones, must still be there with the same definitions unless declared otherwise |
| `addColumns` | `{ table: { column: {type,pk} } }` | New core column | table exists; column name not already used | column exists with this definition |
| `maybeColumns` | same as `addColumns` | Core column that may already exist | if present, definition matches | column exists with this definition |
| `dropColumns` | `{ table: [column] }` | Remove columns | columns exist | columns gone |
| `renameColumns` | `[{ table, from, to }]` | Rename a column | `from` exists, `to` is free | `to` exists with the old definition |
| `alterColumns` | `{ table: { column: {type,pk,notnull,default} } }` | Change a retained core column's definition | column is a core column at the source version and is not also added, dropped or renamed in this step | column has exactly this definition |
| `rowChanges` | `[table]` | Row count of the table may change (backfill inserts, cleanup deletes) | — | without it, any change in row count fails the step |

Everything not declared must stay the same: no other table or column may
appear or disappear, retained columns keep type, `NOT NULL`, default,
primary-key position and hidden/generated flags, and undeclared tables keep
their row counts. A failed check rolls back the whole chain for that database.

## Example: C4 1→2

This example is illustrative; C4's released target is still version 1. Suppose
the next release adds nullable `conversations.priority_reason` and backfills
it. In `skills/comm-bridge/scripts/c4-schema.js`, make these edits to the
existing declarations:

```diff
-export const SUPPORTED_SCHEMA_VERSION = 1;
+export const SUPPORTED_SCHEMA_VERSION = 2;

@@
-    "retry_count"
+    "retry_count",
+    "priority_reason"
```

Add `"priority_reason": { "type": "TEXT", "pk": false }` to the existing
`COLUMN_DEFINITIONS.conversations` object, then extend the migration registry:

```js
export const MIGRATIONS = Object.freeze({
  0: Object.freeze({ to: 1, migrate: migrateSchema }), // released; keep as is
  1: Object.freeze({
    to: 2,
    changes: {
      addColumns: {
        conversations: { priority_reason: { type: 'TEXT', pk: false } },
      },
    },
    migrate(db) {
      db.exec('ALTER TABLE conversations ADD COLUMN priority_reason TEXT');
      db.exec("UPDATE conversations SET priority_reason = 'legacy' WHERE priority IS NOT NULL");
    },
  }),
});
```

The `UPDATE` changes values, not the row count, so no `rowChanges` entry is
needed. A step that inserts or deletes rows in `conversations` would add
`rowChanges: ['conversations']`.

## Unsafe patterns

- **New `NOT NULL` column without a default.** SQLite rejects
  `ADD COLUMN ... NOT NULL` without a default on a non-empty table. Add it
  nullable or with a default.
- **Rebuilding a table with a fixed column list.** `INSERT INTO new SELECT a, b
  FROM old` drops user-added columns, and the step then fails with
  `undeclared removal of column`. Copy every existing column (read them with
  `PRAGMA table_xinfo`) or plan the rebuild with the user extensions in mind.
- **Dropping a table that users extend.** `dropTables` must list every column;
  a user-added column blocks the upgrade, which has to be resolved by hand.
- **Using `maybeTables` / `maybeColumns` to skip checks.** Use them only when
  some released deployments may legitimately already have the object.

## Not checked

The engine checks table and column names, column definitions and row counts.
It does not check indexes, triggers or views (a rebuild can lose user-created
ones), and it cannot detect changed row contents when the count stays the
same. Review these by hand.

The legacy 0→1 step has no declaration and none of the per-step checks; only
the final v1 layout check applies.

## Tests

A schema change must add or extend tests that:

1. Migrate each historical fixture (`skills/comm-bridge/scripts/__tests__/fixtures/migration-history`,
   including the v0.9.0 v1 samples) to the new version and pass the final layout check.
2. Migrate a v1 database carrying a user-added table and a user-added column on
   a core table, and assert both survive with their data.
3. Create a new database (`isNew`) through the full chain.

See `skills/comm-bridge/scripts/__tests__/migration-chain.test.js` for engine
examples of every declaration type.

## Adding a fourth core database

The core database list is fixed at three in several places:

- `cli/lib/core-db-backup.js:7` defines `CORE_DATABASES`; line 21 validates
  snapshot manifests against its size and entries.
- `cli/lib/core-db-backup-worker.js:7` has its own `DATABASES` list.
- `cli/lib/self-upgrade.js:1777` expects three version-probe results.
- `cli/lib/upgrade-recovery.cjs:116` checks snapshot manifest length against three.
- `cli/lib/upgrade-maintenance.cjs:12` has `DB_PATHS`; line 165 has another
  database list for recovery history checks.

Update these together, inspect other database-count assumptions, and extend
the tests. Otherwise the new database may be omitted from snapshots or checks.
