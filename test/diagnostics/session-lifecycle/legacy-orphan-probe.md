# Legacy process ownership lost before stop

Run on Linux x86_64 with a kernel supporting pidfds:

```sh
TMUX_BIN=/absolute/path/to/tmux python3 test/diagnostics/session-lifecycle/legacy-orphan-probe.py
```

This isolated diagnostic starts a private tmux socket, temporary HOME, and controlled Python stand-ins. The pane process double-forks a child into a different POSIX session. Its intermediate parent exits before the simulated stop entry. Neither runtime process has a run identifier. At entry the historical descendant is already reparented outside the pane process tree. A complete readable `/proc` ancestry snapshot cannot rediscover it from the pane root. The harness retains an out-of-band record solely to observe and clean up its own test processes; that record is not available to a real legacy stop caller.

The probe kills the private tmux session and terminates the known root through a verified pidfd. It then checks that the root is gone while the historical descendant remains alive. Cleanup uses pidfds too; it never sends a signal to a bare numeric PID. Processes also carry a 20-second watchdog. Temporary evidence directories are retained. Python 3.8 on the test host lacks pidfd wrappers, so the harness uses Linux x86_64 syscall numbers and refuses other platforms.

On tmux 3.4 this reproduces a concrete limitation of adopting existing legacy processes: scanning or freezing the currently discoverable tree cannot recover descendants that escaped before observation. Repeating the scan, killing a process group, or replacing PID checks with pidfds does not fix this historical ownership gap. Pidfds address identity-safe signalling of processes already identified, not completeness of discovery.

A successful stop of such a legacy session requires trustworthy ownership information established before that information was lost, or an independently established containment boundary that covers those existing processes. Merely introducing a boundary at stop entry cannot prove it includes historical orphans. When that evidence is unavailable, retain the existing unconfirmed result for a session present at entry. Do not reinterpret it as the absent-at-entry exception or claim this diagnostic establishes a universal impossibility result.

This is mechanism evidence, not product acceptance. It does not exercise real Claude/Codex, macOS, runtime-specific child semantics, or a complete production containment implementation. The adapter's present/null guard is intentionally unchanged.
