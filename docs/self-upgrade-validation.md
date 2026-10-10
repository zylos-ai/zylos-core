# Core #803 implementation validation

The initial delivery was checked against [the approved C01–C09/A01–A30 plan](https://github.com/zylos-ai/zylos-internal-docs/blob/764bee7d8a98025bea3ff7d54f0c76e0a985fbae/core/self-upgrade/self-upgrade-protection-plan.md). The approved content revision is `db6eadac` (merged without content changes at internal-docs `764bee7d`). That historical validation is based on core commit `fc66226e537d37ca35f108b940eecba6ce2bca86`. An independent pass covered maintenance, recovery, snapshots, schema guards, boot/runtime handoff, child-process containment, output and adoption.

Original delivery regression results are recorded in [test-summary.json](evidence/core803/test-summary.json):

| Suite | Result |
|---|---|
| Main Jest | 160/160 passed |
| Main Node | 1108/1108 passed |
| C4 owner | 302/305 passed; same three failures reproduced at baseline (281/284) |
| Scheduler owner | 100/100 passed |
| Web-console owner | 30/30 passed |
| Shared schema and actual owner entries | 21/21 passed |

`npm test --ignore-scripts` skips installation lifecycle hooks. Tests use isolated temporary databases and service fixtures. The unchanged C4 send CLI and its tests have the same three two-argument stdin failures at baseline. `git diff --check` passed. The [native reboot evidence](evidence/core803/native-recovery.json) pins the six tested module hashes to the original PR head `6a7fc19`. The subsequent review revision changes those modules; the historical real-boot result remains evidence for that earlier source and is not an exact-source reboot certification of the review revision.

## Historical initial-delivery findings and disposition

The following findings describe the initial delivery and its tests. Removed archive, cleanup-pointer, row-hash and supervisor mechanisms below are historical; current round-2 behavior is described separately.

1. **Dangling recovery paths silently disabled isolation.** `existsSync` ignored dangling marker, cleanup pointer, active transaction root, and fixed parents. Discovery now uses `lstat` presence and validates fixed parents. Six dangling-path fixtures preserve their links, create no target and reject ordinary DB entry.
2. **A READY label admitted incomplete/contradictory records.** Normal access now requires positive installation intent, fixed deployment/snapshot paths, snapshot identity, complete initial Node/package/CLI/worker/ecosystem/three-DB records, declared core-member backup identities, and original service records. These are durable structural checks, not comparisons against live DB bytes. All four READY phases continue to permit legitimate later writes.
3. **Incomplete terminal/provisional-abort records could hide active materials.** Verified terminals now require complete original records; installed terminals additionally require the protected snapshot/completed-backup shape. Verified preinstall abort permits incomplete code backup/no snapshot, but requires the complete original identity. Damaged records cannot skip active discovery or release ordinary openers.
4. **Discovery retained every admitted active JSON journal.** It now scans the bounded directory list but retains at most eight candidate journals. Overflow and scan-budget exhaustion produce blocking diagnostics; verified completed terminals do not consume that limit.
5. **Shared owner fallback used weaker phase rules when stable maintenance was absent.** The duplicated permissive classifier was removed. Missing stable maintenance plus any active marker/cleanup/transaction materials fails closed, including dangling paths and apparent completed terminals. First adoption with no materials (or an empty active root) still permits initialization. Actual C4, scheduler and web-console openers are exercised and create no DB on denial.
6. **Explicit new-finalizer failure after READY could retry into upgrade success instead of compensating.** Parent `recovery(ctx)` is the explicit failed-upgrade path. It now records isolation and a restoring continuation before strict stop; an unconfirmed finalizer exit preserves that restoring destination. Direct bootstrap interruption resume remains validation-only, and restored READY/verified terminals never compensate again. An actual child publishes READY and removes its marker, returns failure, and the real saved runner restores the original SQLite logical hash with `restored_complete`.

The original delivery audit did not find these additional normal-installation and startup defects. The review revision records and fixes them separately below; the original audit conclusion is historical and does not close the later review.

## Review round 1 revision

The review disposition and regression evidence are recorded in [review-round1.md](evidence/core803/review-round1.md). This revision fixes B1–B4 and M1–M9, including ordinary installations with shared metadata parents, zero-byte databases, and no declared boot supervisor. Existing recovery-owned materials still fail closed on unsafe ownership, permissions, links or inconsistent identity.

## Review round 2 simplification

The second review accepts B2–B4, M1–M9 and the original minor fixes. This revision narrows recovery validation to existing materials; removes terminal archive/cleanup pointers, launch wrappers and per-row database hashes; normalizes private snapshots to DELETE mode; and copies/probe-loads the independent native closure without per-file closure hashing. Runner-file hashes and snapshot SHA-256 remain. Linux controller serialization remains a kernel lock because a stale PID-file unlink can delete a successor lock. Unsupported environments retain the original upgrade path and explicitly report no preinstall protection.

A crashed launch without a durably known PID retains isolation and needs exit evidence. This smaller containment protocol does not promise autonomous recovery for that gap. Original A18 boot evidence is historical only, and the reviewed simplifications require new validation.

Howard subsequently approved replacing the dedicated C08 supervisor/capability gate with the existing PM2 → activity-monitor → normal runtime startup chain. File discovery and status/resume remain; without configured autostart, the next runtime startup resumes the task. The original A18 result used the retired dedicated supervisor and is historical evidence, not certification of this revised chain.

## Current round-2 evidence

Current regression totals and disposition are recorded in [review-round2.md](evidence/core803/review-round2.md). This source retains validated terminal directories and clears the marker last; READY access and final marker removal have separate durable child-exit requirements. Original readonly abort checks integrity/schema/existence and code identity without row-level hashes.

Reviewer luna.coco tested isolated PM2 7.0.3 and activity-monitor at prior head `092f51cc` (not production and not this source's complete reboot certification): core maintenance denied C4 while monitor stayed alive and launched a runtime with the recovery cue. Saved PM2 lists survived `pm2 kill`, `resurrect --no-daemon`, and daemon SIGKILL; daemon SIGTERM rewrote stopped statuses. The current revision guards non-upgrade CLI PM2 saves during recovery, accepts cold-daemon banners before jlist JSON, restarts all recorded original services, and saves only after online verification. Direct manual `pm2 save` and PM2 daemon signal handlers bypass this guard. If activity-monitor is saved stopped, automatic runtime handoff is not guaranteed; the next normal runtime launch discovers retained materials. macOS/launchd was not tested. Dispatcher/scheduler resurrect behavior under maintenance was not tested.

## Historical focused validation

The initial independent pass observed 97 passing maintenance/material/recovery/reentry/bootstrap/controller tests, 21 shared-schema/actual-opener tests, nine Jest discovery contracts, and three real-child/parent-failure tests. That initial main run included the explicit-failure regression. Exact source hashes and compact native evidence are included under `docs/evidence/core803`; credential-bearing disks, runtime sessions and raw logs are excluded.

## C01–C09 contract map

| Contract | Implementation and audit conclusion |
|---|---|
| C01 | Durable journal/installation-intent/child-exit evidence; strict READY and terminal record classification; boot/PID/start controller ownership; installed/abort boundaries distinguished. Legitimate writes after READY or verified abort are preserved. |
| C02 | Install intent precedes contained npm execution; failed parent/new-finalizer paths compensate through saved runner; all exit conditions verified before replacement. Preinstall failures only abort. Last explicit READY-failure gap fixed above. |
| C03 | Marker plus independent fixed-root discovery guard all shared owner openers; PM2 query/stop/recheck and bounded known-process wait. No component token/lease or optional FD scan. |
| C04 | Actual SQLite readonly `backup()` with integrity/version/SHA-256 evidence; staging publish/fsync; exactly three DBs, missing/sidecar distinction, N=1 feature-owned retention and warnings. |
| C05 | Old/new declared core union, per-member backup/restore, real root alias permitted, individual target links rejected, relative link bytes preserved; noncore dependencies excluded. Ecosystem restoration fsynced; missing ecosystem deletion requires creation provenance. |
| C06 | Shared pure schema inspection and transaction migration/stamping; actual owner dependencies in readonly preflight; future/unknown layouts rejected before writes; server two-store/monitor guards inspected and exercised. |
| C07 | Independent saved worker/native closure; original rescue generations retained; intent-based per-file continuation, snapshots never consumed; no service start during partial restoration; restored READY failure does not replace again. |
| C08 | Stable builtin file discovery and normal-runtime initial recovery prompt; existing PM2/activity-monitor startup chain reused after owner-approved C08 simplification. Bad materials cue diagnostics but cannot execute untrusted paths. Historical dedicated-supervisor boot evidence does not certify this new startup chain. |
| C09 | Shared JSON/human/C4 outputs, separate upgrade/compensation results, code-only success cleanup, retained snapshots/rescue/journals; terminal directories stay in place and marker-clear failures continue without compensation. First adoption explicitly requires a separate consistent snapshot and operator confirmation. |

## A01–A30 acceptance coverage map

This is an evidence map, not a claim that every environmental fault permutation was injected. “Fixture” denotes real SQLite/files/processes with isolated service adapters unless noted. “Reviewed” denotes the implementation branch and ordering were inspected; do not relabel it as a separate fault-injection test.

| ID | Evidence and practical coverage |
|---|---|
| A01 | `core-db-backup.test.js`: real WAL, two SQLite connections, both committed rows visible in backup, integrity/version unchanged; snapshot contents include committed rows; private snapshots use DELETE journal mode and direct readonly integrity checks. Continuous concurrent-write scheduling is not separately claimed. |
| A02 | Snapshot fixtures cover missing DB, orphan sidecar, missing driver/unopenable source; failure staging retained. Upgrade installation gate ordering reviewed. |
| A03 | Snapshot fixtures cover failed worker/driver and damaged material; prior complete group retained. Worker 90s/parent 120s deadlines and failure publication reviewed; separate real disk-full/90s-lock runs are not claimed. |
| A04 | Real complete publication/N=1 and unrelated-directory preservation exercised; retention validation/warning branches reviewed. |
| A05 | Recovery fixture restores declared before/new/removed members and ecosystem; core-only dependency regression preserves component/user package scope; local content/hash and node_modules exclusions inspected. |
| A06 | Legal skills-root alias, live/dangling individual skill links, nested metadata links and provenance rejection exercised. Recovery never invokes legacy whole-root restoration. |
| A07 | Output tests cover JSON/human/C4 format/status/compensation warnings; actual terminal cleanup/reentry fixtures preserve snapshot/rescue/journal and retain cleanup failures. |
| A08 | Actual deployed three-owner initialization/reopen tests and known C4 legacy migration confirm one stamp/migration and preserved records. |
| A09 | Future versions/unknown nonempty layouts reject; empty schema-0 databases initialize under a write transaction; injected DDL/data/version failure rolls back atomically. |
| A10 | Connection re-read/concurrent-initializer simulation, monitor fail-closed pending work, and actual web-console future-C4-before-session-cleanup test. Actual daemon/CLI/owner shared helper imports inspected. |
| A11 | v1 serialization/legacy failure contracts remain; v2 actual old child receives schema2/DB/core state. Honest first-adoption behavior and docs reviewed. |
| A12 | Actual three-DB/code/ecosystem compensation fixtures; actual old-child rejection and new-child post-READY failure run through parent and saved runner. Upgrade still reports failure independently of completed compensation. |
| A13 | Real file isolation and actual owner entry denial; failed stop adapter prevents rescue/replacement/start. Service discovery/query/stop/recheck and known-CLI bounded wait reviewed. Arbitrary external access is outside the contract. |
| A14 | Missing DB restoration, old WAL/SHM displacement, corrupted snapshot refusal and physical-rename interruption/reentry exercised with SQLite/native fixtures. |
| A15 | Actual restored owner schema/native dependencies checked before data-ready and service validation. Old owner lacking pure inspector fails explicitly; CLI remains newer by design. |
| A16 | All four READY phases resume validation; restored failure isolates without another replacement; new failure isolates and compensates. Last parent explicit failure now also compensates. |
| A17 | Partial-skill startup hook imports no normal C4/registry/formatter; builtin file prompts actively launch despite malformed journal. Isolated native boots observe C4 denial; normal-channel notification continuity is not promised. |
| A18 | Sanitized [native-recovery.json](evidence/core803/native-recovery.json): actual persisted-auth Codex/model, systemd PID1, same disk/two distinct boots, automatic status/resume, poweroff after physical C4 rename before intent completion, all three DB/core/rescue hashes restored, no half-start. The evidence verifies six source hashes at the original head `6a7fc19`; it does not certify the later review revision. Guest originalServices is empty; this does not prove nonempty production PM2 restart behavior. |
| A19 | Descriptor/layout/hash/Node redirects and malformed copied closure entry paths reject; malformed journals/markers, missing marker, conflicting/multiple materials and dangling fixed paths retain diagnostics/isolation. Genuine native malformed-journal boot evidence is separate. |
| A20 | Actual controller race/crash/flock tests reject duplicate ownership/PID reuse and support staged publication release; each-session recovery cues and partial-skill file-first prompt tests. |
| A21 | Actual child rejects schema2 after contained installation begins; parent independent runner restores original SQLite state, returns upgrade failure with completed compensation. |
| A22 | Actual pure owner readonly preflight executes behind marker; normal openers remain denied; missing DB no business file creation; actual owner native dependency loads. |
| A23 | Future/incompatible/old-owner-missing-inspector/native closure cases reject before READY; real snapshot damage and native-load incompatibility fail before replacement. |
| A24 | Trusted initial/preinstall abort and descriptor/snapshot absent cases; verified abort terminal permits normal access without restoring DB. |
| A25 | Injected terminal-write/marker-removal/service-restart failure and legitimate post-abort writes prove preserved isolation/continuation and no replacement. |
| A26 | Partial rescue/core restoration, physical install rename before done journal, ecosystem fsync and terminal marker-clear interruption fixtures resume intent without recapture or overwrite. A18 adds actual machine poweroff at one critical rename point. |
| A27 | All READY phases preserve committed normal writes; restored verification failure keeps current DB generation; new-code verification failure isolates then compensates once. |
| A28 | Direct detached installer/finalizer tests cover timeout/failure/success with descendants. Live caller kills and checks its process group; interruption before PID publication remains isolated, and recovery never kills a potentially reused saved PID. Unknown phases/hash/material conflicts never restore. No deliberately escaped sessions guarantee. |
| A29 | Initial journal without descriptor/snapshot, committed WAL/checkpoint, changed CLI tree/link, and abort-write/cleanup interruption exercised; durable intent and initial publication ordering reviewed. Not every preinstall phase has a distinct real-machine crash run. |
| A30 | 100 verified terminals plus real active transaction contract; incomplete/forged terminal shape and provisional abort regressions; residual marker continuation; 32-active bounded-memory fixture and exhausted scan budget fail closed. |

## Supported limits and trust boundary

- Protected baseline, stable file discovery, trusted Linux Node/flock/ps/PM2 and actual native owner dependencies are prerequisites. Automatic restart depends on the existing configured machine startup chain and available runtime credentials; no dedicated supervisor is installed.
- Private owner-written material is the provenance trust root. Structural/path/ownership/hash checks detect damaged, redirected, incomplete or inconsistent records; hashes are not signatures against an owner deliberately forging all coherent records and hashes.
- Strict managed-service isolation and identified-CLI waiting do not control arbitrary external sqlite3 clients, a program bypassing core entrypoints, or lifecycle scripts deliberately creating a new session. This limitation is already part of the simplified contract; no occupancy scan was authorized.
- Three DB snapshots/replacement are not cross-database atomic; accepted window data may be lost on compensation. Snapshot/rescue sources are retained.
- VM evidence uses synthetic databases, real copied owner dependencies, persisted authentication and an explicit private acceptance-helper contract. It never reads production DBs or proves production deployment readiness, nonempty PM2 restart, or channel availability during recovery.
- No merge, release or production first-adoption/upgrade is authorized by this audit. This validation supports code review; first adoption is a separate operator action.
