# Protected self-upgrade and file-only recovery

When any core database needs a schema migration, protected upgrades snapshot
`comm-bridge/c4.db`, `scheduler/scheduler.db`, and `web-console/web-console.db`
before npm installation. A failed protected installation or finalizer restores
declared core skill directories, the original PM2 ecosystem, and these databases
using a saved independent runner. If all three database versions already match
the target release, the upgrade reads their versions once and leaves the
databases outside the upgrade transaction. Code and service recovery still use
the saved runner. The command still reports a failed upgrade if compensation runs.

## Backup and automatic recovery are separate capabilities

Every self-upgrade that changes a core database version requires a verified
preinstall snapshot of all three databases. A code-only upgrade does not create
one. Automatic recovery additionally requires controller
ownership and recovery publication; Linux crash takeover also requires process
identity. The command selects one of two modes:

- **Protected upgrade:** `preInstallProtection=true`. The saved runner can
  compensate for installation/finalizer failures. Linux can also resume
  interrupted recovery; macOS requires the original upgrade controller to remain
  alive and treats interrupted ownership as manual recovery.
- **Backup-only upgrade:** `backupOnly=true`, `preInstallProtection=false`,
  `automaticRecovery=false`. When migration is needed, installation can proceed
  only after services and known writers have stopped and the database snapshot
  has been created and verified. Database and code recovery after failure are
  manual. A code-only upgrade stops services but makes no database snapshot.

On Linux, missing trusted `flock` or usable `/proc` process identity disables
automatic recovery, not the required database backup. macOS uses the existing
Node.js environment for synchronization and exclusive controller admission; no
additional native recovery helper is installed or invoked. Its ordinary failure
compensation runs only under the live controller's ownership. An interrupted or
ambiguous attempt remains isolated for manual inspection rather than being
claimed by another controller.

Snapshot synchronization is independent of automatic recovery. Files and
containing directories are synchronized through Node's `fs.fsyncSync`, preserving
staging, rename and parent-directory publication order. Node-reported sync errors
abort the relevant operation. On macOS, supported Node versions first attempt
`F_FULLFSYNC` but may fall back to `F_BARRIERFSYNC` or `fsync`; success does not
identify the level used. The updater no longer requires proof of strict
`F_FULLFSYNC` success. This is a platform synchronization contract, not physical
power-loss certification. Snapshot integrity and hashes verify readable content,
not whether a drive has physically persisted every write.

Backup-only checks for an unresolved prior recovery transaction and refuses to
start if one exists. It creates no new recovery transaction, maintenance marker,
or bootstrap recovery task. It therefore does not automatically restore databases
or leave a transaction that permanently isolates normal database access. It also
does not provide protection against another process starting a writer after the
stop checks, or automatic recovery from an interrupted upgrade. Avoid concurrent
administrative writers during the operation.

Before either upgrade mode publishes a transaction or stops services, it checks
for unresolved recovery work and reads each existing database's SQLite
`user_version` through a readonly connection. It compares those values with
the downloaded release's declared schema versions. A missing database counts as
needing migration; a version newer than the target is rejected. If all three
versions match, the upgrade skips database preflight, rehearsal, snapshot,
migration and structural checks. It requires a target release that supports
this code-only path. No database backup is available for a code-only upgrade.

If any database needs migration, both upgrade modes probe the snapshot
destination and Node sync, load each owner's SQLite driver, and check existing
databases read-only for supported versions, SQLite integrity and a complete
registered migration path. They rehearse the target migration chain on isolated
copies made with the SQLite backup API while services remain running. A failed
rehearsal rejects the upgrade before service stop. A passed rehearsal is an
early warning check; live databases may change during it. Protected upgrades
also freeze recovery dependencies before stop.

When migration is needed, the downloaded target must contain the rehearsal
worker and schema code. A target without them is rejected before service stop,
including when selected with `--branch` to test an older release. Rehearsal copies are kept in a private
0700 directory at `.backup/db/.rehearsal-*` under the Zylos data directory.
The updater removes that directory on normal exit or worker timeout. An abrupt
kill of the updater can leave a copy behind. To identify one, inspect the
`.rehearsal-*` entries under that exact `.backup/db` path and compare their
timestamps with the interrupted upgrade; distinguish them from snapshot groups
that contain `manifest.json`. Preserve uncertain material for recovery review.

### Local schema extensions

Additional tables and columns in all three core databases are accepted and
reported by database, table, and column. They are included in the rehearsal
copies and verified snapshots. The `--allow-schema-extensions` option has been
removed; the ordinary upgrade approval covers the reported changes. Starting
with schema version 1→2, declared steps check that existing table and column
names survive unless the step declares their removal. A declared deletion of a
core table is rejected if that table has undeclared columns; the operator must
resolve that conflict outside the upgrade. A new core table or column name
already occupied by user data is also rejected. The legacy 0→1 transition has
no per-step change declaration or collision and preservation checks. Its result
must satisfy the required v1 core schema.

For declared steps, retained columns keep their SQLite type, `NOT NULL`,
default, primary-key position, and generated/hidden metadata unless a core
definition change is declared in `alterColumns`. Upgrade preflight and rehearsal
reject a user-added ordinary `NOT NULL` column without a usable default in a
core table before service stop. Ordinary database open permits it so an agent
can help repair the schema, though writes to that table may fail with SQLite's
column-specific `NOT NULL constraint failed` error. These checks cover table
and column names, retained column metadata, and row counts. They do not inspect
indexes, triggers, or views; rebuilding a core table can lose user-created
indexes or triggers. They also cannot detect a semantic change to rows when
the count stays the same. Review dependent objects and meaningful row content
when planning a schema migration.

The allowance does not bypass an unsupported schema version, a missing
migration step, a failed SQLite integrity check, a missing/corrupt/hash-mismatched
backup, or the applicable per-step and final schema checks. Show the owner the
reported extensions and any conflict as part of the ordinary upgrade review. A failed
check stops or rolls back the upgrade under the recovery rules below.

Backup-only service-stop, writer-drain, snapshot or snapshot-verification failures
abort before installation. The command restarts only the service records that
were online before its stop attempt and verifies them. It never restores a
database on this path. A partial stop is covered; a missing/changed service record
or restart failure is reported, with `preInstallServicesRestored: false` and
manual intervention still required. `preInstallServicesRestored: true` identifies
a failed attempt that left or restored the original service set before install.
After an installation or finalizer failure, preserve both the database snapshot and retained code backup,
stop all writers, and check code/schema compatibility before manually restoring
anything. A snapshot path by itself does not establish successful verification;
check `dbSnapshotVerified`. `zylos recovery resume` does not recover backup-only
attempts, because they have no recovery transaction.

The remaining transaction, isolation and automatic compensation behavior below
applies to protected upgrades unless explicitly stated otherwise.

## First adoption

Protection requires a baseline containing this updater, the database guards,
stable bootstrap, and pure schema inspectors. **Before the first upgrade to this
baseline, manually complete and verify a separate backup of all three databases.**
The Agent should read the release note / CHANGELOG and perform this prerequisite
in the existing environment before starting the old updater:

1. Locate `comm-bridge/c4.db`, `scheduler/scheduler.db`, and
   `web-console/web-console.db` relative to the Zylos data directory. Pause their
   writers and retain backups in an independent directory outside package
   installation and temporary cleanup.
2. Use the SQLite backup API to include committed WAL data. Alternatively,
   confirm that all database users (readers and writers) have stopped before
   taking a complete offline backup, including any required WAL/journal files.
   Copying only a `.db` file while committed data remains in its WAL is not a
   complete backup. Record each originally absent database as missing; do not
   create a database just to back it up.
3. Verify that each backup is readable, record the original Zylos version and
   backup location, and obtain the operator's confirmation. Keep writes paused
   through the subsequent upgrade so the backup remains the pre-upgrade state.
   **If any backup or verification fails, do not start the upgrade.**

This release-note instruction does not make an already installed older updater
execute the backup automatically. The last upgrade initiated by that updater
still has its older guarantees; installation-time or later snapshots do not
retroactively provide preinstall protection. Preserve the separate backup for
manual recovery if this first upgrade fails; it does not give the old updater
automatic restoration. Installing this package alone does not enable a boot
service or establish persisted runtime authentication.

The same first-adoption limit applies to the schema-extension policy: an
installed updater without this change may still reject additional tables or
columns before it installs the target release. No option in the new release can
change that old preflight. If it blocks on extension tables, first make and verify
complete backups, account for every row in those tables, and arrange a temporary
relocation outside the three core databases under an operator-approved plan.
Run the existing protected upgrade only after the old preflight passes; decide
whether to restore the extension tables after the new code is installed. Do not
delete or discard extension data merely to pass preflight. Extra columns require
a separately reviewed plan because relocating a table can affect core data.

Existing operator-owned `.zylos` and `.backup` parent directories may retain
legacy permissions and supported directory aliases. Without an explicit active
marker, ordinary database openers, runtime startup, C4 context and PM2-save guards
do not scan historical transactions or validate retained backups/helpers. Broken
history can reject a later upgrade or explicit recovery operation, but does not
by itself stop daily work. An unsafe/unreadable active-marker location still
fails closed. Recovery subdirectories,
journals, descriptors, and executable materials must remain owned, real paths
without group/world write access. New recovery directories use mode 0700.

Protected self-upgrade deploys the stable file-only bootstrap before publishing its first
transaction. Initial journals and controller ownership are staged outside the
active discovery root, then published together by durable directory rename. A
prepublication failure leaves no incomplete active transaction.

The stable entry does not create a separate supervisor, tmux runtime, saved
runtime PATH or authentication gate. On machines with configured startup, the
existing PM2 startup list and activity-monitor launch the normal runtime. Its
file-only adapter discovers an interrupted upgrade before querying C4. If no
machine startup is configured, materials remain and the next normal runtime
startup receives the recovery task. On macOS this discovery reports status and
the need for manual handling; it does not automatically resume an interrupted
transaction. Normal channel
availability during maintenance is not promised.

Non-upgrade CLI commands skip PM2 list saves while recovery materials remain
active, preserving the earlier startup list. PM2's own SIGTERM handler and direct
manual `pm2 save` can still persist stopped services. If that includes
activity-monitor, automatic handoff is not guaranteed; the next normal runtime
launch discovers the retained transaction. Once recovery is running, it restarts
all recorded original services independently of dump status, verifies them
online, then saves the list. `status` only inspects; standalone `resume` performs
recovery on Linux and refuses interrupted recovery on macOS.

Protected Linux upgrades retain `/proc` process identities and trusted `flock`
serialization. macOS instead uses exclusive file creation for controller
admission. The owner keeps that admission through the ordinary upgrade and
compensation path; no timeout, PID check or age-based cleanup steals an admission.
A controller crash leaves evidence for manual handling. A surviving controller
may compensate only after installer/finalizer exit is confirmed, using verified
frozen recovery code within the same attempt. A child-process exit alone is not
proof that all detached descendants have exited; the existing process-group
checks remain required.

Both platforms retain preinstall three-database snapshots, schema checks, service
isolation and frozen recovery materials. macOS does not provide unattended
crash/reboot takeover. When backup-only mode is selected, the required snapshot
still precedes installation. Failures while setting up an already selected
protected transaction abort that attempt rather than silently changing modes.

The new Mac path requires no compiler, native recovery binary or new Node addon.
The existing SQLite driver, npm, PM2 and system process inspection remain part of
the deployment; this does not claim the entire product has no other dependencies.
A user LaunchAgent starts on login, not before login. This feature does not
install a LaunchDaemon or alter startup configuration.

No optional `/proc` or `lsof` database occupancy scan is performed. The `recovery configure` and `verify`
supervisor commands are retired; status and resume remain file-only operations.

## Status and recovery

```sh
zylos recovery status
# Linux interrupted recovery only:
zylos recovery resume
```

During maintenance, use the fixed file-only entry even when normal C4 access
fails:

```sh
node "$HOME/zylos/.zylos/upgrade/bootstrap.cjs" --root "$HOME/zylos" --status
# Linux interrupted recovery only:
node "$HOME/zylos/.zylos/upgrade/bootstrap.cjs" --root "$HOME/zylos" --once
```

Substitute the actual deployment root. A live verified Linux controller
prevents a second resume operation; READY phases keep ordinary
startup/database context available while interrupted verification can still be
continued. Startup discovers unfinished
transactions before normal C4 access. Ambiguous or damaged materials still
produce a recovery prompt, but cannot authorize automatic database replacement.
The runtime receives fixed status argv and, on Linux, resume argv; it never
receives executable journal strings.
Linux uses independently verified controller identity to prevent concurrent
recovery. macOS uses non-reclaimed admission and permits automatic compensation
only within the original live attempt.

On Linux, a standalone resume follows the rules below. On macOS, these checks
also apply to same-attempt compensation, but a standalone resume must not
authorize automatic replacement after interruption.

Before replacement, recovery reestablishes maintenance, stops managed services,
rechecks their state, and waits a bounded time for known CLI workers. Timed-out
finalizer process groups must be terminated and their exit verified. Unknown
identities, conflicting materials, corrupt snapshots, incompatible schemas, or
unconfirmed exits retain `recovery_required`; they do not permit replacement.
Npm and finalizers run directly in detached process groups. Timeouts kill and
check the launched group. If a parent dies before saving the returned PID,
recovery retains isolation because it cannot confirm exit; it does not guess that
a child vanished. A saved PID is observed without killing a possibly reused PID.

An interruption before durable installation intent verifies original code, database
existence, schema/version and SQLite integrity (without hashing every table row), records `aborted_before_install`, and
only resumes original service cleanup. No incomplete runner or snapshot is
executed. A durable data-ready/verification phase only resumes validation,
preserving subsequent valid business writes. Failed restored-data validation
remains isolated instead of restoring the same databases again.

## Manual handling after a Mac interruption

Use the file-only status entry to inspect the retained transaction and snapshot.
Preserve the admission, journal, code backup and database snapshots. Do not delete
a lock just because its PID is absent or its timestamp is old. Do not ask a new
agent to retry automatic resume until it succeeds.

An operator must establish that the installer, finalizer and all database writers
have stopped, then assess the actual code/schema state and validate the snapshot
before choosing restoration or retaining the new data. Keep a separate copy of
the post-interruption files before any manual replacement. Three databases are
restored as a coordinated operation with correct WAL/SHM handling, not by copying
one main database over an active connection. A data-ready or terminal journal
may already correspond to valid new writes; do not blindly overwrite it with the
pre-upgrade snapshot. There is no command in this change that guesses these facts
or force-clears ambiguous ownership. Escalate the status and paths for explicit
operator handling.

## Retained evidence and output

Protected results distinguish `automaticCompensation` from `automaticResume`.
On macOS the former is true and the latter false: a completed ordinary failure
compensation does not imply that a new process can take over after interruption.

JSON, human output, and C4 replies expose snapshot paths, per-database missing or
backed-up states, schema versions and protection status. Backup-only output
explicitly identifies disabled automatic recovery, snapshot verification status,
and manual recovery instructions. A failed attempt requires manual inspection;
this is not a claim that a database restore is always necessary. Protected output
also exposes transaction paths and separate recovery
attempted/completed/stage/error values. Cleanup warnings
do not turn a verified terminal success into a compensation request.
Schema-extension reports identify each affected database, table, and extra
column. A name collision or undeclared loss reports the affected object and
blocks the upgrade; there is no schema-extension opt-in command.

Backup-only attempts retain database snapshots and code backup material for
manual recovery, including after successful installation. They do not have the
transaction journals or rescue runner described below.

Successful protected-upgrade cleanup removes only the fixed transaction `code/` copy,
after service verification and durable confirmation that installer/finalizer processes
have exited. The journal stays a verified terminal while `cleanup.complete=false`
and `cleanup.codeRemoved=false`; only deletion and directory synchronization set both
completion flags true. Cleanup failure retains the active marker and reports the
path for retry. Reentry retries cleanup only, never database compensation, so
legitimate writes after READY are preserved. Marker removal follows the durable
completion record. Restored/aborted transactions retain their code evidence. Complete transaction
directories remain in `.backup/self-upgrade/<transactionId>`. Discovery skips a
clean terminal once its maintenance marker is removed. Daily checks consult only
`active.json` and its one referenced transaction journal, including bounded
identity/readiness checks; unrelated damaged history is ignored. Upgrade admission
and explicit `--status`/`--once` retain detailed discovery and refuse unresolved
or damaged material. A journal abandoned before marker publication has not stopped
services or installed code; it does not isolate daily use, but must be resolved
before another upgrade. No terminal archive or cleanup pointer is created. Snapshots, rescue material and journals remain.
Snapshot retention keeps the newest complete feature-owned group (N=1); cleanup
failures leave warnings and paths. Private database snapshots are normalized to
SQLite DELETE journal mode before their SHA-256 is recorded, so readonly snapshot
inspection needs no temporary copy and creates no WAL sidecars.

A reported new-finalizer failure after data-ready publication reestablishes
isolation and invokes compensation. An interrupted data-ready transaction instead
resumes validation; a verified terminal only resumes cleanup. Failed validation
after restored data-ready never replaces the databases again.

Recovery replaces only declared core skill directories and the saved ecosystem.
Component and user skill directories are outside code restoration and protected
dependency installation. Existing core `node_modules` are retained, and actual
owner native dependencies are checked during compatibility preflight. The
globally installed CLI may remain the newer version; recovery is not a full npm
package downgrade.


## Daily compatibility and active isolation

Normal owner openers check supported versions and, at the current version,
required table/column definitions. Additional tables or columns are permitted.
Invalid or future versions are rejected; missing or incompatible required v1
fields are rejected after the legacy migration. The pure owner `inspectSchema()`
API remains strict by default for extra tables and columns at the current
version. Upgrade and recovery workers use migration-step checks from version 1
onward; normal opening alone does not prove migration compatibility.

Each owner registers explicit adjacent transitions (`MIGRATIONS`), currently 0→1
for all three databases; the supported target remains 1. Unmarked historical
schemas start at 0. Code retains the latest complete core schema. The legacy
0→1 callback has no change declaration or per-step collision, structure, or
row-count checks; its result must satisfy the required v1 schema. Beginning
with 1→2, each callback must declare added, deleted, and renamed tables and
columns, altered core column definitions, and any tables whose row counts may
change.
An `alterColumns` entry permits an intentional change to a retained core column
definition. Its value is keyed by table and column, with the complete resulting
`{type, pk, notnull, default}` definition (`default` is the SQLite SQL expression,
or `null` for no default). The column must belong to the core schema at the
source version; unlisted retained columns must keep their SQLite metadata. Complete
historical schema copies are not required in production code. The planner resolves a
continuous path from the current version to the target before changing
anything. After taking the SQLite writer lock it plans again, then runs every
step in one transaction per database. For declared steps from 1→2 onward, it
rejects occupied new core names before the step and checks afterward that
undeclared table and column names remain, retained column metadata matches,
and undeclared row counts are unchanged. It checks the latest required core
schema before commit. A failed
step or target check rolls back structure, rows and `user_version` together.
There is no cross-database atomic
transaction. If a later database fails after an earlier one committed, protected
upgrade compensation restores all three databases from the verified preinstall
snapshot and restores the protected code; backup-only mode requires manual
recovery. The global npm CLI may remain newer after protected compensation.
A database already at the target is inspected without rerunning migration callbacks.

After installation, before READY, a dedicated worker loads the installed owners'
registries and performs the migration while the active installing journal still
blocks ordinary owner openers. This path does not use an environment-variable
bypass or call ordinary openers. A failed migration keeps isolation and follows
the existing snapshot compensation boundaries. Recovery inspection remains read-only.

Historical fixture tests cover representative C4 source layouts from v0.1.0,
v0.4.11 and v0.5.2, scheduler v0.1.0, web-console v0.5.3, and absent web-console
storage. They also cover all three v1 databases produced by the v0.9.0 tagged
migration callbacks, seeded with synthetic rows and exercised through a
synthetic v1→v2 step. Exact source hashes and extraction rules accompany the SQL fixtures.
Multi-version chain tests are synthetic engine tests; no released schema version
2 or later is implied. The historical samples come from selected release source
layouts, not every evolved database on a deployed host. For each future released
database version, retain a sample database and content assertions. Until CI is
configured, the implementer runs these tests before merge, the reviewer reruns
them, and the release checklist requires them to pass and adds samples for the
new release. These checks do not cover indexes, triggers, or views; a core table
rebuild can lose user-created indexes or triggers. They also cannot detect an
incorrect `UPDATE` that preserves the row count. Sample assertions can catch
known regressions; verified snapshots allow recovery if a problem is found.

The active marker is durable before service stop, installation or database replacement.
Only the referenced journal's validated data-ready, verified provisional abort or
verified terminal state permits business writers. The marker remains throughout service
restart/verification and is removed only after durable terminal cleanup and confirmed
child exits. PM2-save stays suppressed whenever the marker exists, including READY.
Compensation/error paths republish blocked state before stopping writers or replacing
data; no new duplicate availability record is introduced. Detailed descriptor,
snapshot and executable validation remains in upgrade/recovery operations. This
protocol does not protect against external deletion of its active marker.
