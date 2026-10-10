# PR817 review round 1 disposition

Revision of original head `6a7fc19`, addressing luna.coco review `5477235359`. This is code-review delivery; owner acceptance remains pending.

| Item | Change and regression evidence |
|---|---|
| B1 | Owned real legacy `.zylos`/`.backup` shared parents at 0775 are accepted; feature-owned recovery paths retain strict checks. Bootstrap deployment errors in init/postinstall are nonfatal warnings. Material/startup suites cover shared parents and unsafe recovery roots. |
| B2 | Initial identity, skill validation, PM2 query and boot verification precede active publication. A complete durable journal plus live controller is staged outside discovery, then renamed and parent-fsynced. Publication suite covers prepublication failures and controller relocation. Incomplete private staging is retained outside discovery for diagnostics. |
| B3 | beginUpgrade deploys the stable bootstrap. Capability verification runs before active publication, stop and snapshot, and is conditional on declaration. A present invalid declaration still rejects; absent declaration records unverified manual recovery support. |
| B4 | Regular empty schema-0 DBs initialize regardless of which process created the file. Emptiness is rechecked under BEGIN IMMEDIATE; all three owner entries share the guard. Process-death/zero-byte and synchronized concurrent-init regressions pass. Unknown objects and readonly initialization still reject. |
| M1 | Deployment/skills/temp/cwd identities use canonical realpaths; discovery and recovery agree with configured supervisor root. Alias fixtures pass. |
| M2 | Verified live controllers are observe-only. Automatic runtime launch is limited to actionable blocked/no-intent recovery; READY and terminal cleanup do not spawn another runtime. Dedicated recovery session is stopped when inactive. Supervisor regressions pass. |
| M3 | Startup distinguishes active from blocked. READY preserves ordinary C4 context and permits writes; nonblocking recovery cue is emitted once across launcher/checkpoint/conversation paths. |
| M4 | Stable owner/mode/link validation precedes dynamic loading. Discovery exceptions use a fixed isolated diagnostic prompt and still start the runtime. Actual tmux, Claude, Codex and C4 paths covered. |
| M5 | Data-ready publication refreshes the parent journal; later ecosystem/finalizer updates reread phase and creation provenance. Missing ecosystem regression passes. |
| M6 | Resume rereads and validates journal after controller acquisition; stale pre-lock phase/provenance cannot overwrite the winner. Recovery race regression passes. |
| M7 | Synchronous post-spawn parent may assert launcherReturned only for its own verified boot/PID/start identity; other live launchers remain denied. Wrapper nonce absence remains required. Canonical TMPDIR/cwd and exit-confirmation regressions pass. |
| M8 | Originally missing ecosystem uses validated original service names/current PM2 records and restarts by name. Originally present missing/unsafe ecosystem fails closed; legitimate new ecosystem changes remain permitted after READY. Service fixtures pass. |
| M9 | Configure persists a bounded absolute-literal runtime PATH; capability probe and bootstrap launch both use that exact saved PATH. Environment mismatch/invalid PATH regressions pass. |

Minor dispositions:

- Rollback runs only while inTransaction and preserves the original error; schema-version diagnostics distinguish invalid versions.
- Recovery runner timeout is 1800s; finalizer reports the actual failure step.
- Readonly restored WAL sidecar creation was reproduced and fixed using hash-verified private disposable inspection copies. Live WAL reads remain unchanged; no source sidecars are removed. Backup/material/recovery tests pass. Inspection needs temporary disk space for one DB.
- Active/staging/metadata links are parent-fsynced, including deployment-root fsync after recursive creation of `.backup`; independent audit identified and checked that final fix.
- Recovery modules formatted for review. Docs distinguish approved content `db6eadac` from merge `764bee7d`, the supported `/usr/bin/tmux` path, and historical system-unit fixture from generated user unit.
- Discovery caching is deferred: a root-directory timestamp does not invalidate changed journal bytes or permissions. Absent materials use cheap stat checks; active/terminal-heavy scans retain fresh bounded validation. This performance item remains nonblocking.

## Validation

| Suite | Result |
|---|---|
| Main Jest | 160/160 passed |
| Main Node | 1154/1154 passed |
| Final publication suite after deployment-root fsync fix | 6/6 passed |
| C4 owner | 309/312; same three unchanged c4-send stdin failures as original delivery/baseline |
| Scheduler owner | 99/100; timezone-order test reproduced against unchanged `6a7fc19` |
| Web-console owner | 30/30 included in main Jest |

The scheduler test compares next Shanghai 09:00 to next UTC 09:00 without fixing the reference clock. Between those daily occurrences, Shanghai's next occurrence is tomorrow and UTC's is today, reversing its unconditional assertion. The exact same failing test and values were reproduced on archived original source with isolated temporary data and unchanged dependencies; scheduler behavior was not altered to satisfy that assertion.

Main tests ran with `npm test --ignore-scripts`, without dependency installation. The final parent-fsync addition was checked afterward by the publication suite; subsequent finalizer whitespace formatting has no semantic change. Final `git diff --check` passed. An independent read-only audit covered B1–B4/M5–M7 and found no further concrete defect after the fsync correction. It did not reproduce machine power loss or simultaneous initiation of two distinct upgrades.

Historical native A18 evidence remains pinned to `6a7fc19` and its six source hashes. The revised source is not certified by that old real-boot run. Synthetic databases, empty original guest PM2 service list and private acceptance-helper boundaries remain. No production upgrade, first adoption, merge or release is included.
