# Node-only macOS upgrade protection validation

This revision extends PR #817 base `27e9e2d4215d5b5e90178c0c33d839200035944b`.
Exact changed source/test/document hashes are in [node-only-source-hashes.json](node-only-source-hashes.json).
Prior native-helper reports in this directory are historical, not validation of this revision.

## Accepted behavior

On macOS, ordinary observed upgrade failures recover under the original live controller. Exclusive Node `wx` admission stays held throughout verified frozen in-process compensation. Admission is never reclaimed from PID, age or malformed contents. Interrupted or ambiguous ownership requires manual recovery; standalone resume and bootstrap `--once` cannot take over on macOS. Startup exposes status and manual-recovery guidance. Linux retains its existing flock/process-identity and crash-resume path, subject to fresh Linux verification of this revision.

Node `fs.fsyncSync` replaces the added recovery helper for files and directories. The inspected Node 20.20.0 and 24.14.0 libuv source attempts F_FULLFSYNC on macOS but can fall back; JavaScript success does not prove strict F_FULLFSYNC success or physical power-loss durability. Existing snapshot normalization, integrity/hash validation, publication ordering and synchronization failure propagation remain. “Node-only” means no additional native recovery helper; existing SQLite, PM2, npm and system process inspection dependencies remain.

Stable frozen CommonJS modules are evicted after complete redeployment and revalidated/reloaded for startup discovery. Repeated upgrades in one process therefore use the current generation.

## Environment and results

Validation host: Apple Silicon arm64, macOS 26.6.2 (25G83), Node 24.14.0, using existing dependencies. Synthetic temporary SQLite databases and real child processes were used with PM2/installer/finalizer adapters. No live installation, service stop, reboot or startup configuration change was performed.

| Check | Passed | Failed | Skipped |
|---|---:|---:|---:|
| Broad upgrade/snapshot/self-upgrade Node suites | 276 | 0 | 12 |
| Owner/schema and C4 startup suites | 42 | 0 | 0 |
| Four targeted Jest suites | 19 | 0 | 1 |
| Focused final backup/recovery suites (overlap broad) | 67 | 0 | 1 |
| Focused reentry/startup/admission suites (overlap broad) | 24 | 0 | 0 |

The broad skips and the Jest skip are Linux-specific controller/bootstrap/takeover cases, not evidence that these cases passed on Linux. No full Jest-suite claim is made. The final standalone-refusal sentinel was strengthened after the broad run began and was separately covered by the final positive control and mutation check. Initial failed runs (obsolete helper fixtures, temporary-root canonicalization/fixture cleanup and dependency resolution) are retained in local evidence; the table reports corrected final runs. These rows overlap and must not be summed as unique coverage.

Production-path fixtures cover actual `runSelfUpgrade` failure into frozen compensation, new-finalizer failure after data-ready, and preinstall abort. Unknown finalizer exit retains admission; startup forbids automatic resume. Six concurrent Mac contenders admit exactly one owner, and owner death cannot reclaim the gate. These are isolated integration tests, not installed-host acceptance.

Seven known-bad mutations were caught: no maintenance sync, no snapshot-worker sync, nonexclusive admission, standalone resume bypass (unexpected material read), premature admission release, stale deployment cache, and stale startup dependency cache. Three explicit gate/cache positive controls passed. Mutation failures establish that the targeted assertions distinguish these faults; they do not establish hardware crash safety.

## Reproduce and evidence provenance

With existing compatible dependencies, run directly without dependency-installing pretest hooks:

```sh
node --experimental-test-module-mocks --test \
  cli/lib/__tests__/core-db-backup.test.js \
  cli/lib/__tests__/upgrade-*.test.js \
  cli/lib/__tests__/self-upgrade.test.js
npm pack --dry-run --ignore-scripts --json
git diff --check
```

The historical `macos-recovery-native.test.js` suite does not exercise this runtime and is excluded. Final package dry-run: 468 files, with no `cli/native/`, helper build script, historical native protocol test, or `node_modules` paths. The native source/binary remain in the repository as historical evidence and are excluded from the package.

Author-side raw logs are retained under `workspace/pr817-helper-necessity/`: `upgrade-suite-green.log`, `owner-startup-schema.log`, `startup-cli.log`, `jest-upgrade-existing-deps.log` (the three unchanged passing suites), `jest-contracts-final.log`, `finish-backup-recovery.log`, `finish-focused.log`, `finish-mutations.json`, `finish-mutations/*.log`, and `sync-mutations.json`. The author selfreview inspected source, controls and failures and found no production blocker; it is not independent approval.

Fresh independent review and Linux regression remain required. Intel Mac, minimum supported macOS/Node runtime, physical power-loss behavior and real installed-host upgrade/reboot acceptance are unverified by this revision. Earlier Linux boot evidence in `docs/self-upgrade-validation.md` belongs to its recorded source and must not be attributed to this patch. Merge, release, deployment and owner acceptance remain separate decisions.
