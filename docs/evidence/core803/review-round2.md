# PR817 review round 2

This revision follows review `5477329844` of base `092f51cc08668aa44e5d50ae18cdde69e8f53335`, Howard's same-PR simplification approval, and the owner-approved C08/A18 amendment. It is a review delivery, not production adoption or an exact-source machine-reboot certification.

## Disposition

| Finding | Current behavior and evidence |
|---|---|
| R1 | Pure-file material probe precedes strict validation/helper loading. No-material aliases, shared parents, group-writable/partial helpers and empty recovery roots permit normal opens. Existing damaged material remains fail-closed. Actual three-owner regressions are in material/schema tests. Positive material with missing stable deployment emits an isolated recovery cue. |
| R2 / simplicity 3 | Linux keeps the reliable kernel lock and process identity. macOS or missing Linux process/lock capability uses the original pipeline before creating transaction materials/stopping services; output explicitly reports `preInstallProtection=false` and reason. Platform regressions cover darwin and unavailable Linux capability. No protected macOS claim. |
| R3 | Original npm CLI root uses structural/canonical/tree identity checks rather than private recovery-mode checks. Real SQLite preinstall-abort regression verifies 0775 original CLI succeeds and preserves data. |
| R4 | Removed inherited process-wide prompt suppression. Each new session receives its recovery cue, blocked state cues even with live controller, conversation context avoids duplicate cue, and Codex READY appends to its kick prompt. |
| Simplicity 1 | Terminal transaction directories stay in place. Durable terminal/service/child-exit checks precede final marker removal. No archive or cleanup pointer. Incomplete child evidence preserves isolation. |
| Simplicity 2 | Direct detached npm/finalizer execution with timeout process-group kill and one process snapshot. Minimal Started/Pid/ExitConfirmed evidence replaces wrapper/nonce/intent protocol. Recovery observes a saved PID and never signals a possibly reused PID. |
| Simplicity 4 | Private SQLite backups are normalized to DELETE mode before SHA-256; direct readonly inspection uses integrity/version/existence without temporary copies or whole-table row hashes. Original live WAL behavior is retained. |
| Simplicity 5 | Ordinary no-material paths skip owner/mode checks entirely; original package directory permissions no longer reject abort. Strict provenance/mode checks remain for actual private recovery executable/material paths. |
| Simplicity 6 | Independent native closure is copied and probe-loaded once. Removed per-file closure hashes; fixed entry shape, three runner hashes and snapshot SHA-256 remain. |
| Small findings | Retired supervisor configure/verify surfaces explain removal; no saved PATH/socket/runtime teardown stack. Current-attempt unpublished staging is removed on publication failure. Prepublication begin failure reports no recovery requirement. Codex READY prompt corrected. |
| C08 / A18 amendment | Removed dedicated supervisor/capability gate/runtime argument helper. Stable builtin file discovery and normal-runtime cue remain. Existing machine startup is reused; absent/ineffective autostart means retained materials are handled at the next normal runtime launch. |
| PM2 followup | Nine non-upgrade CLI save sites skip saving active/uncertain recovery materials. Cold `jlist` startup banners are accepted. `resume` starts all originalServices regardless of dump status, verifies online, then saves. `status` stays readonly. |

## Verification

Final main suite: Jest **160/160**, Node **1155/1155**, no failures; `git diff --check` passed. Main tests use `npm test --ignore-scripts`; isolated fixtures exercise real SQLite/native dependencies and child processes. No install hook or production service action was run.

The complete C4 suite passed 314/317; failures are the same three pre-existing two-argument stdin CLI tests reproduced on the baseline in round 1. Scheduler passed 99/100; its timezone next-run ordering test is the previously reproduced baseline failure. These suites are not described as entirely green.

Focused final regressions include recovery 48/48 (including 0775 original CLI), file-only startup 11/11 (including lost stable deployment), retained-terminal Jest 9/9, PM2 parsing/restart ordering 2/2, and PM2 save/component restart checks 11/11. Earlier integration pass counts are not substituted for final main totals.

## PM2 reviewer experiments and limitations

Luna.coco reported isolated PM2_HOME/sandbox experiments at prior head `092f51cc` with PM2 7.0.3. Production PM2 and worktree were not changed. These component experiments establish:

- With a real maintenance transaction/marker, C4 control/DB were denied; activity-monitor stayed alive for 25 seconds and after five seconds launched a runtime with a SYSTEM RECOVERY TASK cue.
- `pm2 kill` and `resurrect --no-daemon` preserved the saved pre-stop list; daemon SIGKILL also preserved it and resurrect brought services online.
- Daemon SIGTERM rewrote the dump with stopped services. If activity-monitor is included, runtime cannot launch to run recovery. Reviewer agrees this is outside the revised automatic-handoff guarantee: next normal runtime startup resumes retained materials. The CLI save guard cannot intercept PM2's own signal handler or direct manual `pm2 save`.

This is not a real-machine end-to-end reboot of the new source. macOS/launchd and dispatcher/scheduler resurrect behavior under maintenance were not tested. Historical native A18 at `6a7fc19` used the retired supervisor and certifies only that source/mechanism.

Direct synchronous child launch has a deliberate fail-closed gap: controller death before the returned PID is durably saved leaves Started/no PID. No child disappearance is assumed; automatic compensation needs explicit exit evidence/manual resolution. This revision does not promise autonomous recovery for that interval.

No merge, release, owner acceptance or production upgrade is included.
