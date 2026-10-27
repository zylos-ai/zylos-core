# ZYLO-84 I2 acceptance supplement

Base: `832d1cd98224d220ccab5537ff8e9ac2809dcd1f`. Target: `multi-session/batch-2`.

This change adds explicit acceptance assertions for crash recovery, manual Origin control, start-attempt validation and cross-process recovery, injected rate-limit recovery, and the supplemental state/lifecycle checklist. It fixes two implementation defects discovered by those tests.

## Implementation defects

- Unparseable/nonobject socket requests omitted `requestId`. Generic invalid-request replies now explicitly return `requestId:null`. The request type remains unspecified when it cannot be parsed. Before/after and a source-revert control cover the change.
- A route-triggered recovery with no eligible target created a negative probe cache although no probe ran. This blocked next-round start admission after real input acceleration. The observer now returns an internal `noTarget` marker; routing leaves that result uncached. Actual failed/timed-out controls still create a cache. The marker does not appear in the socket protocol.

## Integration boundaries

The crash/manual tests run the production M4 entry in child processes with a real Unix socket, SQLite and shared isolated tmux. Runtime executables are harmless fixtures; activity and Sync facts are injected. The start-attempt suite runs production M1 and M4 in separate processes, actual admission and launch adapters, SQLite and isolated tmux. Clock, external runtime executable and control outcomes are injected; no model API or quota is used. Traces record process IDs, request/reply identity, durable health state and launches.

State derivation and rate recovery compose production owners with injected clocks/screens/control results. They are not labelled as process integration. Source-mutation runs use separate repository copies, never modifications to a simultaneously running positive test tree.

## Platform scope

Linux: Node v24.21.0, tmux 3.7c. No production tmux command, format or parser changes. The opt-in tmux stress test is not asserted by the ordinary runner.

Native macOS regression is centrally coordinated by Luna/Jinglever after the related I2 PRs are available, against each precise candidate head. It remains a separate gate; Linux does not stand in for it. No merge, deployment or release was performed.

P12 owns dashboard UI/Observer rendering and the interrupt producer. Core assertions here do not claim P12 UI acceptance. Mode-transition conflicts use real durable transition rows at the M4 boundary; they do not claim a completed P10 conversion.

## Detailed assertion map

| Plan filename | Actual assertions and subitems |
|---|---|
| `state-derivation.test.js` | `session-activity.test.js:14` main/subagent/old-session and late post; `:18` Claude tool_result-before-pre; `:24` Codex no pairing; `:44` restart tail across rotated logs. New `i2-state-derivation.test.js:41` (both runtimes) prompt screen/fresh statusline/interruption/grace/timeout retain tool and F4 busy; factual post closes tool. `:52` deliberately screen-clears-tools fails the same F4 assertion; `:60` three continuous rotations and disappearing/recreated directory keep factual tools until stop. |
| `supervisor-loop.test.js` | Existing `supervisor-loop.test.js:12` exact stage order; `:14` one group failure preserves the second; `:16` D9 suppression; `:18` overlap; `:56` serialized snapshot; `:83` damaged F9 still permits existing reclaim; `:98` transition completion still restricts current round; `:117` transition failure preserves observations/reclaim. New every-step exception table at `:136` covers 18 stages, both groups for group-local stages, next timer and recovery round; new busy-group/D9 test at `:153` proves ongoing busy state does not starve second group. Manual scope/conflicts also `supervisor-lifecycle.test.js:247`, `:288`, `:301`, `:459`, `:490`, `:502`. |
| `reclaim-policy.test.js` | `supervisor-lifecycle.test.js:129` message/run changes cancel TTL preparation; `:139` all five actual control terminal statuses (expanded to include failed/cancelled) recheck, busy rejects; `:149` Origin/starting/TTL-expiry exclusions; `:157` occupied startup capacity/LRU/all-busy/model_config discount; `:118` final conversation-race assertion preserves gate and stops nothing. New `:525` selects the oldest among three eligible idle groups in two different enumeration orders (not just a single eligible candidate). |
| `supervisor-startup.test.js` | `supervisor-entry.test.js:165` holds actual startup restoration pending, sends restart/manual through the real Sock, asserts closed admission/no scheduling/no F9, then releases restoration and confirms admission; `:74` bad F1 leaves mutation admission closed, restore failure cleans listener; `supervisor-loop.test.js:10` bad F1 no schedule; `supervisor-admission.test.js:24` restore before opening; `:41` corrupt F9 byte preservation; `supervisor-entry-negative-controls.test.js:40` real socket plus reset-to-empty negative control; `supervisor-assembly.test.js:20` corrupt F9 with continuing loop; `supervisor-health-persistence.test.js:77` missing/corrupt/F10 quarantine, cooldown/budget and repeated restoration; `supervisor-lifecycle.test.js:288` orphan manual fences retained/alerted, `:301` D9 diagnostics. Real crash/manual persistence is also covered by item1 integration tests. |
| `tmux-unavailable.test.js` | `supervisor-server-health.test.js:14` 59999/60000ms and 30min repetition; `:24` recovery reset; `:30` configured and web-console failure, overlapping advance; `:39` fallback; `supervisor-server-observation.test.js:23` timeout/error shape and no cached identity; `:33` >10min unknown; `:144` real isolated server unchanged across both errors, no process signals. Current T02 is observe-only: obsolete process-killing expectations are not introduced. |
| `legacy-state.test.js` | `supervisor-legacy-status.test.js:21` simultaneous real isolated legacy/Origin, separate F4 identity, unrelated newest transcript ignored, disappearance stops legacy writes; `:33` foreign PID/unobservable target cannot publish. |
| `rotation-sync.test.js` | `supervisor-lifecycle-acceptance.test.js:147` scope matrix with all three marker scopes and write failure/no-process checks; `:170` rotation scope and 299999/300000 boundary, run/session changes, write retry/no process; `supervisor-lifecycle.test.js:192` identity and marker/minimum interval; `:200` Origin checkpoint-only; `:209` backlog alert dedupe/manual suppression. |


## Six requested gaps

| Gap | Executable coverage |
|---|---|
| IF-32 inflight crash / manual intent | `i2-reclaim-crash.integration.test.js`: real M4 SIGKILL while the persisted inflight count is nonzero, row-driven continuation and manual-fence preservation; bad-reset/bad-clear controls. |
| IF-36 scene and field matrix | `i2-manual-scenes.integration.test.js`: modes/runtimes, exact replies and persisted intent, empty Origin, identity changes, conflicts, seven crash boundaries and unrelated runtimes. `i2-manual-router.integration.test.js`: separate real M1/M4, pause after actual paste, late Enter remains bound to old object, ledger completion before gate release; new Origin launch failure cannot revive intent. Existing manual-entry/manual-session/delivery tests supply lost-response and session-reset assertions. UI is explicitly outside this task. |
| IF-62 invalid protocol | `i2-protocol-start-attempt.test.js`: absent keys, null unparseable request ID, invalid reply variants, no launch/diagnostic, next-round fresh request and run IDs, valid reply positive control. |
| IF-63 every numbered case | `i2-if63.integration.test.js` and two fixtures: real separate M1/M4 processes, persisted grant before launch, contention, socket/transport/process failures, lost associations, run identity, active input acceleration and its negative control. Test names identify each numbered case; traces retain actual process IDs and the request/health/launch sequence. |
| DM-63 injected rate limit | `i2-rate-probe.test.js`: future and probe-driven expired cooldown, auth block and owner reconstruction, auth release preserves independent limit, later successful probe clears it; no-rate positive control. |
| Supplemental checklist | Seven-file mapping above; missing screen/tool, continuous rotation/directory loss, loop exceptions, all terminal states, actual LRU ordering and pre-restoration socket requests are now explicit assertions. |

## Negative controls

Separate copies mutate the socket null field, M1 reply validation, auth/rate preservation, final inflight recheck, unknown occupancy, newest legacy transcript, LRU order and early admission. Every mutant fails its expected assertion. The no-target cache source-revert control additionally fails real M1/M4 input-acceleration cases. Fixture-local deliberate bad variants cover crash gate clearing, run association/backoff and screen-derived tool completion; their normal implementations pass the same oracles first.

## IF-63 case-by-case map

Paths in this table refer to `skills/activity-monitor/scripts/__tests__/i2-if63.integration.test.js`.

| Contract row | Line | Asserted behavior |
|---|---:|---|
| ①,⑫ | 7 | Actual registered run READY and gone between M4 scans; scan preserves scheduling; early next request rejected; single launch matches persisted grant |
| ② | 12 | Two pending groups; one registered response, one actual launch matching request runId |
| ③ | 13 | M4 stopped and socket absent; one request, zero launches |
| ④a/b/d,⑤–⑨ | 14 | Held-reply timeout, actual invalid reply, actual connection close; no same-round retry; durable count/timestamp retained; fresh IDs; late reply ignored; elapsed backoff allows second grant; SIGKILL and fence interruptions |
| ④c,⑩ | 80 | Real incoming socket message in uncertainty permits user_message registration; second message inside 60 s cannot accelerate; health remains unavailable |
| ⑪ | 50,97 | Healthy Codex, Origin, single bypass; concurrent healthy/Origin bypass alongside previously backoff-blocked ordinary group |
| ⑬/⑬b | 57 | Bound other does not recount, Origin other does; stale doesn't consume association; actual observer + D3 result boundary |
| ⑭ | 63 | New runId after old exit binds new registration; probe doesn't double count |
| ⑮ | 67 | Two cycles of M4 kill/restart before probe; one conservative increment per lost association; next early grant rejected, later grant after enlarged backoff |
| ⑯ | 75 | Lost reply r1; actual Origin then G r2 launch without another request; r2 other increments (cannot consume r1) |
| ⑰a/b/c | 35 | Retry before prior notBefore; real message makes user_message grant; counters 1/4/3, rate cooldown zero, down timestamp current; actual launch follows |
| ⑰a′ | 45 | No message: new IDs before notBefore rejected; exact F10 bytes unchanged |
| Negative controls | 87,92 | Local deliberate missing-backoff and group-only-association defects fail the same positive oracle |


## Final Linux result and reproducible commands

The final combined activity-monitor and router regression reports **938 tests: 937 passed, 0 failed, 1 skipped**. The skipped test is the existing opt-in tmux matrix churn test, not one of the new acceptance cases. Complete output: [linux-regression.log](linux-regression.txt). The exact test-file list is [linux-regression-files.txt](linux-regression-files.txt); run from the repository root:

```sh
node scripts/run-node-tests.js $(cat docs/evidence/zylo84-i2/linux-regression-files.txt)
```

The changed-file regression for Linux/macOS uses the 11 files listed in [changed-tests.txt](changed-tests.txt):

```sh
sh docs/evidence/zylo84-i2/run-changed-tests.sh
```

The final combined run includes every changed test file. Separate recorded integration runs: IF63 **29/29**, and the three manual/crash suites **44/44**, both zero skips. Their complete logs are [if63-linux.log](if63-linux.txt) and [manual-crash-linux.log](manual-crash-linux.txt). Source-mutation commands and nonzero exits are recorded in [source-mutations.json](source-mutations.json) and [audit-mutations.json](audit-mutations.json). Restoring the old no-target cache condition gives **25 passed / 4 failed** on the same 29-case IF63 file; the failures are the three real-input health variants and the input-during-uncertainty scenario.

The first broad development run lacked the already-pinned PM2 test dependency in its reused local dependency tree. A task-local dependency overlay added that existing pinned package; the failed isolated PM2 test passed separately and is green in the final combined run above. No package manifest changes were needed.

Raw expected-failure output for every source mutation is in [negative-controls/](negative-controls/). Local workspace prefixes are redacted in published logs; original evidence is retained privately.

[IF63 process traces](if63-process-traces.json) retain all 29 case names, real child PIDs, request/reply identities, persisted scheduling counters and actual launches. Unrelated routine logs and local temporary-root names are omitted.
