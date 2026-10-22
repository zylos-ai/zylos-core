# Standalone native busy-timeout probe

No helper, guard, owner, or business imports. Only built-in Node modules and an explicitly selected existing better-sqlite3 package. No install is required. Uses isolated `mkdtemp` databases; keeps them for audit. Holder sends IPC ready only after successful EXCLUSIVE/NORMAL locking-mode selection and `BEGIN IMMEDIATE; UPDATE ... value=2`. Committed baseline is1. Holder rolls back before close. Parent awaits holder exit; no daemon remains.

Run from this directory with a Node executable matching the native driver ABI:

```sh
export PROBE_DRIVER=/absolute/path/to/better-sqlite3
/path/to/node probe.mjs smoke
/path/to/node probe.mjs > baselines.jsonl 2>&1
/path/to/node probe.mjs qualification > default-60s.jsonl 2>&1
cc -dynamiclib -fPIC -I "$PROBE_DRIVER/deps/sqlite3" sleeptrace.c -o sleeptrace.dylib
PROBE_TRACE="$PWD/sleeptrace.dylib" /path/to/node probe.mjs qualification > trace-60s.jsonl 2>&1
```

The compile command is for macOS; use shared-library flags for another platform. Trace is an optional, separate diagnostic run: it wraps the default VFS xSleep, calling the original unchanged and logging requested and actual sleep; it does not replace the busy handler or alter the timeout. Extension is process-local. Do not load it into a production process. CLOCK_MONOTONIC in C and process.hrtime in Node may have different origins on macOS: compare elapsed durations, not their absolute timestamp values. JS parent/child timestamps share process.hrtime's clock domain.

## Observed results

Native runtime: Node v25.9.0, better-sqlite3 12.6.2, actual SELECT sqlite_version() =3.51.2; raw compile options in logs. Local executable `/opt/homebrew/bin/node`. All connections readonly on reader side, timeout set and read back as5000.

- No lock: prepare0.156ms, get0.007ms, committed1.
- Ordinary WAL writer holds uncommitted2 for8003.693ms: reader prepare0.094ms/get0.005ms returns committed1.
- EXCLUSIVE8s, reader opened before holder: holder8003.763ms; prepare8167.726ms succeeds, get1.
- EXCLUSIVE8s, reader opened after lock-ready: holder8004.532ms; prepare8198.869ms succeeds, get1.
- EXCLUSIVE60s, default uninstrumented: single prepare10711.182ms ends SQLITE_BUSY. Open, setting/reading timeout, and close are individually logged and not the source of the delay.
- Separate EXCLUSIVE60s traced: single prepare11200.718ms ends SQLITE_BUSY. Exactly59 VFS sleep calls request5000ms total but actually sleep11194.676ms total. The difference to total prepare is about6.04ms. The requested sequence matches one default busy callback progression:1,2,5,10,15,20,25,25,25,50,50,100 repeated, final72ms. No second5000ms cycle is needed to explain the result.

SQLite bundled source `sqlite3.c:186615` computes busy timeout from requested sleep totals, not elapsed monotonic time. `sqlite3.c:46349` uses nanosleep and returns the requested duration. Source excerpts are retained in the private evidence archive. In this observed run, VFS sleep overshoot accounts for essentially the entire~11.2s wait. Why OS sleep overshot (scheduler/QoS/timer coalescing/etc.) has NOT been established. This is evidence at the native wait boundary, not a general host diagnosis or a changed timeout contract.

The8s fixture is materially different from the60s qualification: it releases before the stretched busy schedule ends, so prepare succeeds after~8.2s despite timeout5000. Both fixtures are recorded, not substituted for each other. Preopened here means constructor before lock, without warming the schema or opening a read transaction.

Original full measurements used probe.cjs (preserved in the private evidence archive); portable probe.mjs is an ESM conversion with mandatory PROBE_DRIVER and smoke mode. ESM no-lock smoke rerun is in esm-smoke.jsonl. The final scripts also fail immediately if holder setup or other unexpected steps fail, preventing false lock-ready reports; expected reader prepare errors are logged and retained.

Published JSONL logs preserve measurements; the local checkout prefix is replaced with `<checkout>`. The portable ESM script also rejects holder exit before lock-ready. No product timeout or error protocol is changed.

The final ESM no-lock/WAL/preopened/postlock matrix was rerun: see `esm-baselines.jsonl`. Run `node matrix.mjs` from this directory for the real public API matrix (requires this checkout and its existing comm-bridge dependencies); historical results are in `matrix.jsonl`. This API runner uses Date.now() for deadline construction, not an injected wall clock, and tests no synthetic wall-clock jumps. Structural results are in `structural.log`.
