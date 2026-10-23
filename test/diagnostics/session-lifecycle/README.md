# Session lifecycle diagnostics

These opt-in Linux probes investigate tmux creation. They do not invoke model CLIs, use a default tmux socket, or validate the product adapter. They retain temporary evidence and stop only their own processes.

- `python3 reproduce.py`: creation versus exec, submission timeout, and external-gate cancellation observations; see [launch notes](launch-probe.md).
- `python3 dequeued-fork.py`: optional debugger probe of client disconnect after creation has started; requires GDB and a tmux binary with the symbols used by the probe.
- Darwin launch/isRunning image observation: see [process observation notes](process-observation-probes.md).

The standalone stop-probe and legacy-orphan-probe scripts are historical only,
excluded from current stop acceptance. See [historical stop notes](stop-probe.md)
and [historical legacy notes](legacy-orphan-probe.md). Their old process-cleanup
policy no longer applies; current stop only closes the verified target tmux.

Run these manually in a suitable test environment. They are diagnostics, not release acceptance tests. Platform/version limitations and remaining observation or cancellation gaps are documented in the linked notes.
