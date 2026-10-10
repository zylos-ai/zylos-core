# macOS protected recovery validation

Validated on 2026-10-10 against the Mac extension of PR #817 base
`285d518fc506161780d7e75537659465cc300ede`. Exact tested production-file hashes
are recorded in [macos-source-hashes.json](macos-source-hashes.json).

Host: Apple Silicon arm64, macOS 26.6.2 (25G83), Node 24.14.0, APFS,
with the default macOS temporary-directory alias. Existing native dependencies
were reused; no dependency installation, production service action or live
upgrade was performed. PM2/service calls in integration fixtures are isolated
adapters or temporary fake executables. SQLite files and child processes are real
but synthetic and confined to temporary fixtures.

## Results

| Final suite | Passed | Failed | Skipped |
|---|---:|---:|---:|
| Upgrade, snapshots and native primitives | 268 | 0 | 0 |
| C4 startup and actual owner/schema checks | 42 | 0 | 0 |

The first suite includes 52 recovery cases, eight native primitive cases, five
Mac parent/frozen-material cases, five Mac durability cases and two default
pipeline preinstall-failure cases. These subsets are not extra tests to add to
the total. `git diff --check` passed. Package file list and native executable mode
were checked with the dry-run command below.

## Reproduce

With compatible existing test dependencies, run directly (do not invoke the
repository's dependency-installing `pretest` for this validation):

```sh
node --experimental-test-module-mocks --test \
  cli/lib/__tests__/core-db-backup.test.js \
  cli/lib/__tests__/macos-*.test.js \
  cli/lib/__tests__/upgrade-*.test.js \
  cli/lib/__tests__/self-upgrade.test.js
node --test \
  skills/comm-bridge/scripts/__tests__/c4-session-init-cli.test.js \
  skills/comm-bridge/scripts/__tests__/sqlite-schema.test.js
npm pack --dry-run --ignore-scripts --json
```

Ensure child `node` commands on PATH use the same Node ABI as the SQLite driver.
The package dry run includes the native executable with mode 0755, C source,
SHA-256 sidecar, README and maintainer build script; no linked test dependency
folders are included.

## Covered boundaries

- Native boot/PID/microsecond identity, absent processes, competing kernel locks,
  bounded timeout, failed exec, and lock references surviving either parent or
  exec-child death. Unknown process identity never authorizes takeover.
- Both initial snapshot and recovery staging use file strong-sync before rename,
  followed by directory sync. Injected native sync failures propagate, preserve
  staged/rescue/displaced evidence and permit the documented retry.
- Stable and transaction copies carry the native helper and sidecar. Descriptor
  hashes, ownership/mode checks and missing/tampered-copy cases reject fallback.
- The running updater binds to stable frozen maintenance before acquiring its
  controller. A synthetic npm child moves the installed package helper away and
  exits unsuccessfully; the parent still durably records its PID/confirmed exit
  and releases its controller using frozen material.
- Default protected-pipeline stop and snapshot-destination failures call neither
  installer nor finalizer, retain installationIntent=false and preserve all three
  original SQLite files byte-for-byte.
- Actual synthetic three-DB/core recovery, snapshot damage, interrupted physical
  rename and rescue capture, READY-generation writes, stop failures, retained
  terminal cleanup, child-group containment and unknown exits are exercised.
- SQLite worker and C4 startup hook run through directory aliases. Partial skill
  deployment emits file-only recovery context before normal C4/formatter imports.
  Actual owner/schema tests retain database-entry isolation and schema rejection.

## Discriminating controls

These were executed on old behavior or isolated copied-package mutants, then the
real source was tested green:

| Changed boundary | Known-bad result |
|---|---|
| Worker CLI path alias | Original entry check fails the added alias regression |
| C4 startup entry alias | Original code fails both Mac alias startup cases; explicit directory alias remains in the test |
| Missing Linux boot identity | Original broad ENOENT catch returns absent; regression fails until it returns unknown |
| Parent installer uses installed helper | Isolated mutant: 3 failures, 2 passes in the five parent cases |
| Controller release uses installed helper | Isolated mutant: 1 failure, 4 passes in the five parent cases |
| Rescue/DB staging uses ordinary fsync | Both new publication-failure tests fail before conversion; all three focused sync tests pass after it |

The initial broad run exposed old Linux-only synthetic layouts as well as the C4
entry bug. Fixtures now include real frozen native materials and canonical journal
identities, while explicit alias regressions remain. The review also found and
fixed the parent-package dependency and missed restore-sync calls before delivery.
Earlier failing logs do not represent the final source.

## Limits

The binary contains arm64 and x86_64 slices built with a macOS 11.0 deployment
target; only arm64 on the host above was executed. Intel and minimum-OS execution,
real protected installation/self-upgrade, actual managed-service stop/restart,
logout/reboot, physical power loss and channel continuity during maintenance were
not tested. Synthetic PM2 adapters are not evidence of the live deployment chain.

The current user LaunchAgent is login-triggered. This patch does not install a
LaunchDaemon or promise recovery before login. Existing machine startup,
PM2/activity-monitor/runtime availability and owner database gates remain separate
deployment requirements. Linux regression and independent PR review remain the
reviewer's responsibility. These results do not authorize merge or deployment.
