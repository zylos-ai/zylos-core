# Protected self-upgrade and file-only recovery

Protected upgrades snapshot `comm-bridge/c4.db`, `scheduler/scheduler.db`, and
`web-console/web-console.db` before npm installation. A failed protected
installation or finalizer restores declared core skill directories, the original
PM2 ecosystem, and these databases using a saved independent runner. The command
still reports that the upgrade failed; compensation has its own result.

## Backup and automatic recovery are separate capabilities

Every supported self-upgrade path requires a verified preinstall snapshot of the
three core databases. Automatic recovery additionally requires controller
ownership and recovery publication; Linux crash takeover also requires process
identity. The command selects one of two modes:

- **Protected upgrade:** `preInstallProtection=true`. The saved runner can
  compensate for installation/finalizer failures. Linux can also resume
  interrupted recovery; macOS requires the original upgrade controller to remain
  alive and treats interrupted ownership as manual recovery.
- **Backup-only upgrade:** `backupOnly=true`, `preInstallProtection=false`,
  `automaticRecovery=false`. Installation can proceed only after services and
  known writers have stopped and the database snapshot has been created and
  verified. Database and code recovery after failure are manual.

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

Backup-only service-stop, writer-drain, snapshot or snapshot-verification failures
abort before installation. Some services may already have stopped; the command
does not automatically roll them back or restart them on this failure path.
Inspect the error and service state before restarting. After an installation or
finalizer failure, preserve both the database snapshot and retained code backup,
stop all writers, and check code/schema compatibility before manually restoring
anything. A snapshot path by itself does not establish successful verification;
check `dbSnapshotVerified`. `zylos recovery resume` does not recover backup-only
attempts, because they have no recovery transaction.

The remaining transaction, isolation and automatic compensation behavior below
applies to protected upgrades unless explicitly stated otherwise.

## First adoption

Protection requires a baseline containing this updater, the database guards,
stable bootstrap, and pure schema inspectors. Before first deploying this baseline, take a separate consistent snapshot of
the three databases and obtain the operator's confirmation. Stop managed readers
and writers for that snapshot, and retain it outside package installation or
temporary cleanup. The last upgrade initiated by an older updater has that older
updater's guarantees; installation-time or later snapshots do not retroactively
provide preinstall protection. Installing this package alone
does not enable a boot service or establish persisted runtime authentication.

Existing operator-owned `.zylos` and `.backup` parent directories may retain
legacy permissions and supported directory aliases. Without marker or transaction
materials, ordinary installations skip recovery validation, including partially
deployed stable helpers and empty group-writable recovery roots. Recovery subdirectories,
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

Backup-only attempts retain database snapshots and code backup material for
manual recovery, including after successful installation. They do not have the
transaction journals or rescue runner described below.

Successful protected-upgrade cleanup removes only temporary code copies. Complete transaction
directories remain in `.backup/self-upgrade/<transactionId>`. Discovery skips a
clean terminal once its maintenance marker is removed. The file-only probe reads
bounded journal JSON without owner/mode validation to classify retained clean
terminals as history; marker, unfinished/incomplete records, unconfirmed children
and unreadable material still trigger strict recovery validation. Later shared
permissions or a supported `.backup` alias do not relock ordinary databases.
No terminal archive or
cleanup pointer is created. Snapshots, rescue material and journals remain.
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
