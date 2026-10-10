# Backup-only capability split validation

> Historical validation of the superseded native-helper implementation. For the current Node-only macOS contract and validation, see [node-only-validation.md](node-only-validation.md). The results below do not validate the current source.

Validated on 2026-10-10, extending PR #817 baseline
`e49cd4dbcf7afe3b80a974500662b9c89932a8d5`. Production hashes are recorded in
[backup-only-source-hashes.json](backup-only-source-hashes.json). This supplements,
rather than replaces, the earlier Mac validation report.

Host: arm64 macOS 26.6.2 (25G83), Node 24.14.0. Existing dependencies were reused.
Only temporary synthetic databases, fake PM2 executables and installer/finalizer
adapters were used. No live services, real install, reboot or startup configuration
were changed.

## Results

| Check | Pass | Fail | Skip |
|---|---:|---:|---:|
| Upgrade/snapshot/native regression suite | 283 | 0 | 0 |
| Final backup-only, output and platform tests | 24 | 0 | 0 |
| C4 startup and owner/schema checks | 42 | 0 | 0 |

The focused run overlaps the broad run. The two Mac capability-specific cases and
strengthened finalizer backup-path assertions were added after the broad run
started and are covered by the final focused run. Do not sum these rows as unique
tests. Package dry-run and whitespace checks passed; native helper mode remains
0755 and no node_modules paths are included in the package.

## What was exercised

- The real capability implementation runs with narrowly simulated Linux `/proc`
  and trusted-flock boundaries, including a positive control. Either missing
  capability selects backup-only, and real synthetic three-database snapshots
  are verified before the installer adapter is reached. This is not native Linux
  execution.
- Mac identity and recovery-probe failures are simulated independently. Snapshot
  workers and the packaged native fullsync helper execute on the real Mac host.
  Neither capability failure disables required snapshot durability.
- Stop, snapshot creation, verification and sync-probe failures prevent installer
  and finalizer execution. No new recovery transaction or maintenance marker is
  discoverable, and ordinary database guards remain open.
- Installer and finalizer failures preserve post-install database changes instead
  of automatically restoring old data. Result/state serialization retains the
  verified snapshot, code backup path and manual-recovery status.
- Human and C4 formatting distinguish verified snapshots, unavailable snapshots
  and disabled automatic recovery. Backup-only code backups are excluded from
  legacy success cleanup.
- Existing full-protection recovery, native primitives and database-owner tests
  remain green.

## Known-bad controls

Each mutation ran in its own copied package. The unmodified 16-test backup-only
baseline passed with zero skips. Each selected mutant exited nonzero:

| Mutation | Failed tests |
|---|---:|
| Ignore missing trusted flock | 1 |
| Accept absent process identity | 1 |
| Skip snapshot preparation | 2 |
| Re-enable legacy automatic rollback | 1 |
| Drop backup-only state in finalizer | 2 |

## Reproduce

Use Node 24 with compatible existing SQLite dependencies; child `node` must use
that same ABI. Do not invoke dependency-installing pretest hooks for these checks.

```sh
node --experimental-test-module-mocks --test \
  cli/lib/__tests__/core-db-backup.test.js \
  cli/lib/__tests__/macos-*.test.js \
  cli/lib/__tests__/upgrade-*.test.js \
  cli/lib/__tests__/self-upgrade.test.js
node --test cli/lib/__tests__/upgrade-backup-only.test.js \
  cli/lib/__tests__/upgrade-output.test.js \
  cli/lib/__tests__/upgrade-platform.test.js
node --test skills/comm-bridge/scripts/__tests__/c4-session-init-cli.test.js \
  skills/comm-bridge/scripts/__tests__/sqlite-schema.test.js
npm pack --dry-run --ignore-scripts --json
```

## Limits

Linux runtime regression and independent review remain with the reviewer. Intel,
minimum macOS, real service stop/restart, actual installation, reboot, pre-login
recovery, power-loss durability and channel continuity were not tested. Native
fullsync calls in temporary fixtures do not establish power-loss acceptance.
Backup-only deliberately provides no cross-process maintenance quarantine or
interrupted-upgrade recovery; new concurrent writers after stop checks remain
outside its guarantee. A failure can leave services stopped and requires manual
inspection. A snapshot-verification failure never authorizes installation even
if a snapshot directory was already published.
