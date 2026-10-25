# C final review corrections

Missing P04 pool resolution now explicitly marks capacity unavailable. The marker is reset on each configuration read and only set for the existing missing-dependency tolerance path. Eviction returns without sampling pending groups or reporting CONFIG_UNREADABLE in that case; the entry still logs the missing dependency once. An invalid capacity produced by an available reader remains an error. This is a temporary dependency boundary and is removed alongside dynamic-import tolerance during integration.

The actual entry regression runs six further rounds with the real missing module and no injected capacity, asserts exactly one P04 diagnostic and no eviction diagnostics, and verifies socket admission remains usable. The lifecycle regression checks deferred eviction and invalid resolved capacities. Both use the official isolated runner.

Validation: `node scripts/run-node-tests.js skills/activity-monitor/scripts/__tests__/supervisor-entry.test.js skills/activity-monitor/scripts/__tests__/supervisor-lifecycle.test.js` — **53 passed, 0 failed, 0 skipped**. Relevant source hashes and full log are adjacent.

The obsolete `scripts/e2e/issue-492-web-tool-watchdog.sh` and `issue-492-web-tool-watchdog-ab.sh` are deleted rather than replaced. They wait for tool-watchdog-state.json, whose only producer was removed as unreachable. A tracked-file reference scan found no external references to either script. This removes obsolete e2e acceptance; it does not claim replacement end-to-end coverage of the new observer. `obsolete-scripts.json` records the scope.

No production tmux command, format, parsing or process observation changed. Five-version matrix, performance measurements, whole-repository Node/Jest and native macOS were not rerun for these focused corrections. Transition exception isolation is handled by the B parent integration and reported separately. No merge to batch/Base/main, release, or deployment is included.
