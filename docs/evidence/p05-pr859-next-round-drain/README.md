# PR859 review corrections: delayed rotation drain and acceptance gaps

This revision builds on the 30-minute interval correction at A5dd32b23ad5451736cf087da41b92c034b21c22b. First alert remains 60 seconds; interval boundary evidence is in ../p05-alert-interval-30m. The older contract-simplification README now states the current interval and identifies its logs as historical.

## Changes and evidence mapping

- P2-2 / DM-38: a rotation handoff keeps the old descriptor and unread offset. The next read drains deferred old files first with final-tail handling, then closes them. Multiple discovered intermediate rotations retain separate cursors. close() closes current and deferred descriptors. A writer completing a full line after round N returns is read exactly once in N+1; a partial line completed before N+1 produces no premature warning; abandoned tails warn only at final drain.
- P3-1 / DM-38: two actual writer processes append 200 lines each, with 100 KiB payloads, while rename rotation runs. Counts, writer/sequence identity and exact payloads are checked.
- P3-2: actual appendEvent write failure, unobservable cause:error, no server termination throughout an outage, and success on one socket while another remains unavailable.

No production tmux command, format, parsing, observation or stop code changed in this revision. The prior five-version matrix remains historical for its recorded source revision; it is not claimed rerun here. Tests use official isolated HOME/ZYLOS_DIR entry points and shared tmux fixtures. Full repository/Jest, native macOS and downstream business integration were not rerun. The Linux actual ENOSPC device test has an explicit non-Linux skip.

## Results

- A independent: 68 files, 717 tests, 716 passed, 1 opt-in skip, 0 failed.
- Focused event-log suite: 13 passed, 0 failed or skipped; actual ENOSPC exercised.
- Focused server health/observation: 16 passed, 0 failed.
- External old same-round drain implementation fails the new next-round full/partial write regressions.
- External split-write variant detected in all 10 runs by the 100 KiB two-writer test with a common IPC start barrier. Mutations exist only in disposable copies; source/test hashes stayed unchanged.

Reproduce using the file selection in a-selection.json with node scripts/run-node-tests.js. For external controls run `python3 run-event-log-mutants.py /path/to/checkout /path/to/disposable-evidence`; the old-source variant is pinned to the pre-fix commit. Tests never rewrite product source. Exact logs are retained alongside this file.

