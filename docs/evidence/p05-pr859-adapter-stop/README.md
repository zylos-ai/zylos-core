# PR859 adapter-stop contract revision

Ordinary revision parent: `4f6d157cf203060ad7889d16bc0c65927bf2f847`. Target base: `4a1fedac5e615350d7b7f5ac949fab1934953fff`.

Manual restart admission now saves the run identity without a fixed tmux descriptor. The fixed-target observation/stop implementation and forwarding methods are removed. The existing `SupervisorScenes.stop` delegates to SessionAdapter with `tmuxName` and `expectedRunId`; downstream lifecycle execution uses that path. This layer does not claim downstream B/C integration is already complete.

## Scope and test mapping

- B4 / IF-36: remove fixedConnection, verifyFixed, observeFixedTarget and stopFixedTarget; remove F9 tmuxTarget capture and validation. Three obsolete fixed-target tests are removed. Existing adapter and health-stop replacement-run protection remains.
- Admission-only sessionId contract: the new admission regression rejects a mismatched optional sessionId, accepts a matching one without a tmux descriptor, and preserves request-id idempotency after the live session changes. expectedSessionId remains in the durable row solely for request equivalence; execution no longer rechecks it.

## Results

- Official isolated Node runner: 68 files, 710 tests, 709 passed, 1 opt-in skip, 0 failures.
- Focused scenes/admission/server-observation suites: 28 passed, 0 failures.
- tmux 3.2a, 3.3a, 3.4, 3.7c and 3.8: runtime/applicable Supervisor suites passed. Each real adapter stress run completed 300 launch rounds and 150 delivery rounds: 604 launches, 600 sends and 1200 reads, with no errors, server loss, foreign/missing lines or duplicates.
- Each version's external constant-true tmux-guard mutation failed as required. The retained positive source was not modified for this control.
- All 285 recorded cli/lib and activity-monitor source hashes remained unchanged during the matrix and were rechecked before packaging this evidence. This evidence is committed with the matching sources.
- Whole-repository/Jest, native macOS and cross-module business flows were not rerun for this A revision. Prior evidence directories describe earlier revisions, not fresh executions here.

Logs contain test output only; workspace prefixes and trailing whitespace are sanitized. `matrix-results.json` records exact commands, durations, binary hashes and stress counters; `source-sha256.json` identifies tested sources.

## Reproduction

```sh
node scripts/run-node-tests.js \
  cli/lib/__tests__/am-sock-client.test.js \
  cli/lib/__tests__/am-sock-contract-controls.test.js \
  cli/lib/__tests__/am-sock-field-matrix.test.js \
  cli/lib/__tests__/event-log.test.js \
  cli/lib/runtime/__tests__/kick-prompt.test.js \
  cli/lib/runtime/__tests__/legacy-stop-matrix.test.js \
  cli/lib/runtime/__tests__/session-adapter.test.js \
  cli/lib/runtime/__tests__/session-guard-contract.test.js \
  cli/lib/runtime/__tests__/session-launch-literal.test.js \
  cli/lib/runtime/__tests__/session-launch-settlement.test.js \
  cli/lib/runtime/__tests__/session-paste-cleanup.test.js \
  cli/lib/runtime/__tests__/session-send-guard-race.test.js \
  cli/lib/runtime/__tests__/session-startup-producer.test.js \
  cli/lib/runtime/__tests__/session-stop-boundary.test.js \
  cli/lib/runtime/__tests__/session-stop-live.test.js \
  cli/lib/runtime/__tests__/session-stop-target-races.test.js \
  cli/lib/runtime/__tests__/session-target.test.js \
  cli/lib/runtime/__tests__/tmux-connection-timeout.test.js \
  cli/lib/runtime/__tests__/tmux-guard-errors.test.js \
  cli/lib/runtime/__tests__/tmux-helpers.test.js \
  skills/activity-monitor/scripts/__tests__/claude-pid.test.js \
  skills/activity-monitor/scripts/__tests__/emit-custom-inject.test.js \
  skills/activity-monitor/scripts/__tests__/guardian.test.js \
  skills/activity-monitor/scripts/__tests__/health-engine.test.js \
  skills/activity-monitor/scripts/__tests__/health-evidence.test.js \
  skills/activity-monitor/scripts/__tests__/health-file-layout.test.js \
  skills/activity-monitor/scripts/__tests__/health-hook-group-log.test.js \
  skills/activity-monitor/scripts/__tests__/health-migration-crash.test.js \
  skills/activity-monitor/scripts/__tests__/health-notice-classification.test.js \
  skills/activity-monitor/scripts/__tests__/health-notice-match.test.js \
  skills/activity-monitor/scripts/__tests__/health-notice-pipeline.test.js \
  skills/activity-monitor/scripts/__tests__/health-quota.test.js \
  skills/activity-monitor/scripts/__tests__/hook-activity.test.js \
  skills/activity-monitor/scripts/__tests__/hook-auth-prompt.test.js \
  skills/activity-monitor/scripts/__tests__/hook-health.test.js \
  skills/activity-monitor/scripts/__tests__/memory-sync-gate.test.js \
  skills/activity-monitor/scripts/__tests__/memory-sync-integration.test.js \
  skills/activity-monitor/scripts/__tests__/message-router.test.js \
  skills/activity-monitor/scripts/__tests__/router-socket-process.test.js \
  skills/activity-monitor/scripts/__tests__/router-socket.test.js \
  skills/activity-monitor/scripts/__tests__/runtime-health.test.js \
  skills/activity-monitor/scripts/__tests__/session-foreground.test.js \
  skills/activity-monitor/scripts/__tests__/session-start-orchestrator.test.js \
  skills/activity-monitor/scripts/__tests__/shard-mode.test.js \
  skills/activity-monitor/scripts/__tests__/shard-sequencer.test.js \
  skills/activity-monitor/scripts/__tests__/start-attempt-read-error.test.js \
  skills/activity-monitor/scripts/__tests__/status-writer.test.js \
  skills/activity-monitor/scripts/__tests__/supervisor-admission.test.js \
  skills/activity-monitor/scripts/__tests__/supervisor-health-observer.test.js \
  skills/activity-monitor/scripts/__tests__/supervisor-loop.test.js \
  skills/activity-monitor/scripts/__tests__/supervisor-scenes.test.js \
  skills/activity-monitor/scripts/__tests__/supervisor-server-health.test.js \
  skills/activity-monitor/scripts/__tests__/supervisor-server-observation.test.js \
  skills/activity-monitor/scripts/__tests__/supervisor-socket.test.js \
  skills/activity-monitor/scripts/__tests__/supervisor-tmux-stress.test.js \
  skills/activity-monitor/scripts/__tests__/task-scheduler.test.js \
  skills/activity-monitor/scripts/__tests__/tmux-input-state.test.js \
  skills/activity-monitor/scripts/__tests__/tool-event-stream.test.js \
  skills/activity-monitor/scripts/__tests__/tool-lifecycle.test.js \
  skills/activity-monitor/scripts/__tests__/tool-rules.test.js \
  skills/activity-monitor/scripts/__tests__/tool-watchdog.test.js \
  skills/activity-monitor/scripts/__tests__/usage-check-engine.test.js \
  skills/activity-monitor/scripts/__tests__/usage-check-init.test.js \
  skills/activity-monitor/scripts/__tests__/usage-codex-rollout-reader.test.js \
  skills/activity-monitor/scripts/__tests__/usage-monitor-file-reader.test.js \
  skills/activity-monitor/scripts/__tests__/usage-monitor-optional-sqlite.test.js \
  skills/activity-monitor/scripts/__tests__/usage-monitor.test.js \
  skills/comm-bridge/scripts/__tests__/first-failure-notice.test.js
```

Focused command: `node scripts/run-node-tests.js skills/activity-monitor/scripts/__tests__/supervisor-scenes.test.js skills/activity-monitor/scripts/__tests__/supervisor-admission.test.js skills/activity-monitor/scripts/__tests__/supervisor-server-observation.test.js`.

For each supported tmux binary, prepend its directory to PATH and set TEST_TMUX_BIN, then run the commands in matrix-results.json. Stress additionally sets P05_TMUX_STRESS=1 P05_LAUNCH_ROUNDS=300 P05_DELIVERY_ROUNDS=150. Run the known-bad control in a disposable copy with the tmux guard expression replaced by literal `1`; its assertion failure is required.
