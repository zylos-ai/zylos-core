# Actual entry afterRound quiet-round measurement

Baseline: `da126d7c22afffda0cc397f1ca2c47e43bbebcab`. Final: `ae9a0bbc6332ef374d618e2dae1dd7d6e845ac27`. Both are immutable git archive copies with the identical probe file added. Product/test source hashes are in source-hashes.json.

The probe starts the actual `startSupervisor`, runs `SupervisorLoop.tick()` (not runRound), and checks each sample completed the real legacy and machine task tick plus the afterRound callback exactly once. It uses the shared ready-tmux fixture with real runtime-named sleeping processes, real process-tree sampling and an isolated tmux 3.4 server. A counted binary wrapper records actual tmux invocations. Five measured rounds after warmup advance the injected clock by 61 seconds each.

| Groups | Baseline / final calls per round | Baseline / final median ms |
|---|---:|---:|
| 1 | 23 / 23 | 102.008 / 98.289 |
| 4 | 89 / 89 | 405.429 / 405.567 |

Every sample has 1 aggregate scene snapshot, 1/4 process-tree samples and 2/8 lightweight identity checks. Machine origin-state lookups decrease from one to zero when nothing is due. The baseline main already reads this state from its shared round context, so this does not remove a tmux observation in this path. The near-equal timings are not evidence of a speedup. Final four-group quiet rounds are below 1 second in this fixture; this does not reproduce or invalidate the reviewer's different 1.2-second fixture.

Scope: injected resolved configuration (P04 not present) and empty database; health event inbox consumption overridden empty; no legacy foreground marker, so the real legacy tick runs its early-return path; machine health/usage/daily-upgrade tasks disabled and clock fixed at local noon, so no external jobs or outgoing controls run. Actual maintenance logic executes, but this is not a due-task, legacy-session or production whole-daemon timing claim. Files/socket/processes are isolated; no production instance is used. Shell wrapper overhead and host load affect timings.

Reproduce: export the two pinned commits into baseline/ and final/, place entry-round-probe.test.js in each skills/activity-monitor/scripts/__tests__ directory, provision existing test dependency links, then `TEST_TMUX_BIN=/path/to/tmux-3.4 python3 run-pair.py`. This invokes only `node scripts/run-node-tests.js`. The final pair ran after B stress drained and before C full/selected/matrix validation started. An earlier pair under concurrent B stress is retained in concurrent-initial and is not the reported comparison. Initial configuration-fixture error and first baseline success are also retained.
