# PR #817 explicit migration chain validation

This evidence applies to the migration-chain change based on
`77ca3a747d9cc8db39699a378f43d37aaa6bca7b`, not the earlier availability-only
LGTM. Linux validation on 2026-10-11 uses Node v24.21.0. No real service stop, installation,
restart, reboot, merge, release, or production database migration was performed.

## Implemented contract

- Three pure owner schema modules register explicit 0→1 migrations. Current
  targets remain 1. The registry stores adjacent `{to, migrate}` steps.
- Planning inspects the starting version and resolves the complete path before
  callbacks run. The engine re-plans after `BEGIN IMMEDIATE`, runs the entire
  per-database chain, validates each stamped version, and commits once. A failure
  rolls back structure, data and `user_version`; the three databases do not share
  one transaction.
- Normal owners retain active-upgrade isolation and the existing policy allowing
  additional tables/columns. Reopening a current database does not run callbacks.
- Pre-stop worker preflight uses readonly connections to inspect origin/path;
  expected absent databases are planned in memory without creating business files.
- The installed finalizer invokes the installed migration worker before READY.
  Its dedicated action checks the active installing transaction identity and
  preinstall snapshot manifest identity, then uses the installed pure registries.
  Ordinary openers stay blocked before and after this controlled action. A
  current-version-only readonly check precedes READY publication. The retained
  snapshot/recovery worker is not used to execute new migration callbacks.
- Existing snapshots, Linux recovery and Mac original-process compensation/manual
  interruption boundaries remain. Recovery inspection stays readonly, including
  the compatibility fallback for pre-chain owner code.

## Historical evidence and mechanism fixtures

Committed fixtures live in
`skills/comm-bridge/scripts/__tests__/fixtures/migration-history/`.
`provenance.json` records source tag, peeled commit, source blob SHA, source
SHA-256, extraction rule, and fixture SHA-256; a test verifies fixture bytes.

| Fixture | Released source | Coverage |
|---|---|---|
| c4-v0.1.0.sql | v0.1.0 | Legacy layout missing raw_content, delivery_action, cooldown table |
| c4-v0.4.11.sql | v0.4.11 | Fresh-init raw_content layout |
| c4-v0.5.2.sql | v0.5.2 | Later unmarked layout with delivery_action and cooldowns |
| scheduler-v0.1.0.sql | v0.1.0 | Unmarked tasks/history/state layout |
| web-console-v0.5.3.sql | v0.5.3 | First separate sessions/uploads database |

All five fixtures migrate 0→1 with retained business data and exactly one
migration callback across repeated opens. C4 session-handoff rows are retagged
from web-console to void. A separately labelled derived fixture applies the
historical nullable `ALTER TABLE ... raw_content` operation and verifies ACK
suffix backfill. The integration fixture covers the historically absent separate
web-console database. Source comparison across 49 local ordinary release tags
found three C4 SQL groups and unchanged scheduler SQL; web-console SQL was
unchanged over its six available tags. That is source comparison, not execution
of every released version.

Synthetic `items` schema fixtures test 0→1→2 and 1→2 paths, a later-step error,
a missing/malformed later registration, and an invalid resulting target layout.
These are engine mechanism fixtures, not a released schema version 2.

## Validation

Tests run with isolated `HOME`, `ZYLOS_DIR`, and `PM2_HOME`, copied native
owner dependencies, a PM2 shim that rejects service calls, and an npm shim that
rejects installation. `CORE_DB_TEST_SKILL` explicitly points to this checkout's
comm-bridge dependency tree so real SQLite cases execute. Tests are invoked
directly; the package pretest dependency installer is not run.

Validation commands:

```sh
node scripts/run-node-tests.js
node --experimental-vm-modules node_modules/.bin/jest --runInBand
node --test skills/comm-bridge/scripts/__tests__/sqlite-schema.test.js \
  skills/comm-bridge/scripts/__tests__/migration-chain.test.js
```

Final results:

| Suite | Result |
|---|---|
| Full Node suite, 94 files | 1,211 passed, 0 failed, 24 platform skips (1,235 tests) |
| Jest, 13 suites | 160 passed, 0 failed |
| Owner/schema plus migration-chain suites | 46 passed, 0 failed, 0 skipped |
| Recovery fixture rerun | 52 passed, 0 failed, 1 platform skip; overlaps full Node |

The first full Node run exposed recovery fixture copies that omitted the newly
extracted migration modules. The fixture dependency copies were corrected; its
isolated rerun and the complete final Node run passed. Suite counts overlap and
must not be added as independent cases. Historical SQL fixtures retain source
trailing whitespace so their bytes match the recorded immutable hashes; those
expected fixture warnings are excluded from the final whitespace check. All
other changed files pass `git diff --check`.

The installed-worker integration test compares C4 and scheduler file bytes before
and after readonly preflight, verifies original snapshot version 0 after migration,
rejects missing/wrong transaction identity and post-READY migration, and calls
all three actual ordinary owner entrypoints while installing. After actual
`protectedDataReady` runs the installed worker and current-target check (with the
retained/frozen worker preflight stubbed in this integration test), all three ordinary entrypoints insert
business rows and separate readonly connections read those rows back.

The integration and full suites use real SQLite and temporary files, with service
operations represented by fixtures. No physical power-loss, real multi-service
installation/reboot, channel-continuity, or new Mac execution evidence is claimed.
The prior 77ca Mac report does not certify this revision.
