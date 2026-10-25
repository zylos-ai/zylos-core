# C complexity review correction

C1 removes eleven unreachable modules. `reachability.json` records their incoming production import edges at da126d7: every edge originates inside the deletion set. The scan includes all tracked production JS and non-test/non-document configuration/text references; no entry invocation was found in CLI, hooks, PM2 or skills. Seven dedicated test files are removed. Mixed health/notice acceptance is retained and migrated from the deleted ToolPipeline to HealthEventReader (including atomic-write retry, rotation, replay and post-recovery regressions). m1-restart-confirmation.js remains for its P10 consumer.

C2 computes due maintenance/account work before reading Origin state. Quiet ticks and already-pending jobs skip that read; due tasks retain health and idle gates. Legacy projection uses P02 readTargetRuntime and its exact PID result instead of its own ancestry walk. Its shared isolated tmux tests cover legacy identity and foreign PID rejection.

C3 retains temporary missing-dependency tolerance, with a shared per-service missing-dependency set. P04 configuration, P07 Sync and deferred owner failures log once per dependency; unrelated failures remain visible. Static imports remain an integration-stage change.

C4 keeps monitor.js as the only executable entry guard, and handles stop rejection with a logged error and exit 1. C5 retains only publishSessionStatus/publicHealth in status-writer; live notice classification checks the durable notice directly. C6 injects upgrade-check main dependencies; actual C4 producer acceptance no longer rewrites source. prompt_source parsing/emission and its dedicated test are removed.

Focused validation before parent integration: official `node scripts/run-node-tests.js`, 9 files / 62 pass / 0 fail / 0 skip. Selection: supervisor-machine-tasks, supervisor-legacy-status, control-producers-acceptance, hook-activity, health-notice-pipeline, health-notice-classification, status-writer, supervisor-entry, supervisor-assembly (all under skills/activity-monitor/scripts/__tests__). Logs are adjacent. Initial migration fixture failures are retained only in local raw evidence; the final run is green.

Full composition, full Node/Jest, five-version tmux matrix, and afterRound measurements are reported by the final integration evidence, not claimed by this focused run. Legacy runtime observation changed, so matrix validation is required before merge. No release or deployment is included.
