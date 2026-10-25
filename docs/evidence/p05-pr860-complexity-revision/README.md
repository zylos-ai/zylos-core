# Lifecycle simplification validation

Revision requested for B1–B7. PR860 builds on A PR859 at c8d07d4bec4b5919b58432541d7f97ed7fde09cd; target batch base remains 4a1fedac5e615350d7b7f5ac949fab1934953fff. Ordinary commits implement changes; separate merge commits integrate the parent.

## Scope and regression mapping

| Change | Coverage |
| --- | --- |
| Retain reclaim fences on observation, Sync, or DB errors; unified once-only alert | T05 / B1 lifecycle unit and real reclaim crash recovery |
| Capture configuration, transition, fences, restart requests and scenes in one serialized round; mutation/stop revalidation | B2 loop single-snapshot count, quiet no-reread assertions, replacement snapshot tests |
| Corrupt restart intent blocks new actions but preserves existing durable reclaim | DM54 loop/lifecycle regression |
| Trust successful adapter.stop confirmation; manual named Origin + expected runId; sessionId admission only | B3/B4 manual single/multi crash windows and execution session change |
| rotate_done belongs to SupervisorExits only | B5 lifecycle and exit tests |
| Single manual fence pass and common blocking predicate | B6 loop count and orphan/blocked cases |
| Restart and self-upgrade restart step accept injected submission dependency | B7 actual Unix socket outcomes, no source-text rewriting |

Full producer acceptance covers the exported post-install restart step and reply formatting, not the whole installer. Each producer submits once for accepted, refused, uncertain, and timeout results. The hand-written duplicate-submit fake was removed; a reviewer can add a second submission in an external checkout and run the same assertion as a manual negative control. That manual mutation was not executed in this revision.

Actual mutations deliberately refresh relevant authorities and target identity. Snapshot-wide observation failure aborts the round with its existing error report and preserves fences; per-scene/reclaim read failures use alertOnce. No new compatibility layer or production deployment is included.

## Results

- Related official Node selection: **80 files, 796 tests, 795 passed, 1 opt-in skip, 0 failed**.
- Full official Node entry: **2395 tests, 2273 passed, 94 failed, 28 skipped**. This entry is not green.
- Old B `03d511ab04b99c87a2724764d8ae2a1c0db3fbb1`, same 19 failing files through the official runner: **281 tests, 186 passed, 94 failed, 1 skipped**. The emitted named failure multiset matches exactly: no new or baseline-only failure entries. Node emits 93 named failure entries for its 94 reported failures on both runs. All 19 test files are unchanged between old B and this revision. Failures include stale getActiveAdapter imports, legacy C4 API expectations, and getLastCheckpoint callers; they are retained rather than hidden. See b-failure-comparison.json and both logs.
- Jest official entry with --runInBand: **13 suites, 160 tests, all passed**.
- Initial full Node/Jest attempts lacked test-only scheduler/web-console dependency links. Existing installed dependency directories were linked without installation or product changes; initial logs are retained separately. Corrected results above use those links.
- tmux **3.2a / 3.3a / 3.4 / 3.7c / 3.8**: final runtime/Supervisor suites and real launch/delivery stress passed, and external constant-true guard controls failed as required. Each stress completed 300 launch rounds / 150 delivery rounds, 604 launches / 600 sends / 1200 reads, with zero errors, server loss, foreign/missing lines or duplicates.
- Initial 3.3a suite hit a tmux timeout during concurrent test execution. An isolated serial rerun passed without source, timeout or assertion changes. Both initial and final logs and stage metadata are retained.
- Matrix source hashes remained unchanged and match the packaged tree. Supplemental hashes bind component.js and restart.js, which are outside the matrix's standard source-manifest scope.

All Node commands use scripts/run-node-tests.js with isolated HOME/ZYLOS_DIR. The full and related entries ran at `ad94f9015f385ca6210d2ab4f83dd9ab68fb5911`; this evidence-only commit does not change source. Exact selections, commands, exit codes and binary hashes appear in the retained artifacts. Cross-module business integration and native macOS execution remain outside this local validation. Per-round call-count measurements require the composed C implementation and are reported separately; this report makes no benchmark claim.
