# C complexity review correction

C1 removes eleven unreachable modules. `reachability.json` records their incoming production import edges at da126d7: every edge originates inside the deletion set. The scan includes all tracked production JS and non-test/non-document configuration/text references; no entry invocation was found in CLI, hooks, PM2 or skills. Seven dedicated test files are removed. Mixed health/notice acceptance is retained and migrated from the deleted ToolPipeline to HealthEventReader (including atomic-write retry, rotation, replay and post-recovery regressions). m1-restart-confirmation.js remains for its P10 consumer.

C2 computes due maintenance/account work before reading Origin state. Quiet ticks and already-pending jobs skip that read; due tasks retain health and idle gates. Legacy projection uses P02 readTargetRuntime and its exact PID result instead of its own ancestry walk. Its shared isolated tmux tests cover legacy identity and foreign PID rejection.

C3 retains temporary missing-dependency tolerance, with a shared per-service missing-dependency set. P04 configuration, P07 Sync and deferred owner failures log once per dependency; unrelated failures remain visible. Static imports remain an integration-stage change.

C4 keeps monitor.js as the only executable entry guard, and handles stop rejection with a logged error and exit 1. C5 retains only publishSessionStatus/publicHealth in status-writer; live notice classification checks the durable notice directly. C6 injects upgrade-check main dependencies; actual C4 producer acceptance no longer rewrites source. prompt_source parsing/emission and its dedicated test are removed.

Focused validation before parent integration: official `node scripts/run-node-tests.js`, 9 files / 62 pass / 0 fail / 0 skip. Selection: supervisor-machine-tasks, supervisor-legacy-status, control-producers-acceptance, hook-activity, health-notice-pipeline, health-notice-classification, status-writer, supervisor-entry, supervisor-assembly (all under skills/activity-monitor/scripts/__tests__). Logs are adjacent. Initial migration fixture failures are retained only in local raw evidence; the final run is green.

Full composition, full Node/Jest, five-version tmux matrix, and afterRound measurements are reported by the final integration evidence, not claimed by this focused run. Legacy runtime observation changed, so matrix validation is required before merge. No release or deployment is included.

## Final composed selection

At source head 24ff6d80060a090d296f33d13c2d25fb6a271b94 (product source ae9a0bb), the official isolated runner passed **99 files / 809 tests**, with **1 opt-in skip / 0 failures**. The selection is the previous 106-file selection minus seven dedicated removed-module suites. `source-hashes.json` covers 325 product/test files and was checked unchanged after the run. Reproduce by passing `selection.json` paths to `node scripts/run-node-tests.js`; no runner changes or timeout relaxation were made.

Parent integration retains B's transition-before-serialization and exits/publication-before-reclaim order. C also captures a newly accepted automatic migration before reclaim refreshes its context, so completion cannot enable new producers in that same round. The existing legacy migration regression now clears the context during reclaim and checks rotation/Sync suppression; the focused loop run passes 12/12. Composed integration focus passed 38/38. The C-only manual-entry persisted-session assertion was corrected to match A's admission-only sessionId contract; its four real integration cases pass.

Attempt history is retained: initial composition had two stale expectedSessionId fixture assertions; after correcting them, a concurrent 99-file run hit two tmux timeouts in unchanged IF-13 tests while full-repository validation was also running. An attempted NODE_OPTIONS concurrency setting was rejected before tests ran and is not used. After the full suite finished, the unchanged normal official selection passed 809/1. Logs identify each attempt; none is omitted or represented as green.
