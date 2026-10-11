# Successful-upgrade cleanup and optional usage dependency validation

This revision completes three scoped follow-ups to PR817: successful protected
upgrade code-copy removal, removal of the unused macOS native helper, and lazy
loading of SQLite for the optional activity-monitor usage check.

## Behavior and boundaries

- A verified `upgrade_complete` transaction first records
  `cleanup.complete=false`, `cleanup.codeRemoved=false`, and
  `cleanup.servicesRestored=true`. This is still terminal authority: cleanup
  failure must not trigger database compensation.
- Cleanup re-reads the durable journal and requires installer/finalizer exit
  confirmation and restored services. It removes only the fixed private
  transaction `code/` directory. Symlink roots are refused; nested symlinks are
  unlinked without following their targets. Transaction paths must be canonical.
- Removal and directory synchronization precede the durable completion flags;
  active-marker removal follows. Partial removal and an already-absent code
  directory can be retried. Discovery includes pending cleanup without a marker.
- Database snapshots, recovery runner/dependency closure, journal/descriptor,
  logs and rescue evidence remain. Restored and pre-install-aborted transactions
  retain their code copies. Parent-side cleanup warnings reach the normal result.
- The obsolete native source, binary, checksum, README, build script and native
  protocol test are removed. Historical source-hash evidence remains historical;
  it is not a claim those files are present in this revision. Negative assertions
  that protected materials contain no native helper remain intentional tests.
- The optional usage monitor loads SQLite inside its guarded database query.
  Missing SQLite skips the usage task; it does not prevent loading the real
  activity-monitor entry when usage monitoring is disabled.

A clean export of the staged Git tree passed `npm pack --dry-run --json`: 484
files, with no obsolete native helper/build/test paths and no `node_modules`.
The development checkout contains copied test dependencies, so its package
count is not used as release evidence.

## Reproduction

Environment: Linux, Node 24.21.0. Recovery tests use temporary deployments,
real SQLite files, copied recovery modules and mocked service control. The
monitor entry test stops at the orchestration boundary before services start.

```sh
node --test cli/lib/__tests__/upgrade-recovery.test.js \
  cli/lib/__tests__/upgrade-protection-reentry.test.js \
  cli/lib/__tests__/upgrade-material-validation.test.js
node --test skills/activity-monitor/scripts/__tests__/usage-monitor*.test.js \
  skills/activity-monitor/scripts/__tests__/monitor-orchestrator.test.js \
  cli/lib/__tests__/self-upgrade.test.js \
  cli/lib/__tests__/upgrade-controller-lock.test.js \
  cli/lib/__tests__/upgrade-macos-parent.test.js
node scripts/run-node-tests.js
node --experimental-vm-modules node_modules/.bin/jest --runInBand
```

The first pre-existing targeted run passed 109 tests with 2 platform skips.
After adding 13 cleanup cases, the recovery file alone passed 65 with 1 platform
skip. The usage/self-upgrade/controller group passed 78 with 7 platform skips.
Full Node suite: 1,227 passed, 0 failed, 16 platform skips (1,243 total).
Jest: 13 suites / 160 passed, 0 failed. Counts overlap and must not be added.

New cleanup cases cover deletion scope/evidence hashes/nested symlinks; retained
code after restore/abort; all five durable exit/service gates with a stale caller;
partial deletion, absent-marker discovery, and preservation of a committed
post-READY row; normal and dangling symlink roots; and retry after directory-sync
or completion-journal publication failure after deletion. Existing marker-removal
failure tests also pass after cleanup, with no database or service work on retry.

The three initial regression failures were a test-fixture mismatch: recursive
copy created a group-writable `code/` root under the test umask. Production
`saveProtectedCode` already creates this root with mode 0700. The fixture now
matches that contract; production permission checks were not weakened.

This revision has not been deployed on any acceptance host. Their private
backups are retained. Earlier real-host upgrades predate these changes and do
not prove this new cleanup behavior. macOS execution and independent review of
this exact revision remain pending. No merge or release is included.
