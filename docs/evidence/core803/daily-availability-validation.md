# PR817 daily availability revision — isolated Linux validation

Base: `8b76c9a577153869ff7539c11ad6c3389f01ca40` (full tree verified as
`7462cfec72b896408e3bf28345df2b31c5319047`). This revision implements the agreed
order: daily schema compatibility and pre-stop preparation/cleanup first, then
active-marker-only daily isolation. It does not merge, deploy or release the PR.

## Environment and isolation

- Linux 5.15.0-139-generic, x86_64; Node v24.21.0.
- Fresh independent checkout, with dependency directories copied locally. No
  installed skills, service configuration or production data were test targets.
- Child processes received isolated `HOME`, `ZYLOS_DIR` and `PM2_HOME`. Node and
  Jest runs used separate temporary homes. Test service controls are in-process
  seams or fixture PM2 executables; actual SQLite databases live in temp roots.
- An outer PM2 shim rejects any unexpected service command. An outer npm shim
  rejects install/update/etc.; only `npm config get`, `npm --version`, and the
  existing temp-fixture `npm run ... probe` lifecycle test are permitted.
- No dependency installation, real service stop/restart, global npm installation,
  runtime restart or host reboot was performed. `npm test` was intentionally not
  used because its pretest hook installs skill dependencies.

## Commands and results

Commands were invoked from the checkout by `subprocess.run`, with the isolated
child environment described above; stdout and stderr were retained as logs.

```text
node scripts/run-node-tests.js
node --experimental-vm-modules node_modules/.bin/jest --runInBand
node --test skills/comm-bridge/scripts/__tests__/sqlite-schema.test.js \
  cli/lib/__tests__/upgrade-daily-availability.test.js \
  cli/lib/__tests__/upgrade-backup-only.test.js \
  cli/lib/__tests__/upgrade-preinstall-failures.test.js
```

| Check | Result |
|---|---|
| Complete Node suite | 1,203 passed; 0 failed; 29 platform skips (1,232 total) |
| Complete Jest suite | 13 suites; 160 passed; 0 failed |
| Focused owner/availability/preparation tests | 71 passed; 0 failed; 0 skipped |
| `git diff --check` | Clean |

Earlier focused compatibility/isolation checks also passed (149 passed, 3 platform
skips). Old assertions that required unmarked history to block ordinary operation
were updated to distinguish active-marker behavior from explicit deep discovery.
The complete suites still exercise Linux recovery interruption, partial physical
replacement, rescue preservation, child-exit uncertainty, READY continuation and
terminal cleanup boundaries.

## Failure injection and independent acceptance entrypoints

Run individual files with `node --test <file>` under the same isolated environment.
Do not aim these fixtures at a live deployment or invoke the updater against one.

| File | Injection / observed result |
|---|---|
| `cli/lib/__tests__/upgrade-daily-availability.test.js` | Corrupt, missing and oversized historical journals, foreign history entries and dangling backup directory: real owner writes and runtime startup remain available without a marker; the real C4 session hook reads normal checkpoint context. Explicit recovery discovery still diagnoses history. |
| Same | Valid active READY plus unrelated corrupt history: actual owner writes work; runtime is nonblocking; PM2 save remains suppressed. |
| Same | Active preparing/stopping/offline/installing/restoring/recovery-required states and a malformed active journal: real owner opens fail before creating any business database. Unmarked abandoned preparation allows daily use but rejects a new upgrade before preflight. |
| `skills/comm-bridge/scripts/__tests__/sqlite-schema.test.js` | Add one table and one column to each actual owner database: normal open/write and readonly startup preflight work; strict owner inspection rejects the extensions. Existing missing-column, future-version, migration rollback and concurrent initialization tests remain. |
| `cli/lib/__tests__/upgrade-backup-only.test.js` | Remove a driver, make schema inspection reject, or block snapshot destination, in both protected and backup-only modes: no PM2 call, installation or finalizer; original service remains online. |
| Same | Inject partial stop, snapshot, verification or synchronization failure: no npm/finalizer; restart only previously online service records; previously stopped record is not restarted. Restart failure remains explicit and requires manual intervention. Installer/finalizer failure after preparation retains the accepted manual recovery boundary. |
| `cli/lib/__tests__/upgrade-preinstall-failures.test.js` | Default protected pipeline with fake PM2: actual stop failure or snapshot seam failure prevents installation, preserves original DB bytes, and verifies the original service returned online. |
| `cli/lib/__tests__/upgrade-material-validation.test.js` | Active READY metadata defects remain fail closed; terminal child-exit confirmation and marker cleanup remain required. Unrelated unmarked backup damage does not block ordinary DB access. |
| `cli/lib/__tests__/upgrade-bootstrap.test.js`, `upgrade-startup-context.test.js`, `pm2-save.test.js`, `upgrade-material-probe-parity.test.js` | Startup defaults use only the active marker; explicit status/resume retain deep checks; stable module trust checks, live-controller observation and identical daily probes remain covered. |

## Protocol and retained boundaries

The existing marker and journal are the only availability authority; this change
adds no mirrored availability state. Marker publication remains before stopping
writers. Installation/replacement occurs while the referenced journal is blocked.
Validated READY or verified provisional abort releases ordinary opens before
service restart; confirmed terminal cleanup removes the marker afterward. PM2 save
remains suppressed even at READY. Ordinary checks read only the marked journal,
not other history, descriptors, snapshot hashes or backup contents. Explicit
upgrade/recovery paths retain detailed material validation.

Linux flock/process-identity and crash-resume behavior remain. macOS keeps the
Node-only original-process compensation design and manual interruption boundary;
Mac-only tests were skipped on this Linux host. Historical Mac evidence applies
to the prior revision, not this commit. No real-host install/reboot, channel
continuity, physical power-loss durability, or global CLI/dependency downgrade was
validated. External SQLite writers and externally deleted active markers remain
outside this protocol's guarantees. Independent review and behavior acceptance
must assess the exact new commit.
