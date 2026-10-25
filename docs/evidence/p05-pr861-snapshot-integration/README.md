# PR861 scoped lifecycle integration validation

Tested source commit: `9513d8522688b72fa177328dc3b1db9a2b7dc79a`. Target branch base: `4a1fedac5e615350d7b7f5ac949fab1934953fff`. This revision integrates the approved lifecycle simplifications into the executable/status/diagnostic layer. The later B evidence-only merge does not change these tested sources. Final evidence commit and exact parents are recorded in the PR description.

## Result and scope

- Official isolated Node runner: **106 files, 863 tests, 862 passed, 1 opt-in skip, 0 failed** (`c-independent.log`, `c-selection.json`).
- Actual single/multi manual entry and session integration: **15 passed** (`c-manual-updated.log`).
- Focused shared-snapshot and null/Origin stop regressions: assembly **13 passed** (`c-stop-alias-regression.log`).
- Five-version tmux matrix: **All five supported tmux versions passed runtime/applicable Supervisor suites, real stress and expected failing guard control; source hashes unchanged**. Packaging requires all 3.2a/3.3a/3.4/3.7c/3.8 suite, stress and known-bad stages to pass and source hashes to remain unchanged. Exact commands, outcomes and counters are in `matrix-results.json` after final packaging.
- Whole-repository Node/Jest were requested and run on B; see the inherited PR860 complexity evidence for the existing failure set and baseline comparison. C's whole-repository/Jest, native macOS and downstream business integrations were not run in this revision.

C changes are limited to the manual adapter-stop wiring and shared-round-snapshot integration, including necessary adaptation to inherited A/B API removals. Broader C complexity changes remain out of scope. The existing executable, scoped status/diagnostic publishing, auth throttling, legacy-mode startup and retired-engine removal remain in this layer.

## Changes and regression mapping

| Change | Requirement / retained or updated regression |
|---|---|
| Remove fixed-target lifecycle wiring, synthetic expired-server input and caller post-stop confirmation | B4/B3; `supervisor-exits.test.js`, actual manual entry/session integration |
| Read run/session/runtime identity at hook and status publication boundaries while reusing the round process sample | B2/T02/T08; `supervisor-assembly.test.js`, sampled PID and replacement-session race |
| Metrics reuse sampled scenes and fences; confirmed stop updates matching run to absent | B2/T08; metrics refuses extra observe/D8 reads and health/exit stop regressions |
| Single-auth null scope invalidates matching Origin only, preserving replacement | B2/IF-28; assembly null/Origin stop regression and auth acceptance |
| Auth actions capture one fresh serialized authority/scene context; mutations retain their final checks | B2/IF-28/DM-63; auth acceptance and throttle suites |
| Main machine tasks use valid current-round Origin; unavailable or stopped sample is unknown | B2/T08; confirmed-stop integration and existing machine-task suite |
| SessionId checked at admission only; execution stops by runId at named Origin | B4/IF-36; actual entry rejection before admission, accepted session change, malformed/missing READY, renamed original/replacement cases |
| Corrupt request file remains corrupt while existing durable reclaim progresses | DM-54; durable entry and diagnostic acceptance |
| Cache v1/expiry assertions exercise the shared recovery gate, rather than its raw JSON reader | Inherited A cache simplification/DM-47; runtime-budget acceptance |

The actual admission-session negative control remains. Two obsolete controls for the deleted execution session guard and fixed-target stop implementation were removed with those contracts; they are not represented as passing controls for the new behavior.

## Measured quiet-round cost

Real isolated tmux **3.7c**, actual `createSupervisor` composition and process sampling, synthetic empty database, five measured rounds after warmup. Each round advances the fixture clock by 61 seconds. Counts are actual tmux subprocess invocations recorded by a wrapper; setup and cleanup are excluded.

| Fixture | Old C tmux calls / round | Final tmux calls / round | Old median ms | Final median ms | Old / final process-tree samples |
|---|---:|---:|---:|---:|---:|
| Origin only | 94 | 23 | 614.249 | 101.083 | 9 / 1 |
| Origin + 3 groups | 394 | 89 | 3157.903 | 388.239 | 39 / 4 |

Every sample had the same call count shown above. Final rounds read transition, drain-fence list and request store once each, and call full observe once; identity publication checks remain two per group. Raw five-sample outputs, maxima, harness, official-runner logs and method are packaged alongside this file. The 338-file probe/source verification matches the final probe copy to the C matrix source manifest.

This fixture excludes supervisor-main legacy and machine-task afterRound hooks. It measures quiet composed rounds with no pending messages, requests, fences or lifecycle actions. It is not a whole-daemon benchmark, and action paths intentionally recheck before mutation. Wall time includes wrapper overhead and depends on host load.

## Failed attempts retained

`c-independent-initial.log` records the first composed run: 862 tests, 841 pass, 20 fail, 1 skip. All 20 failures were traced to C fixtures retaining replaced contracts: deleted stopFixedTarget, execution sessionId veto/renamed-original cleanup, missing snapshot fields, and raw-cache validation. Those fixtures were updated; the final independent run above is green.

Earlier focused logs retain an incomplete metrics fixture (missing runDir), a directory-rotation failure assumption invalidated by the inherited append-only implementation, and the updated fail-closed eviction behavior for unobservable scenes. Read-only review also found health/exit/auth stop snapshot updates were missing; production fixes and focused regressions landed before final verification.

The initial baseline measurement lacked getLastActivity for the multi-group fixture. The fixture was completed with a current timestamp and baseline/final rerun; product source was not changed for measurement. Its initial failure log is retained.

## Reproduction

Run the exact paths in `c-selection.json` with `node scripts/run-node-tests.js`; that official runner isolates HOME/ZYLOS_DIR. For each supported tmux version, use the commands in `matrix-results.json` with that binary first on PATH and TEST_TMUX_BIN set to its absolute path. Stress requires at least 300 launch and 150 delivery rounds with churn; the external constant-true guard variant must fail.

For measurements, `prepare-round-probe.py` copies the requested tree and adds the test harness to an external checkout. From that copy run the official runner on `skills/activity-monitor/scripts/__tests__/round-probe.test.js` with ZYLOS_PACKAGE_ROOT pointing at the copy, TEST_TMUX_BIN pointing at the chosen binary, and P05_PROBE_OUTPUT pointing at a separate results directory. Do not overlap the benchmark with matrix stress. See `measurement-method.md` for scope.
