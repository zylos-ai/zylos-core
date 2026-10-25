# PR859 contract simplification validation

Revision based on `054806e2bdbcc53eb049ccaa804e157472264b56`; branch target base `4a1fedac5e615350d7b7f5ac949fab1934953fff`.

This directory is part of the same commit as the tested code. `source-sha256.json` identifies the tested cli/lib and activity-monitor sources. The five-version run verified those hashes remained unchanged. Test commands use the official isolated HOME/ZYLOS_DIR runner. Logs are retained below; machine-specific workspace prefixes and trailing whitespace are sanitized. The earlier p05-pr859-revision directory is historical evidence for the prior commit.

## Results

- Independent suite: 68 files, 712 tests, 711 pass, 1 opt-in skip, 0 fail.
- Focused server tests: 22 pass; event-log/consumer tests: 10 pass.
- External missing-final-drain mutant fails the deterministic late-append and malformed-tail handoff regressions; production source is unchanged.
- tmux 3.2a / 3.3a / 3.4 / 3.7c / 3.8: runtime and applicable Supervisor suites, real launch/delivery churn, external constant-true guard mutant. See matrix-results.json for exact commands, counters and outcomes, and per-version logs.
- Whole-repository/Jest/native macOS and cross-module business flows were not rerun.

## Changes covered

- Server unavailability no longer triggers process termination or OS identity checks. Unknown scenes retain occupancy indefinitely; explicit no-server observations retain normal absence behavior.
- The observer decorator issues no additional tmux/process probes; it keeps only occupancy fields for fallback.
- Alerts begin at 60 seconds and repeat at most every ten minutes, with Web Console fallback; successful observation resets the episode.
- Event logs use one appendFileSync call for a complete JSON line, with O_APPEND. Rotation uses rename; F1 config locking is unchanged.
- Reader drains the old descriptor once more before switching inodes; deterministic late append coverage verifies ordering and exactly-once consumption.
- Incomplete active lines wait; incomplete final tails and malformed complete lines are skipped with warnings.
- Two real writers each append 200 lines during rotation; every payload, writer/sequence pair and record count is checked. Lock-specific tests and the Perl helper are removed.

The implementation follows the approved contract change. No automatic termination or file-lock detection gap remains in this removed implementation. B/C were not updated in this A-only follow-up and must adapt their integration when they take these changes.

## Independent reproduction

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

For the matrix, prepend each supported binary directory to PATH and set TEST_TMUX_BIN; execute the commands in matrix-results.json. Stress uses P05_TMUX_STRESS=1 P05_LAUNCH_ROUNDS=300 P05_DELIVERY_ROUNDS=150. The known-bad stage runs in a separate disposable copy with the tmux guard condition replaced by literal `1`; its assertion failure is required.
