# P08 scheduler review corrections

Scheduler routes are paired on creation and route edits. Endpoint-only edits reuse the saved reply channel and reset the target to its overall group. Invalid partial routes leave the complete task row unchanged. Clearing a reply removes both route columns while retaining the saved group.

## Review mapping

| Item | Implementation and evidence |
| --- | --- |
| D1 / B4 | Removed redundant saved-channel mismatch guard and its test. Status coverage is one mixed-row case. |
| D2 / B6 | State gating is four mode/loop cases, each with all three state files; timeout readback covers found, absent and query failure. |
| B1 | Removed source-rewriting entry, resolver, backfill and latest/tmux controls, their loader, and direct repeated raw migration. Single-mode child-process prohibition remains. |
| B2 | Loops live in daemon-dispatch.js. daemon.js starts unconditionally; entry guards and daemon-entry.test.js removed. No optional startup smoke test added. |
| B3 | Receive success is exit 0 plus ok:true; C/R use codes; T additionally needs persisted:[]; all other results are unknown. Removed strict receipt-field validation tests. |
| B5 | Removed send catch/category whitelist, P01 return-field revalidation and unused dependencies.now. |
| B7 | Target discovery lives once in SKILL.md; parameter references link to it. |
| B8 | Removed duplicate channel-name check and unused blockQueueUntilIdle/process.off; restored miss_threshold || 300; uncoded CLI errors use INTERNAL_ERROR. |
| Route pairs | Add requires both flags and both values; update merges fields before validating; endpoint-only edits reset saved group; clear removes both reply columns. Positive and negative CLI cases check full-row preservation. |
| Prior P3-2 | Real two-connection stale-row/done race preserves task/history completion after stale enumeration. |
| Prior P3-5/6/7 | Scheduler-specific error wording, uncoded INTERNAL_ERROR and dispatch/duplicate-skip/missed-window logs restored. Successful conditional update precedes stale-timeout logging. |

## Retained test mapping

- IF-48: receive transport/classification, successful accounting, definite failure, unknown outcome and exact-marker timeout readback.
- DM14-O05: single/multi main/missed loops ignore machine, origin and target state files.
- DM-58: saved targets, invalid targets without namespace writes, update/clear preservation, paired routes, endpoint-only reset, INSERT-trigger rollback, and single-mode no latest-message/tmux guessing. Resolver tests cover read-only environment lookup.
- DM-10: both historical schema fixtures preserve existing data, repeated owner migration entry is inert, and DDL/version-publish failures roll back.
- Existing CLI, database, time, timezone and daemon lifecycle regressions remain. The two-connection race and observable log cases cover real review findings.

Tests do not mutate product source. Independent reviewers supply mutation controls. Removed guards and strict receipt checks have no replacement tests. Ordinary field-only edits retain the existing route behavior; this revision adds no legacy data repair.

## Validation and limits

Final official runner: **240 passed, 0 failed, 0 skipped**, 12 files. `selection.json` records the exact command, file list and changed source hashes; `full-final.log` is authoritative. Earlier focused runs: runtime 66 passed; route/schema/CLI 47 passed. The final run additionally covers removal of the remaining P01 content-type guard after the focused runtime run.

No full repository Node/Jest suite, five-version tmux matrix, native PM2/macOS startup or true downstream business chain was run. No tmux command/format/parser product code changed. Tests with downstream stubs do not establish end-to-end delivery. P08 B must merge with or after P09 receive. No batch/Base/main merge, release or deployment is included.
