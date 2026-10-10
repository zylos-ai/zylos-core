# Protected self-upgrade and file-only recovery

Protected upgrades snapshot `comm-bridge/c4.db`, `scheduler/scheduler.db`, and
`web-console/web-console.db` before npm installation. A failed protected
installation or finalizer restores declared core skill directories, the original
PM2 ecosystem, and these databases using a saved independent runner. The command
still reports that the upgrade failed; compensation has its own result.

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

Self-upgrade deploys the stable file-only bootstrap before publishing its first
transaction. Initial journals and controller ownership are staged outside the
active discovery root, then published together by durable directory rename. A
prepublication failure leaves no incomplete active transaction.

The stable entry does not create a separate supervisor, tmux runtime, saved
runtime PATH or authentication gate. On machines with configured startup, the
existing PM2 startup list and activity-monitor launch the normal runtime. Its
file-only adapter discovers an interrupted upgrade before querying C4. If no
machine startup is configured, materials remain and the next normal runtime
startup receives the recovery task. Normal channel availability during
maintenance is not promised.

Non-upgrade CLI commands skip PM2 list saves while recovery materials remain
active, preserving the earlier startup list. PM2's own SIGTERM handler and direct
manual `pm2 save` can still persist stopped services. If that includes
activity-monitor, automatic handoff is not guaranteed; the next normal runtime
launch discovers the retained transaction. Once recovery is running, it restarts
all recorded original services independently of dump status, verifies them
online, then saves the list. `status` only inspects; `resume` performs recovery.

Protected upgrades use Linux `/proc` and a trusted `flock`, or the packaged
macOS native helper for descriptor locks, boot/PID/start-time identity and
`F_FULLFSYNC`. macOS uses the same preinstall three-database snapshot, schema
checks, recovery state machine and service isolation. If its helper or capability
check is unavailable, the upgrade stops before installation; it does not silently
fall back to an unprotected Mac upgrade. Other unsupported platforms retain the
legacy path and report `preInstallProtection=false`.

The Mac helper and its hash are frozen with the stable bootstrap and transaction
materials before installation. The live updater binds its maintenance operations
and controller-release callback to the stable frozen copy before taking control;
it can still record installer exit when npm has replaced or damaged its package.
Recovery uses the frozen copies, not a helper loaded from the newly installed package. A process-identity query failure is not proof
that the old controller died. The kernel guard file is retained, with acquisition
bounded by a timeout; controller death remains separate from confirming that
installer/finalizer process groups have exited. Full synchronization failures
propagate instead of being reported as durable publication.

The shipped executable contains arm64 and x86_64 slices with a macOS 11.0 build
target. Build target and available slices are not runtime certification: see the
validation report for tested hosts. End users need no compiler or Node addon.
A user LaunchAgent starts on login; it does not establish unattended recovery
before login. The existing PM2/activity-monitor/runtime startup chain and database
gates must be configured and usable. This feature does not install a LaunchDaemon
or change the operator's startup configuration.

No optional `/proc` or `lsof` database occupancy scan is performed. The `recovery configure` and `verify`
supervisor commands are retired; status and resume remain file-only operations.

## Status and recovery

```sh
zylos recovery status
zylos recovery resume
```

During maintenance, use the fixed file-only entry even when normal C4 access
fails:

```sh
node "$HOME/zylos/.zylos/upgrade/bootstrap.cjs" --root "$HOME/zylos" --status
node "$HOME/zylos/.zylos/upgrade/bootstrap.cjs" --root "$HOME/zylos" --once
```

Substitute the actual deployment root. A live verified controller
prevents a second resume operation; READY phases keep ordinary
startup/database context available while interrupted verification can still be
continued. Startup discovers unfinished
transactions before normal C4 access. Ambiguous or damaged materials still
produce a recovery prompt, but cannot authorize automatic database replacement.
The runtime receives fixed status/resume argv, never executable journal strings.
An independently verified controller identity prevents concurrent recovery.

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

## Retained evidence and output

JSON, human output, and C4 replies expose snapshot paths, per-database missing or
backed-up states, schema versions, protection status, transaction paths,
and separate recovery attempted/completed/stage/error values. Cleanup warnings
do not turn a verified terminal success into a compensation request.

Successful cleanup removes only temporary code copies. Complete transaction
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
