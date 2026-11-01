# Dev Plan: close the remaining multi-session supervisor contract gaps

## 1. Assignment and authority

This plan is for the developer and tester closing the seven confirmed ZYLO-99 gaps. It spans:

- `zylos-internal-docs`, branch `docs/zylo-99-origin-f9`, baseline `ddbdcaa4bbd1e765dd75abfdb51397ed9500b31d` (`origin/main`);
- `zylos-core`, branch `fix/zylo-99-contract-gaps`, baseline `a08d50e76d99d467ee134eecdd019df5fa51308d` (`origin/multi-session/base`).

Howard authorized implementation of all seven confirmed gaps and decided the only open behavior: when Origin submits `ready_for_config_reclaim` and F9 is unreadable, keep the old run/configuration, create no fence, and return an explicit retryable rejection telling the agent to repair the state and retry. Ordinary groups must not read F9 for this request.

The documentation contract is upstream authority. Its amendment, review, and merge to `zylos-internal-docs/main` precede the dependent Core behavior. The Core implementation must cite the resulting `main` SHA. This plan does not authorize either repository merge, any change to Core `main`, a tag, release, package publication, deployment, or the separate C4 test-isolation incident proposal.

Representative scenario: an Origin agent completes its handoff after a launch-configuration change. If `restart-requests.json` is corrupt, the supervisor does not guess that no manual restart is pending and does not reclaim the old run. It returns `requests_unreadable`; the CLI tells the agent to preserve the handoff, repair the supervisor restart-request state, and retry without exiting. Once repaired, the same run can retry and follow the normal idempotent admission path.

## 2. Scope and non-goals

In scope:

1. Publish every F4 field that both the current contract requires and the current implementation can derive authoritatively. The confirmed missing field is `unavailable_since` from F10 scheduling state.
2. Apply seven-day retention to rotated per-group event logs in valid existing runtime directories, including groups absent from the current tmux scene inventory.
3. Put timestamp, session group, and run ID on every statusline publication-failure row in F13.
4. Make F9 relevant only to Origin config-reclaim admission and implement the approved fail-closed Origin reply and retry guidance.
5. Send the required one-time owner alert when startup configuration is unreadable, while keeping scheduling and admission closed.
6. Remove intentionally stopped runs from volatile exit tracking after a confirmed normal or manual reclaim so they cannot later become `crash_detected`.
7. Emit `reclaim_cancelled` before ordinary reclaim throws `RECLAIM_INFLIGHT` after the final in-flight assertion. Preserve the existing keep-and-retry behavior for `model_config` and single-auth reclaim.

Out of scope:

- reviving old status fields that no current producer can derive (`thinking`, legacy watchdog fields, old source labels, or legacy foreground diagnostics);
- starting, adopting, stopping, or reclaiming a group merely because its runtime directory exists;
- inventing a fallback event when `ZYLOS_MODEL_CONFIG` prevents hook identity from being established;
- repairing or overwriting F9 automatically;
- changing the alert transport, retry policy, or `alert_target` fallback contract;
- changing crash classification for actual unexpected exits;
- changing the `model_config` or single-auth fence/retry semantics;
- implementing the C4 schema/test isolation incident recommendations.

## 3. Authoritative sources

- F4 fields and publication: `implementation-data-model.md` §6.4, especially lines 556–567 at the docs baseline; M4 §3.3 “状态文件”.
- F13 identity: M4 §3.3 “写失败”, especially line 790; DM §6.6.
- Retention: M4 §3.3 lines 816–821 and §3.5 line 870.
- Config reclaim: `implementation-interfaces.md` IB-41 and IB-43; M4 §2.11.1; M3 §4.1.
- Startup configuration failure: DM §5 lines 507–510 and the existing M4 system-alert transport in M4 §2.2.
- Exit classification: M4 §2.2 lines 131–138 and §2.3 line 339.
- Reclaim cancellation: M4 §2.3 lines 324–336 and §3.4 `reclaim_cancelled`.

The implementation must use the merged docs `main`, not this plan or an unmerged docs branch, as the final contract source.

## 4. Implementation tasks

### Task A — amend the Origin/F9 contract first

Repository: `zylos-internal-docs`.

Update the unique contract and all affected consumers:

- `core/session-architecture/implementation-interfaces.md`: in IB-41, state that ordinary groups do not read F9; for Origin, F9 unreadable returns `{ok:false,result:'rejected',reason:'requests_unreadable'}`, creates no D8 fence, and is retryable after repair. Add the eighth reason to the reply set and IB-43 reply matrix. State that the agent preserves its completed handoff and does not exit while repairing/retrying.
- `core/session-architecture/zylos-session-m4-pool-supervisor.md`: in §2.11.1 admission ordering, add the ordinary/Origin split and the fail-closed F9 branch without changing other admission precedence.
- `core/session-architecture/implementation-plan-p05-m4-supervisor.md`: reconcile its admission pseudocode and acceptance mapping with the amended contract.
- Reconcile the paired current visual artifact if its rendered contract text contains the affected M4/IB-41 statements. Do not edit history documents.

Completion condition: the current docs contain one consistent definition of the new branch, the examples/reply matrix accept it, no text implies ordinary groups consult F9, and the docs PR is independently reviewed and merged to `main`. Record the merged SHA before dependent Task E. Independent Tasks B–D and F–H may proceed after this plan is Ready while the docs PR is reviewed.

```text
request group is not Origin → evaluate config-reclaim admission without reading F9 // IB-41
request group is Origin AND F9 read fails → reject requests_unreadable; write no D8; keep old run/config // IB-41; M4 §2.11.1
agent receives requests_unreadable → preserve handoff; repair F9; retry same run; do not exit // IB-41; M3 §4.1
Origin F9 read succeeds → continue existing manual_restart_pending and config checks // IB-41; M4 §2.11.1
```

### Task B — publish the authoritative missing F4 health field

Files:

- `skills/activity-monitor/scripts/status-writer.js`
- `skills/activity-monitor/scripts/supervisor-legacy-status.js`
- `skills/activity-monitor/scripts/__tests__/scoped-status-writers.test.js`
- `skills/activity-monitor/scripts/__tests__/supervisor-legacy-status.test.js`

Project `scheduling.unavailableSince` to `unavailable_since` only when the public health is `unavailable` and the source is a positive safe integer, matching the 0.9.1 status-writer behavior. Keep `rate_limit_reset`, `cooldown_until`, and `unavailable_reason` as they are. Use the same projection helper for grouped and migration-only legacy publication so their health-field semantics cannot drift.

Do not add source-less legacy fields. The exhaustive disposition is: identity, runtime, state, activity, tool details, process sample, public health, reason, rate-limit reset/cooldown and unavailable-since have current sources; old thinking/source/watchdog/foreground-specific fields do not.

Completion condition: grouped and legacy status output include `unavailable_since` for an unavailable health record with a nonzero authoritative source, omit it for ok/rate-limited/zero, and preserve existing fields.

```text
public health is unavailable AND scheduling.unavailableSince > 0 → publish unavailable_since // DM §6.4; 0.9.1 status-writer
otherwise → omit unavailable_since // DM §6.4; existing health projection
```

### Task C — maintain rotated logs for existing non-present groups

Files:

- `cli/lib/session-group-paths.js` for the shared runtime-group root path if no current exported helper owns it;
- `skills/activity-monitor/scripts/supervisor.js`;
- `skills/activity-monitor/scripts/__tests__/supervisor-assembly.test.js` or a narrowly named adjacent maintenance test.

At the existing once-per-minute maintenance point, build a deduplicated set of files from:

- supervisor diagnostics and pool metrics;
- the current scene event logs;
- `events.jsonl` under every valid, real directory directly beneath the shared runtime-group root.

Use directory entries without following symlinks, skip invalid session-group names and non-directories, and tolerate a missing root. Calling `rotateEventLog` on a missing live file is allowed because it still removes expired rotated siblings. Directory discovery is filesystem maintenance only: it must not call scene observation, admission, launch, stop, fence, or reclaim paths.

Completion condition: an expired rotated log in an absent valid group is removed; a recent rotated log and current log remain; invalid names, regular files and symlinks are untouched; no group lifecycle action occurs.

```text
maintenance interval not due → do nothing // existing supervisor cadence
interval due → collect current files plus valid direct runtime-group directories // M4 §3.3; M2 path ownership
candidate is invalid, non-directory, or symlink → skip // M2 group/path boundary
valid directory → rotate/retain its events.jsonl without observing or activating the group // M4 §3.3
```

### Task D — identify statusline failures in F13

Files:

- `skills/activity-monitor/scripts/context-monitor.js`
- `skills/activity-monitor/scripts/__tests__/scoped-status-writers.test.js` or a dedicated CLI-level statusline test.

On statusline parse/publication failure, append one line containing the ISO timestamp, derived session group, and `ZYLOS_RUN_ID`, plus the existing failure description. For a managed grouped/single run, use the same `runDirFromEnv` identity rules as successful publication (`origin` for single). If identity itself is invalid or absent, use explicit `unknown` values in the human-only error row; do not guess a group and do not emit a normal event.

Completion condition: a bad managed statusline row contains the exact group/run identity, a legacy/invalid environment produces explicit unknowns, and the hook remains non-blocking even when the error log cannot be written.

```text
statusline publication succeeds → no F13 row // F5; existing behavior
publication fails AND managed identity resolves → append timestamp + session_group + run_id + failure // M4 §3.3 F13
identity cannot resolve → append timestamp + explicit unknown identity if possible // M4 §3.3 failure boundary
F13 append fails → swallow and exit without blocking the agent // M4 §3.3
```

### Task E — implement the merged Origin/F9 admission contract

Files:

- `skills/activity-monitor/scripts/supervisor-admission.js`
- `cli/lib/am-sock-client.js`
- `skills/activity-monitor/scripts/supervisor-request.js`
- `skills/activity-monitor/scripts/__tests__/supervisor-admission.test.js`
- `skills/activity-monitor/scripts/__tests__/supervisor-entry-negative-controls.test.js`
- `skills/activity-monitor/scripts/__tests__/supervisor-request.test.js`
- `cli/lib/__tests__/am-sock-client.test.js`
- `cli/lib/__tests__/am-sock-field-matrix.test.js`

Restructure only the config-reclaim dispatch so ordinary groups reach `config()` without `RestartRequestStore.read()`. Origin reads F9 inside the same serialized admission section; `requests_unreadable` becomes a valid IB-41 rejection reason and writes no D8. Preserve all existing order and outcomes after a successful read.

Map that reason in the requesting CLI to an actionable message: preserve the completed handoff, repair the supervisor restart-request state, retry, and do not exit. Keep the machine-readable code `requests_unreadable`; do not expose plan/contract IDs in product text.

Completion condition: a poisoned F9 cannot affect an ordinary group request; the same poison makes Origin return a valid retryable rejection with no file rewrite/fence/stop; after repair, Origin can retry normally; protocol validation accepts only the newly documented branch.

```text
ordinary group request → skip F9 read; run existing config checks // merged IB-41
Origin request → read F9 inside serialized admission // merged IB-41
Origin F9 throws requests_unreadable → rejected(requests_unreadable); no D8 and no lifecycle mutation // merged IB-41
Origin F9 succeeds and contains manual_restart → rejected(manual_restart_pending) // IB-41 existing order
all checks pass → set model_config D8 before accepted reply // IB-41 existing commit point
client receives requests_unreadable → classify as retryable rejection and print repair/retry/no-exit guidance // IB-41; IB-43
```

### Task F — alert once on unreadable startup configuration

Files:

- `skills/activity-monitor/scripts/supervisor-loop.js`
- `skills/activity-monitor/scripts/supervisor.js`
- `skills/activity-monitor/scripts/supervisor-main.js` only if dependency wiring is required;
- `skills/activity-monitor/scripts/__tests__/supervisor-loop.test.js`
- `skills/activity-monitor/scripts/__tests__/supervisor-assembly.test.js` or `supervisor-main` tests for the actual alert path.

When the initial strict configuration read fails, keep `configurationError`, do not restore/open admission/schedule a round, log the error, and call the existing supervisor system-alert transport once with a functional event name and error reason. Alert delivery failure is logged and must not make the daemon schedule work or repeatedly retry from the loop.

Completion condition: one alert attempt occurs per supervisor process start, the configured target/Web Console fallback is reused, admission remains closed, no timer or lifecycle work starts, and an alert failure leaves the same fail-closed state.

```text
initial strict config read succeeds → continue restore and open admission // existing SupervisorLoop
initial strict config read fails → retain configurationError; report; attempt one owner alert // DM §5
alert succeeds or fails → return without restore, admission, timer, or scheduling // DM §5
later tick or repeated start on same loop → no second alert and no scheduling // one-time startup boundary
```

### Task G — forget confirmed intentional stops before exit classification

Files:

- `skills/activity-monitor/scripts/supervisor-exits.js`
- `skills/activity-monitor/scripts/supervisor.js`
- `skills/activity-monitor/scripts/__tests__/supervisor-exits.integration.test.js`
- `skills/activity-monitor/scripts/__tests__/supervisor-assembly.test.js` and/or `supervisor-restart-entry.integration.test.js` for the real lifecycle wiring.

Add a narrow `SupervisorExits` operation that removes a previous observation only when group and run ID match. Invoke it after `scenes.stop(scene)` has confirmed the requested tmux is gone, before a future observation can classify that run. Do not forget before stop confirmation and do not delete a replacement run tracked under the same group.

Completion condition: successful ordinary and manual reclaim of a primed old run produces `reclaim_done`/`manual_restart_done` but no later `crash_detected`; an adapter stop failure retains the old observation; a different replacement run is retained; a real ungated unexpected exit still emits exactly one `crash_detected`.

```text
adapter stop throws or cannot confirm target gone → keep previous exit observation // M4 §2.3 stop boundary
adapter stop confirms target run gone → forget only matching (group, runId) observation // M4 §2.2–2.3
next exit pass sees intentionally stopped old run absent → no crash classification // M4 §2.2
ungated run disappears without confirmed intentional stop → existing crash_detected path // M4 §2.2
```

### Task H — record ordinary final-assertion cancellation

Files:

- `skills/activity-monitor/scripts/supervisor-lifecycle.js`
- `skills/activity-monitor/scripts/__tests__/supervisor-lifecycle.test.js`

When the post-idle in-flight assertion becomes nonzero for an ordinary fenced reclaim, clear the fence, reset TTL when applicable, emit `reclaim_cancelled` with functional reason `inflight_after_idle`, then throw `RECLAIM_INFLIGHT`. Keep current exceptions: single auth returns `waiting_inflight` without a fence/cancellation; `model_config` retains its fence and throws without claiming cancellation.

Completion condition: the diagnostic is committed before the thrown error for ordinary TTL/evict/upgrade/auth/mode-switch; TTL reset remains; `model_config` and single auth retain their existing fence/retry and diagnostic behavior.

```text
final count is zero → continue stop path // M4 §2.3 [c]
final count nonzero AND single auth → waiting_inflight; keep auth block; no cancellation event // M4 §2.3 exception
final count nonzero AND model_config → retain fence; throw RECLAIM_INFLIGHT; no cancellation event // M4 §2.11 exception
final count nonzero AND ordinary fenced reclaim → clear fence; reset TTL if ttl; emit reclaim_cancelled(reason=inflight_after_idle); throw RECLAIM_INFLIGHT // M4 §2.3 [c], §3.4
```

## 5. Executable acceptance matrix

All Node tests run only through `node scripts/run-node-tests.js ...` with fresh isolated `HOME`, `ZYLOS_DIR`, `PM2_HOME`, and short `TMPDIR`. Never invoke `node --test` directly. No test may point at the live Zylos tree or production C4 database. The implementation plan and test outputs are not product evidence files and must not remain in the final PR.

| Behavior | Fixture and action | Required observations | Discriminating known-bad control |
|---|---|---|---|
| F4 unavailable time | Publish grouped and legacy state for unavailable/ok/rate-limited records with `unavailableSince` 0 and positive | only unavailable + positive publishes exact `unavailable_since`; all identity/activity fields remain | delete the projection; the positive unavailable case fails while omission cases pass |
| Absent-group retention | Create valid absent group with current, expired rotated, recent rotated logs; add invalid name, regular file, symlink; run due maintenance with empty/current-unrelated scenes | expired valid rotated file gone; current/recent/invalid/symlink targets unchanged; no observe/start/stop/fence call | maintain only current scenes; absent expired file remains |
| F13 identity | Run statusline entry with bad JSON under grouped, single, and legacy/invalid identity environments | grouped/single line has exact timestamp/group/run; legacy/invalid has explicit unknown; the hook exits successfully without blocking the agent | remove group or run field; corresponding assertion fails |
| Ordinary F9 independence | Poison F9 and submit config reclaim for an ordinary group | normal existing result from run/config checks; F9 bytes unchanged; no F9 read spy call | unconditional store read causes request failure |
| Origin F9 fail-closed/retry | Poison F9, submit Origin request, then repair F9 and retry | first reply is valid rejected/`requests_unreadable`, no D8/stop/file rewrite; CLI guidance contains repair/retry/no-exit; second request follows normal result | treat poison as empty; first request incorrectly creates D8 |
| Startup config alert | Initial reader throws; alert succeeds and separately throws; call tick/start again | exactly one alert attempt, error logged, admission closed, zero timers/round actions in both cases | omit alert call; positive count assertion fails |
| Intentional stop exit memory | Prime exit tracker, execute confirmed ordinary and manual stop, clear their gates, then observe again | no `crash_detected`; matching old run forgotten; replacement remains; real unexpected exit positive control emits once | remove forget call; old run is misclassified after gate removal |
| Final in-flight cancellation | For each ordinary reason, make first count zero/idle true and second count nonzero; repeat for model_config and single auth | ordinary: fence clear → event with `inflight_after_idle` → throw; model_config: fence retained/no event/throw; single: waiting/no event | omit event; ordinary order/assertion fails while exception cases remain green |

Relevant targeted self-test commands will be enumerated in the delivery note from the changed files. Full Node/Jest/opt-in e2e, mutation testing, environment snapshots, and trial merge are Luna's review/acceptance work, not the development author's self-test burden.

The tmux five-version matrix is not expected to apply because these changes neither construct/parse tmux protocol values nor change runtime adapter commands. Review must still state this with a diff-based reason. Real-tmux integration remains necessary for the intentional-stop versus actual-crash classification because that behavior crosses the adapter stop boundary.

## 6. Review and delivery gates

1. Commit and push this temporary plan, then obtain independent plan review against all seven implementation-plan standards and every pseudocode pass condition. No product or contract edit starts before plan `Ready`.
2. Implement and independently review Task A. In parallel, independent Tasks B–D and F–H may proceed on the Core branch. Each task is independently testable; safe intermediate commits must not weaken existing fail-closed behavior.
3. The docs PR must be merged to `zylos-internal-docs/main`; record the exact merged SHA. Only then implement dependent Task E from that merged contract.
4. The author runs only related self-tests and supplies commands, counts, exit codes, file/test locations, new mechanisms with contract sources, and unresolved items. Test evidence stays out of both repositories.
5. Luna reviews the whole Core PR against the merged docs SHA and this plan: correctness, acceptance mapping, isolation, targeted negative controls before approval, whole-PR complexity, and trial merge to `multi-session/base`. Every product-code path must map back to a task/pseudocode step; every claimed contract behavior must cite merged docs lines.
6. Remove this temporary plan before final acceptance. Howard separately decides any docs/Core merge not already granted. No release or deployment follows from acceptance.

## 7. Downstream handoff and unresolved items

- The Core PR description must name the merged internal-docs SHA that owns the new IB-41 branch.
- Dashboard and other F4 readers need no schema change: `unavailable_since` is an existing contracted field restored from an authoritative source.
- Existing runtime directories remain non-authoritative inventory; retention scanning must never be reused as a session-discovery mechanism.
- No design decision remains open in this plan. If implementation reveals that the existing alert transport cannot be called before configuration is available, report the concrete call/target failure and propose the minimum contract amendment; do not invent a second alert channel.
- Tests and product-visible names use functional names only; plan/contract identifiers may appear only in design documentation and review traceability.

