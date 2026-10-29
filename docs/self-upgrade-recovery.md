# Self-upgrade and recovery

`zylos upgrade --self` downloads the target package and hands installation to
its upgrade entry. Supported sources start at 0.9.3; older installations use
`zylos upgrade --self --bridge` first. An already current installation does not
download or retry an upgrade.

## Before installation

The updater refuses unresolved earlier transactions and requires standalone
Dashboard to be uninstalled while retaining its data. It checks database versions
and rejects databases newer than the target supports. Migration rehearsal runs
on isolated copies when needed. Additional user tables and columns are supported;
schema collisions and undeclared changes fail the rehearsal.

Every attempt creates a private transaction under
`.backup/self-upgrade/<transactionId>/`, freezes recovery material, saves the
original package, stops managed services and known writers, and creates verified
snapshots before installation. Snapshots cover C4, scheduler, web-console and the
Dashboard database when it exists. A missing Dashboard database remains absent
until its owner's normal creation path. Matching schema versions skip migration
work but still require snapshots.

There is one protected transaction flow. On Linux, trusted process identity and
`flock` permit interrupted recovery. On macOS and restricted Linux, ordinary
failure compensation requires the original live controller; interruption requires
manual inspection. Missing takeover capabilities do not select a backup-only
installation path.

## Failure and forward repair

Before the durable compensation cutoff, installation or finalizer failure can
restore the original package, code and verified databases. Recovery validates
saved material, stops writers and confirms installer/finalizer exit before
replacement. Ambiguous identities, damaged snapshots or unconfirmed exits retain
isolation and require operator handling. A failed upgrade remains a failure even
when compensation completes.

After migration and runtime preparation, the finalizer records the compensation
cutoff before publishing shared settings and instructions. Failures after this
point require forward repair and never restore the old snapshot:

```sh
zylos upgrade --resume-finalize --status --json
zylos upgrade --resume-finalize --json
```

Forward repair continues recorded publication and finalization steps. Completed
steps are retained; conflicting user edits are reported without overwriting them.
Installers have individual timeouts, with no whole-command deadline. Results
report failed items, warnings, Dashboard readiness and session restart status.
Successful installation can still report degraded Dashboard readiness or require
a manual session restart.

## Status and interrupted recovery

```sh
zylos recovery status
zylos recovery resume
```

Status only reads recovery material. Startup checks and explicit recovery resume
may execute recovery. During maintenance, use the stable file-only entry if the
normal command cannot load:

```sh
node "$HOME/zylos/.zylos/upgrade/bootstrap.cjs" --root "$HOME/zylos" --status
node "$HOME/zylos/.zylos/upgrade/bootstrap.cjs" --root "$HOME/zylos" --once
```

Substitute the actual deployment root. A live controller prevents another from
taking over. Data-ready transactions resume validation and preserve subsequent
business writes; verified terminal transactions retry only cleanup. Failed
validation after restored data-ready never replaces databases again.

## Retained material and limits

Successful terminal cleanup removes the saved `code/` copy only after service
verification and confirmed child exits. Journals, snapshots and rescue material
remain. Cleanup failures retain the active marker and a retry path. Unpublished
staging lives under `.backup/self-upgrade-staging/`; uncertain published
transactions require inspection rather than deletion.

After interruption without verified automatic takeover, preserve the admission,
journal, package and snapshots. An operator must establish that installers and
database writers have stopped before choosing restoration or retaining new data.
Do not remove a lock just because its PID is absent, or copy a SQLite main file
over an active database. Keep a separate copy before manual replacement.

The protocol controls managed services and known CLI writers, not arbitrary
external SQLite clients or owner-created lifecycle scripts. Node file and
directory synchronization is required; successful fsync is not physical
power-loss certification. Hashes detect inconsistent material but are not
signatures against an owner replacing all records coherently. Native macOS,
restricted Linux and cross-module deployment acceptance remain separate from
isolated fixture tests.
