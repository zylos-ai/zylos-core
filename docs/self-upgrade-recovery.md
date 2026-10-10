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
legacy group-writable permissions. Ordinary installations are not put into
maintenance merely because those parents use mode 0775. Recovery subdirectories,
journals, descriptors, and executable materials must remain owned, real paths
without group/world write access. New recovery directories use mode 0700.

Self-upgrade deploys the stable file-only bootstrap before publishing its first
transaction. Initial journals and controller ownership are staged outside the
active discovery root, then published together by durable directory rename. A
prepublication failure leaves no incomplete active transaction.

Automatic boot/runtime relay is declared by an existing private `capability.json`.
Without that declaration, upgrades still snapshot and compensate using saved
materials, but report boot capability as unverified and do not claim automatic
restart recovery. Once configured, invalid or unavailable boot capability fails
before transaction publication, service shutdown, snapshots, or npm changes.

Configure a Linux systemd **user** recovery service from the installed baseline:

```sh
zylos recovery configure --runtime codex
zylos recovery configure --runtime codex --write
systemctl --user daemon-reload
systemctl --user enable --now zylos-upgrade-recovery.service
loginctl enable-linger "$USER"
zylos recovery verify
```

Use `--runtime claude` for Claude. `--command /absolute/path/to/codex` (or
`claude`) pins the executable. The first command previews the private capability
file and unit. `--write` saves those files and deploys the stable bootstrap; it
does not enable/start services or replace differing existing configuration.
If the deployment needs an HTTP/SOCKS proxy, add `--inherit-proxy` to both
configure commands. The runtime PATH is always saved and used identically for the authentication
probe and supervised runtime launch, including nvm Node directories. This option
also saves only supported proxy environment variables in the
private capability file; transient API keys remain excluded. Preview output
redacts proxy values. Review the preview before applying configuration. Enabling a service and linger
changes machine behavior and may require administrator privileges.

The verifier checks enabled boot attachment, literal bootstrap invocation,
deployment-owner execution, protected files, supported unit directives, absence
of overrides, user linger, and native persisted runtime login. Transient API
environment variables cannot satisfy the login check. Interactive runtime flags
are validated; exec/resume subcommands and existing positional prompts are
rejected. The boot transport uses a private tmux session with fixed terminal geometry, so
the supplied recovery prompt reaches an active interactive session even without
an interactive login.

Linux prerequisites are a trusted Node executable, systemd, `/proc`, util-linux
`flock` supporting `--no-fork`/`--timeout`, trusted `/usr/bin/tmux`, `ps`, PM2, and
working native runtime credentials. Unsupported or unverifiable prerequisites for declared automatic relay
fail before service shutdown and npm installation. No optional `/proc` or `lsof` database occupancy
scan is performed.

## Status and recovery

```sh
zylos recovery status
zylos recovery verify
```

During maintenance, use the fixed file-only entry even when normal C4 access
fails:

```sh
node "$HOME/zylos/.zylos/upgrade/bootstrap.cjs" --root "$HOME/zylos" --status
node "$HOME/zylos/.zylos/upgrade/bootstrap.cjs" --root "$HOME/zylos" --once
```

Substitute the actual deployment root. The supervised `--launch-runtime` entry
keeps checking after an idle boot or runtime exit. A live verified controller
suppresses a second runtime or resume operation; READY phases keep ordinary
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

An interruption before durable installation intent verifies the original
deployment and SQLite committed state, records `aborted_before_install`, and
only resumes original service cleanup. No incomplete runner or snapshot is
executed. A durable data-ready/verification phase only resumes validation,
preserving subsequent valid business writes. Failed restored-data validation
remains isolated instead of restoring the same databases again.

## Retained evidence and output

JSON, human output, and C4 replies expose snapshot paths, per-database missing or
backed-up states, schema versions, protection status, transaction/archive paths,
and separate recovery attempted/completed/stage/error values. Cleanup warnings
do not turn a verified terminal success into a compensation request.

Successful cleanup removes only temporary code copies. Complete transaction
evidence moves out of the active scan root into
`.backup/self-upgrade-archive/<transactionId>`. Failed cleanup is rediscovered
through a private terminal cleanup pointer. Snapshots, rescue material, conflict
backups, and journals remain. Snapshot retention keeps the newest complete
feature-owned group (N=1); cleanup failures leave warnings and paths.

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
