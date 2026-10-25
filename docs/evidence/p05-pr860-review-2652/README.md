# Transition failure continuation

Final-review P3-3 / T01: advanceTransition failures are reported with phase transition, then the same round continues observations, exit handling, status publication and existing reclamation. The immutable transition-round restriction still suppresses ordinary producers. A two-round regression verifies all required stages and rescheduling; replacing only supervisor-loop.js with the pre-fix338e840 source in an external disposable copy fails this new regression.

Official isolated runner: loop12pass; independent80files806pass1opt-in skip0fail. Commands: `node scripts/run-node-tests.js skills/activity-monitor/scripts/__tests__/supervisor-loop.test.js`; the broader selection is in b-selection.json. Logs and changed-source hashes are adjacent.

No tmux command/format/parser or observation/stop implementation changed; the previous five-version matrix is historical and was not rerun for this exception-continuation correction. FullNode/Jest/nativeMac/business-chain and performance measurements were not rerun. No merge to batch/Base/main or deployment.
